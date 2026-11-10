//! Independent audio sections prevent a bad decode from poisoning a whole meeting.
use crate::qmd::cmd;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

mod cache;
pub mod models;
#[cfg(all(test, unix))]
mod process_tests;
use cache::Session;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptionLanguage {
    #[default]
    Auto,
    No,
    En,
}

impl TranscriptionLanguage {
    pub fn as_arg(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::No => "no",
            Self::En => "en",
        }
    }
}

const RATE: u32 = 16_000;
const SECTION_MS: u64 = 60_000;
const OVERLAP_MS: u64 = 2_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Section {
    start_ms: u64,
    end_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Segment {
    start_ms: u64,
    end_ms: u64,
    text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Problem {
    section: Section,
    reason: String,
}

struct Audio {
    samples: Vec<i16>,
    duration_ms: u64,
    // WebRTC classifies 20 ms frames. VAD verifies coverage; no audio is
    // discarded, so quiet speakers still reach the recognizer.
    voice: Vec<bool>,
}

impl Audio {
    fn read(path: &Path) -> Result<Self, String> {
        let mut reader = hound::WavReader::open(path).map_err(|e| format!("Read audio: {e}"))?;
        let spec = reader.spec();
        if spec.sample_rate != RATE
            || spec.channels != 1
            || spec.bits_per_sample != 16
            || spec.sample_format != hound::SampleFormat::Int
        {
            return Err("Transcription requires 16 kHz mono 16-bit PCM WAV audio".into());
        }
        let samples = reader
            .samples::<i16>()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Read audio samples: {e}"))?;
        if samples.is_empty() {
            return Err("Audio is empty".into());
        }
        let duration_ms = (samples.len() as u64 * 1000).div_ceil(RATE as u64);
        let voice = voice_frames(&samples)?;
        Ok(Self {
            samples,
            duration_ms,
            voice,
        })
    }

    fn samples_in(&self, start: u64, end: u64) -> &[i16] {
        let from = (start * RATE as u64 / 1000).min(self.samples.len() as u64) as usize;
        let to = (end * RATE as u64 / 1000).min(self.samples.len() as u64) as usize;
        &self.samples[from..to]
    }

    fn write_slice(&self, path: &Path, start: u64, end: u64) -> Result<(), String> {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).map_err(|e| e.to_string())?;
        for &sample in self.samples_in(start, end) {
            writer.write_sample(sample).map_err(|e| e.to_string())?;
        }
        writer.finalize().map_err(|e| e.to_string())
    }

    fn sections(&self, max_ms: u64) -> Vec<Section> {
        let mut sections = Vec::new();
        let mut start = 0;
        while start < self.duration_ms {
            let target = (start + max_ms).min(self.duration_ms);
            let mut end = target;
            // Prefer a quiet 200 ms window in the last ten seconds. This only
            // chooses boundaries; it never discards low-volume audio.
            if target < self.duration_ms {
                for at in
                    (target.saturating_sub(10_000).max(start + max_ms / 2)..target).step_by(200)
                {
                    let samples = self.samples_in(at, at + 200);
                    let mean_square = samples.iter().map(|&v| (v as f64).powi(2)).sum::<f64>()
                        / samples.len().max(1) as f64;
                    if mean_square < 80.0_f64.powi(2) {
                        end = at + 100;
                    }
                }
            }
            sections.push(Section {
                start_ms: start,
                end_ms: end,
            });
            start = end;
        }
        sections
    }
}

struct SliceFile(PathBuf);
impl Drop for SliceFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub async fn transcribe(
    wav: &Path,
    model: &Path,
    language: TranscriptionLanguage,
    progress: impl Fn(&str) + Send + Sync,
) -> Result<String, String> {
    transcribe_using(wav, model, language, Path::new("whisper-cli"), progress).await
}

async fn transcribe_using(
    wav: &Path,
    model: &Path,
    language: TranscriptionLanguage,
    engine: &Path,
    progress: impl Fn(&str) + Send + Sync,
) -> Result<String, String> {
    let audio = Audio::read(wav)?;
    let sections = audio.sections(SECTION_MS);
    progress("Checking saved transcription progress...");
    let mut session = Session::open(wav, model, language, engine, &sections).await?;
    eprintln!("transcription: diagnostics: {}", session.dir.display());
    let mut merged = Vec::new();
    let mut problems = Vec::new();
    for (i, section) in sections.iter().enumerate() {
        progress(&format!(
            "Transcribing section {} of {}...",
            i + 1,
            sections.len()
        ));
        let (segments, failed) = recover_section(
            &audio,
            section,
            model,
            language,
            engine,
            &mut session,
            &progress,
        )
        .await?;
        problems.extend(failed);
        merge_section(&mut merged, segments, section);
        let mut pending = problems.clone();
        pending.extend(sections[i + 1..].iter().map(|s| Problem {
            section: s.clone(),
            reason: "Pending transcription".into(),
        }));
        pending.push(Problem {
            section: Section {
                start_ms: 0,
                end_ms: audio.duration_ms,
            },
            reason: "Final coverage validation pending".into(),
        });
        session.finish(&merged, &pending)?;
    }
    // Verify the merged result as well: ownership/overlap handling must not
    // introduce a hole that was absent in the individual outputs.
    let whole = Section {
        start_ms: 0,
        end_ms: audio.duration_ms,
    };
    for section in uncovered_speech(&audio.voice, &merged, &whole) {
        problems.push(Problem {
            section,
            reason: "Detected speech has no corresponding transcript".into(),
        });
    }
    session.finish(&merged, &problems)?;
    if problems.is_empty() {
        Ok(render(&merged))
    } else {
        Err(format!(
            "Transcription incomplete. Partial output and diagnostics: {}. Missing ranges: {}",
            session.dir.display(),
            problems
                .iter()
                .map(|p| format!(
                    "{}–{} ({})",
                    timestamp(p.section.start_ms),
                    timestamp(p.section.end_ms),
                    p.reason
                ))
                .collect::<Vec<_>>()
                .join("; ")
        ))
    }
}

// At most one full-section attempt and one attempt per 30-second part. A bad
// section cannot monopolize a meeting, and later sections are still processed.
async fn recover_section(
    audio: &Audio,
    section: &Section,
    model: &Path,
    language: TranscriptionLanguage,
    engine: &Path,
    session: &mut Session,
    progress: &(impl Fn(&str) + Send + Sync),
) -> Result<(Vec<Segment>, Vec<Problem>), String> {
    if let Some(saved) = cached_section(session, audio, section) {
        progress(&format!(
            "Reusing saved section {}–{}...",
            timestamp(section.start_ms),
            timestamp(section.end_ms)
        ));
        return Ok((saved, Vec::new()));
    }
    if !session.has_retry_parts(section) {
        let result = run_section(audio, section, model, language, engine, &session.attempts)
            .await
            .and_then(|segments| {
                validate_section(&segments)?;
                validate_coverage(audio, &segments, section)?;
                Ok(segments)
            });
        match result {
            Ok(segments) => {
                session.store(section, &segments)?;
                return Ok((segments, Vec::new()));
            }
            Err(reason) => eprintln!(
                "transcription: retry {}–{}: {reason}",
                timestamp(section.start_ms),
                timestamp(section.end_ms)
            ),
        }
    }
    progress(&format!(
        "Retrying {}–{} in smaller sections...",
        timestamp(section.start_ms),
        timestamp(section.end_ms)
    ));
    let mut merged = Vec::new();
    let mut problems = Vec::new();
    for part in retry_parts(section) {
        let result = if let Some(saved) = cached_section(session, audio, &part) {
            Ok(saved)
        } else {
            run_section(audio, &part, model, language, engine, &session.attempts)
                .await
                .and_then(|segments| {
                    validate_section(&segments)?;
                    validate_coverage(audio, &segments, &part)?;
                    Ok(segments)
                })
        };
        match result {
            Ok(segments) => {
                session.store(&part, &segments)?;
                merge_section(&mut merged, segments, &part);
            }
            Err(reason) => problems.push(Problem {
                section: part,
                reason,
            }),
        }
    }
    if problems.is_empty() {
        session.store(section, &merged)?;
    }
    Ok((merged, problems))
}

fn cached_section(session: &Session, audio: &Audio, section: &Section) -> Option<Vec<Segment>> {
    let segments = session.get(section)?;
    validate_section(&segments).ok()?;
    validate_coverage(audio, &segments, section).ok()?;
    if segments.iter().any(|s| {
        s.end_ms <= s.start_ms
            || s.end_ms > audio.duration_ms
            || s.start_ms < section.start_ms.saturating_sub(OVERLAP_MS)
            || s.end_ms > section.end_ms.saturating_add(OVERLAP_MS)
    }) {
        return None;
    }
    Some(segments)
}

fn voice_frames(samples: &[i16]) -> Result<Vec<bool>, String> {
    use webrtc_vad::{SampleRate, Vad, VadMode};
    let mut vad = Vad::new_with_rate_and_mode(SampleRate::Rate16kHz, VadMode::Quality);
    samples
        .chunks(320)
        .map(|chunk| {
            let mut frame = [0i16; 320];
            frame[..chunk.len()].copy_from_slice(chunk);
            vad.is_voice_segment(&frame)
                .map_err(|_| "Voice activity detection failed".into())
        })
        .collect()
}

fn validate_coverage(audio: &Audio, segments: &[Segment], section: &Section) -> Result<(), String> {
    let gaps = uncovered_speech(&audio.voice, segments, section);
    if gaps.is_empty() {
        return Ok(());
    }
    Err(format!(
        "Detected speech without text at {}",
        gaps.iter()
            .map(|s| format!("{}–{}", timestamp(s.start_ms), timestamp(s.end_ms)))
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

fn uncovered_speech(voice: &[bool], segments: &[Segment], section: &Section) -> Vec<Section> {
    let mut intervals = segments
        .iter()
        .filter(|s| is_speech_text(&s.text))
        .map(|s| (s.start_ms.saturating_sub(750), s.end_ms.saturating_add(750)))
        .collect::<Vec<_>>();
    intervals.sort_unstable();
    let mut coverage: Vec<(u64, u64)> = Vec::new();
    for (start, end) in intervals {
        if let Some(last) = coverage.last_mut().filter(|last| last.1 >= start) {
            last.1 = last.1.max(end);
        } else {
            coverage.push((start, end));
        }
    }
    let mut interval = 0;
    let mut gaps = Vec::new();
    let mut first = 0;
    let mut last = 0;
    let mut active_ms = 0;
    for (i, &is_voice) in voice.iter().enumerate() {
        let at = i as u64 * 20;
        if at < section.start_ms || at >= section.end_ms {
            continue;
        }
        while interval < coverage.len() && coverage[interval].1 <= at {
            interval += 1;
        }
        let covered = coverage
            .get(interval)
            .is_some_and(|&(start, end)| start <= at && at < end);
        if is_voice && !covered {
            if active_ms > 0 && at > last + 1000 {
                if active_ms >= 2000 {
                    gaps.push(Section {
                        start_ms: first,
                        end_ms: last + 20,
                    });
                }
                active_ms = 0;
            }
            if active_ms == 0 {
                first = at;
            }
            last = at;
            active_ms += 20;
        } else if covered && active_ms > 0 {
            if active_ms >= 2000 {
                gaps.push(Section {
                    start_ms: first,
                    end_ms: last + 20,
                });
            }
            active_ms = 0;
        }
    }
    if active_ms >= 2000 {
        gaps.push(Section {
            start_ms: first,
            end_ms: last + 20,
        });
    }
    gaps
}

fn is_speech_text(text: &str) -> bool {
    let key = words(text).join(" ");
    text.chars().any(char::is_alphabetic)
        && !matches!(
            key.as_str(),
            "blank_audio" | "silence" | "music" | "musikk" | "applause" | "laughter" | "inaudible"
        )
}

fn retry_parts(section: &Section) -> Vec<Section> {
    (section.start_ms..section.end_ms)
        .step_by(30_000)
        .map(|start_ms| Section {
            start_ms,
            end_ms: (start_ms + 30_000).min(section.end_ms),
        })
        .collect()
}

fn validate_section(segments: &[Segment]) -> Result<(), String> {
    // Check raw segments, before overlap removal could hide a decoder loop.
    let keys = segments.iter().map(|s| words(&s.text)).collect::<Vec<_>>();
    if keys
        .windows(10)
        .any(|window| !window[0].is_empty() && window.iter().all(|key| key == &window[0]))
    {
        return Err("A short phrase repeats excessively".into());
    }
    for period in 1..=4 {
        let count = if period == 1 { 4 } else { 3 };
        let size = period * count;
        for window in keys.windows(size) {
            if window[..period].iter().map(Vec::len).sum::<usize>() < 3 {
                continue;
            }
            if (period..size).all(|i| window[i] == window[i % period]) {
                return Err("Repeated text suggests a recognition loop".into());
            }
        }
    }
    // A loop can also be contained inside one long segment.
    for key in &keys {
        for period in 3..=12 {
            for window in key.windows(period * 4) {
                if (period..window.len()).all(|i| window[i] == window[i % period]) {
                    return Err("Repeated phrase inside a transcript segment".into());
                }
            }
        }
    }
    if segments.windows(2).any(|s| s[1].start_ms < s[0].start_ms) {
        return Err("Transcript timestamps moved backwards".into());
    }
    Ok(())
}

async fn run_section(
    audio: &Audio,
    section: &Section,
    model: &Path,
    language: TranscriptionLanguage,
    engine: &Path,
    attempts: &Path,
) -> Result<Vec<Segment>, String> {
    let start = section.start_ms.saturating_sub(OVERLAP_MS);
    let end = (section.end_ms + OVERLAP_MS).min(audio.duration_ms);
    // Unique for every attempt, including retries: stale JSON can never be
    // mistaken for the output of a failed process.
    let base = attempts.join(format!(
        "{}-{}-{}",
        section.start_ms,
        section.end_ms,
        uuid::Uuid::new_v4()
    ));
    let slice = SliceFile(base.with_extension("wav"));
    audio.write_slice(&slice.0, start, end)?;
    let stdout =
        std::fs::File::create(base.with_extension("stdout.log")).map_err(|e| e.to_string())?;
    let stderr =
        std::fs::File::create(base.with_extension("stderr.log")).map_err(|e| e.to_string())?;
    let started = Instant::now();
    let result = tokio::time::timeout(
        Duration::from_secs(300),
        cmd(&engine.to_string_lossy())
            .kill_on_drop(true)
            .arg("-m")
            .arg(model)
            .arg("-f")
            .arg(&slice.0)
            .args(["-l", language.as_arg(), "-mc", "0", "-oj", "-of"])
            .arg(&base)
            .stdout(stdout)
            .stderr(stderr)
            .status(),
    )
    .await;
    cache::write_json(
        &base.with_extension("attempt.json"),
        &serde_json::json!({
            "section": section, "slice_start_ms": start, "slice_end_ms": end,
            "language": language, "model": model, "elapsed_ms": started.elapsed().as_millis(),
            "timed_out": result.is_err(),
            "exit_code": result.as_ref().ok().and_then(|r| r.as_ref().ok()).and_then(|s| s.code()),
        }),
    )?;
    let status = result
        .map_err(|_| format!("Whisper section timed out; logs: {}", base.display()))?
        .map_err(|e| format!("Start whisper-cli: {e}"))?;
    if !status.success() {
        return Err(format!(
            "Whisper section failed ({status}); logs: {}",
            base.display()
        ));
    }
    let json = std::fs::read_to_string(base.with_extension("json"))
        .map_err(|e| format!("Read timed Whisper output: {e}; logs: {}", base.display()))?;
    parse_segments(&json, start, end - start)
}

fn parse_segments(json: &str, offset: u64, duration: u64) -> Result<Vec<Segment>, String> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("Whisper JSON: {e}"))?;
    let entries = value["transcription"]
        .as_array()
        .ok_or("Whisper returned no timed transcription")?;
    let mut segments = Vec::new();
    for entry in entries {
        let text = entry["text"].as_str().unwrap_or("").trim();
        if text.is_empty() {
            continue;
        }
        if !is_speech_text(text) {
            continue;
        }
        let time = |key| {
            entry["offsets"][key]
                .as_u64()
                .or_else(|| entry["timestamps"][key].as_str().and_then(parse_timestamp))
        };
        let from = time("from").ok_or("Missing segment start time")?;
        let to = time("to").ok_or("Missing segment end time")?;
        if to <= from || from >= duration || to > duration + 1000 {
            return Err(format!("Invalid Whisper segment timing: {from}–{to} ms"));
        }
        segments.push(Segment {
            start_ms: offset + from,
            end_ms: offset + to.min(duration),
            text: text.into(),
        });
    }
    Ok(segments)
}

fn parse_timestamp(value: &str) -> Option<u64> {
    let parts = value.split(':').collect::<Vec<_>>();
    if parts.len() != 3 {
        return None;
    }
    let seconds = parts[2].replace(',', ".").parse::<f64>().ok()?;
    if !seconds.is_finite() || !(0.0..60.0).contains(&seconds) {
        return None;
    }
    Some(
        parts[0].parse::<u64>().ok()? * 3_600_000
            + parts[1].parse::<u64>().ok()? * 60_000
            + (seconds * 1000.0).round() as u64,
    )
}

fn words(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|word| {
            word.trim_matches(|c: char| !c.is_alphanumeric())
                .to_lowercase()
        })
        .collect()
}

fn merge_section(merged: &mut Vec<Segment>, segments: Vec<Segment>, section: &Section) {
    // Keep every segment that intersects its owned interval. Midpoint ownership
    // can drop a boundary utterance when the two decodes segment it differently.
    let boundary_end = merged.last().map(|s| s.end_ms).unwrap_or(0);
    let context = merged
        .iter()
        .rev()
        .take_while(|s| s.end_ms + OVERLAP_MS * 2 >= section.start_ms)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .flat_map(|s| words(&s.text))
        .collect::<Vec<_>>();
    for mut segment in segments {
        if segment.end_ms <= section.start_ms || segment.start_ms >= section.end_ms {
            continue;
        }
        // Only deduplicate across section boundaries, never within a section:
        // "yes, yes" may be exactly what was said.
        if segment.start_ms < boundary_end && !context.is_empty() {
            let after = words(&segment.text);
            if !after.is_empty()
                && segment.end_ms <= boundary_end
                && context.windows(after.len()).any(|window| window == after)
            {
                continue;
            }
            let common = (1..=context.len().min(after.len())).rev().find(|&n| {
                context[context.len() - n..] == after[..n]
                    && (n >= 2 || n == context.len() || n == after.len())
            });
            if let Some(n) = common {
                segment.text = segment
                    .text
                    .split_whitespace()
                    .skip(n)
                    .collect::<Vec<_>>()
                    .join(" ");
                if segment.text.is_empty() {
                    continue;
                }
                segment.start_ms = segment.start_ms.max(boundary_end).min(segment.end_ms - 1);
            }
        }
        merged.push(segment);
    }
    merged.sort_by_key(|s| s.start_ms);
}

fn timestamp(ms: u64) -> String {
    format!("{:02}:{:02}", ms / 60_000, ms / 1000 % 60)
}
fn render(segments: &[Segment]) -> String {
    segments
        .iter()
        .map(|s| format!("[{}] {}", timestamp(s.start_ms), s.text))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merging_keeps_boundary_utterances_and_legitimate_short_repetition() {
        let mut merged = vec![];
        merge_section(
            &mut merged,
            vec![
                Segment {
                    start_ms: 0,
                    end_ms: 1000,
                    text: "yes".into(),
                },
                Segment {
                    start_ms: 1000,
                    end_ms: 2000,
                    text: "yes".into(),
                },
                Segment {
                    start_ms: 59_000,
                    end_ms: 62_000,
                    text: "Boundary utterance".into(),
                },
            ],
            &Section {
                start_ms: 0,
                end_ms: 60_000,
            },
        );
        assert_eq!(merged.len(), 3);
        merge_section(
            &mut merged,
            vec![Segment {
                start_ms: 58_000,
                end_ms: 60_200,
                text: "A differently segmented thought".into(),
            }],
            &Section {
                start_ms: 60_000,
                end_ms: 120_000,
            },
        );
        assert!(merged
            .iter()
            .any(|s| s.text == "A differently segmented thought"));
    }

    #[test]
    fn coverage_finds_missing_start_middle_and_end_but_allows_silence() {
        let section = Section {
            start_ms: 0,
            end_ms: 60_000,
        };
        let voice = vec![true; 3000];
        let segment = |start_ms, end_ms| Segment {
            start_ms,
            end_ms,
            text: "Meaningful speech".into(),
        };
        assert!(!uncovered_speech(&voice, &[segment(10_000, 60_000)], &section).is_empty());
        assert!(!uncovered_speech(
            &voice,
            &[segment(0, 20_000), segment(30_000, 60_000)],
            &section
        )
        .is_empty());
        assert!(!uncovered_speech(&voice, &[segment(0, 40_000)], &section).is_empty());
        let mut trailing_silence = voice.clone();
        trailing_silence[2000..].fill(false);
        assert!(uncovered_speech(&trailing_silence, &[segment(0, 40_000)], &section).is_empty());
        assert!(uncovered_speech(&vec![false; 3000], &[], &section).is_empty());
        assert!(!uncovered_speech(
            &voice,
            &[Segment {
                start_ms: 0,
                end_ms: 60_000,
                text: "[BLANK_AUDIO]".into()
            }],
            &section
        )
        .is_empty());
    }

    #[test]
    fn vad_accepts_silence_and_partial_final_frame() {
        assert_eq!(voice_frames(&[0; 321]).unwrap(), vec![false, false]);
    }

    #[test]
    fn detects_the_actual_cutoff_loop_and_alternating_loops() {
        let phrase = "Her er hvordan det ser ut når dere innlager.";
        let segments = (0..32)
            .map(|i| Segment {
                start_ms: 414_040 + i * 2000,
                end_ms: 416_040 + i * 2000,
                text: phrase.into(),
            })
            .collect::<Vec<_>>();
        assert!(validate_section(&segments).is_err());
        let alternating = ["First repeated sentence", "Second repeated sentence"]
            .iter()
            .cycle()
            .take(6)
            .enumerate()
            .map(|(i, text)| Segment {
                start_ms: i as u64 * 1000,
                end_ms: i as u64 * 1000 + 1000,
                text: (*text).into(),
            })
            .collect::<Vec<_>>();
        assert!(validate_section(&alternating).is_err());
        assert!(validate_section(&segments[..2]).is_ok());
        let short = (0..10)
            .map(|i| Segment {
                start_ms: i * 1000,
                end_ms: i * 1000 + 1000,
                text: "yes".into(),
            })
            .collect::<Vec<_>>();
        assert!(validate_section(&short).is_err());
        assert!(validate_section(&short[..3]).is_ok());
        let inline = vec![Segment {
            start_ms: 0,
            end_ms: 30_000,
            text: "We should do this. ".repeat(10),
        }];
        assert!(validate_section(&inline).is_err());
    }

    #[test]
    fn retry_ranges_are_bounded_and_cover_only_the_failed_section() {
        let parts = retry_parts(&Section {
            start_ms: 59_000,
            end_ms: 118_500,
        });
        assert_eq!(
            parts,
            vec![
                Section {
                    start_ms: 59_000,
                    end_ms: 89_000
                },
                Section {
                    start_ms: 89_000,
                    end_ms: 118_500
                }
            ]
        );
    }

    #[test]
    fn section_plan_covers_entire_audio_without_gaps() {
        let audio = Audio {
            samples: vec![0; RATE as usize * 131],
            duration_ms: 131_000,
            voice: vec![false; 6550],
        };
        let sections = audio.sections(SECTION_MS);
        assert_eq!(sections.first().unwrap().start_ms, 0);
        assert_eq!(sections.last().unwrap().end_ms, 131_000);
        assert!(sections.windows(2).all(|s| s[0].end_ms == s[1].start_ms));
        assert!(sections
            .iter()
            .all(|s| s.end_ms > s.start_ms && s.end_ms - s.start_ms <= SECTION_MS));
    }

    #[test]
    fn parse_preserves_milliseconds_and_adds_offset_once() {
        let segments = parse_segments(
            r#"{"transcription":[{"text":"Hei","offsets":{"from":120,"to":1450}}]}"#,
            58_000,
            64_000,
        )
        .unwrap();
        assert_eq!(segments[0].start_ms, 58_120);
        assert_eq!(segments[0].end_ms, 59_450);
        assert_eq!(parse_timestamp("01:02:03,450"), Some(3_723_450));
        assert!(parse_segments(
            r#"{"transcription":[{"text":"Bad","offsets":{"from":900,"to":100}}]}"#,
            0,
            1000
        )
        .is_err());
        assert!(parse_segments(r#"{"text":"Untimed"}"#, 0, 1000).is_err());
    }

    #[test]
    fn overlap_merges_different_segmentation_but_preserves_later_repetition() {
        let mut merged = vec![Segment {
            start_ms: 55_000,
            end_ms: 61_000,
            text: "Here is the end of a thought.".into(),
        }];
        merge_section(
            &mut merged,
            vec![
                Segment {
                    start_ms: 59_000,
                    end_ms: 67_000,
                    text: "end of a thought. Now another point.".into(),
                },
                Segment {
                    start_ms: 80_000,
                    end_ms: 83_000,
                    text: "Now another point.".into(),
                },
            ],
            &Section {
                start_ms: 60_000,
                end_ms: 120_000,
            },
        );
        assert_eq!(merged[1].text, "Now another point.");
        assert_eq!(merged[1].start_ms, 61_000);
        assert_eq!(merged[2].text, "Now another point.");
    }
}
