//! Independent audio sections prevent a bad decode from poisoning a whole meeting.
use crate::qmd::cmd;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

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
        Ok(Self {
            samples,
            duration_ms,
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

struct WorkDir(PathBuf);
impl Drop for WorkDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub async fn transcribe(
    wav: &Path,
    model: &Path,
    language: TranscriptionLanguage,
    progress: impl Fn(&str) + Send + Sync,
) -> Result<String, String> {
    let audio = Audio::read(wav)?;
    let work =
        WorkDir(std::env::temp_dir().join(format!("lore-transcription-{}", uuid::Uuid::new_v4())));
    std::fs::create_dir_all(&work.0).map_err(|e| e.to_string())?;
    let sections = audio.sections(SECTION_MS);
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
            &work.0.join(i.to_string()),
            &progress,
        )
        .await;
        problems.extend(failed);
        merge_section(&mut merged, segments, section);
    }
    if problems.is_empty() {
        Ok(render(&merged))
    } else {
        Err(format!(
            "Transcription incomplete: {}",
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
    base: &Path,
    progress: &(impl Fn(&str) + Send + Sync),
) -> (Vec<Segment>, Vec<Problem>) {
    let reason = match run_section(audio, section, model, language, base).await {
        Ok(segments) => match validate_section(&segments) {
            Ok(()) => return (segments, Vec::new()),
            Err(reason) => reason,
        },
        Err(reason) => reason,
    };
    progress(&format!(
        "Retrying {}–{} in smaller sections...",
        timestamp(section.start_ms),
        timestamp(section.end_ms)
    ));
    eprintln!(
        "transcription: retry {}–{}: {reason}",
        timestamp(section.start_ms),
        timestamp(section.end_ms)
    );
    let mut merged = Vec::new();
    let mut problems = Vec::new();
    for (index, part) in retry_parts(section).iter().enumerate() {
        let result = run_section(
            audio,
            part,
            model,
            language,
            &base.with_file_name(format!(
                "{}-retry-{index}",
                base.file_name().unwrap().to_string_lossy()
            )),
        )
        .await
        .and_then(|segments| {
            validate_section(&segments)?;
            Ok(segments)
        });
        match result {
            Ok(segments) => merge_section(&mut merged, segments, part),
            Err(reason) => problems.push(Problem {
                section: part.clone(),
                reason,
            }),
        }
    }
    (merged, problems)
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
    base: &Path,
) -> Result<Vec<Segment>, String> {
    let start = section.start_ms.saturating_sub(OVERLAP_MS);
    let end = (section.end_ms + OVERLAP_MS).min(audio.duration_ms);
    let slice = base.with_extension("wav");
    audio.write_slice(&slice, start, end)?;
    let output = tokio::time::timeout(
        Duration::from_secs(300),
        cmd("whisper-cli")
            .kill_on_drop(true)
            .args(["-m"])
            .arg(model)
            .arg("-f")
            .arg(&slice)
            .args(["-l", language.as_arg(), "-mc", "0", "-oj", "-of"])
            .arg(base)
            .output(),
    )
    .await
    .map_err(|_| "Whisper section timed out after five minutes".to_string())?
    .map_err(|e| format!("Start whisper-cli: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "Whisper section failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let json = std::fs::read_to_string(base.with_extension("json"))
        .map_err(|e| format!("Read timed Whisper output: {e}"))?;
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
    for mut segment in segments {
        let middle = segment.start_ms + (segment.end_ms - segment.start_ms) / 2;
        if middle < section.start_ms || middle >= section.end_ms {
            continue;
        }
        if let Some(previous) = merged.last() {
            // Remove only matching words at a real overlap, never repeated speech
            // elsewhere in the meeting. Segmentation may differ between passes.
            if previous.end_ms + OVERLAP_MS >= segment.start_ms {
                let before = words(&previous.text);
                let after = words(&segment.text);
                let common = (1..=before.len().min(after.len())).rev().find(|&n| {
                    before[before.len() - n..] == after[..n]
                        && (n >= 2 || n == before.len() || n == after.len())
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
                    segment.start_ms = segment
                        .start_ms
                        .max(previous.end_ms)
                        .min(segment.end_ms - 1);
                }
            }
        }
        merged.push(segment);
    }
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
