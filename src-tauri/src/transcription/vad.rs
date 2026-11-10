//! Neural speech detection avoids treating sustained room noise as missing words.
//! This only validates coverage: the recognizer still receives the entire audio.
use super::{cache, models};
use crate::qmd::cmd;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub(super) struct Detector {
    pub engine: PathBuf,
    pub model: PathBuf,
}

impl Detector {
    pub fn find() -> Option<Self> {
        for name in ["ggml-silero-v6.2.0.bin", "ggml-silero-v5.1.2.bin"] {
            for dir in models::search_dirs() {
                let model = dir.join(name);
                if model.is_file() {
                    return Some(Self {
                        engine: "whisper-vad-speech-segments".into(),
                        model,
                    });
                }
            }
        }
        None
    }

    pub async fn voice_frames(
        &self,
        wav: &Path,
        duration_ms: u64,
        attempts: &Path,
    ) -> Result<Vec<bool>, String> {
        let started = Instant::now();
        let output = tokio::time::timeout(
            Duration::from_secs(120),
            cmd(&self.engine.to_string_lossy())
                .kill_on_drop(true)
                .arg("-vm")
                .arg(&self.model)
                .arg("-f")
                .arg(wav)
                .arg("-np")
                .output(),
        )
        .await;
        cache::write_json(
            &attempts.join("coverage-vad.attempt.json"),
            &serde_json::json!({
                "engine": self.engine, "model": self.model,
                "elapsed_ms": started.elapsed().as_millis(), "timed_out": output.is_err(),
                "exit_code": output.as_ref().ok().and_then(|r| r.as_ref().ok()).and_then(|o| o.status.code()),
            }),
        )?;
        let output = output
            .map_err(|_| "Neural speech detection timed out".to_string())?
            .map_err(|e| format!("Start neural speech detector: {e}"))?;
        std::fs::write(attempts.join("coverage-vad.stdout.log"), &output.stdout)
            .map_err(|e| e.to_string())?;
        std::fs::write(attempts.join("coverage-vad.stderr.log"), &output.stderr)
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(format!("Neural speech detection failed: {}", output.status));
        }
        parse_frames(&String::from_utf8_lossy(&output.stdout), duration_ms)
    }
}

fn parse_frames(output: &str, duration_ms: u64) -> Result<Vec<bool>, String> {
    let invalid = || "Unrecognized neural speech detector output".to_string();
    let mut expected = None;
    let mut intervals = Vec::new();
    for line in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if let Some(count) = line
            .strip_prefix("Detected ")
            .and_then(|s| s.strip_suffix(" speech segments:"))
        {
            if expected
                .replace(count.parse::<usize>().map_err(|_| invalid())?)
                .is_some()
            {
                return Err(invalid());
            }
            continue;
        }
        let (index, times) = line
            .strip_prefix("Speech segment ")
            .and_then(|s| s.split_once(": start = "))
            .ok_or_else(invalid)?;
        if index.parse::<usize>().map_err(|_| invalid())? != intervals.len() {
            return Err(invalid());
        }
        let (start, end) = times.split_once(", end = ").ok_or_else(invalid)?;
        // The helper reports centiseconds, not seconds or milliseconds.
        let start = start.parse::<f64>().map_err(|_| invalid())? * 10.0;
        let end = end.parse::<f64>().map_err(|_| invalid())? * 10.0;
        if !start.is_finite()
            || !end.is_finite()
            || start < 0.0
            || start >= duration_ms as f64
            || end <= start
            || end > duration_ms as f64 + 40.0
            || intervals
                .last()
                .is_some_and(|&(_, last_end)| start < last_end)
        {
            return Err(invalid());
        }
        intervals.push((start, end));
    }
    if expected != Some(intervals.len()) {
        return Err(invalid());
    }
    let mut voice = vec![false; duration_ms.div_ceil(20) as usize];
    for (start, end) in intervals {
        let from = (start / 20.0).floor() as usize;
        let to = ((end / 20.0).ceil() as usize).min(voice.len());
        voice[from..to].fill(true);
    }
    Ok(voice)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcription::{uncovered_speech, Section, Segment};

    #[test]
    fn short_tail_noise_does_not_block_a_finished_conversation() {
        let voice = parse_frames("\nDetected 2 speech segments:\nSpeech segment 0: start = 0.00, end = 1061.00\nSpeech segment 1: start = 1410.00, end = 1585.00\n", 16_112).unwrap();
        let section = Section {
            start_ms: 0,
            end_ms: 16_112,
        };
        let segments = [Segment {
            start_ms: 0,
            end_ms: 9200,
            text: "Goodbye".into(),
        }];
        assert!(uncovered_speech(&voice, &segments, &section).is_empty());
        assert!(!uncovered_speech(&vec![true; voice.len()], &segments, &section).is_empty());
        // Substantial real speech at the end must still be reported.
        let voice = parse_frames(
            "Detected 1 speech segments:\nSpeech segment 0: start = 0.00, end = 1600.00",
            16_112,
        )
        .unwrap();
        assert!(!uncovered_speech(&voice, &segments, &section).is_empty());
    }

    #[test]
    fn empty_or_malformed_output_cannot_be_mistaken_for_silence() {
        assert_eq!(
            parse_frames("Detected 0 speech segments:", 101).unwrap(),
            vec![false; 6]
        );
        for output in [
            "",
            "Unexpected output",
            "Detected 1 speech segments:",
            "Detected 1 speech segments:\nSpeech segment 0: start = NaN, end = 10.00",
            "Detected 1 speech segments:\nSpeech segment 0: start = 20.00, end = 10.00",
            "Detected 1 speech segments:\nSpeech segment 0: start = 0.00, end = 10000.00",
            "Detected 1 speech segments:\nSpeech segment 1: start = 0.00, end = 10.00",
            "Detected 1 speech segments:\nSpeech segment 0: start = 103.00, end = 104.00",
        ] {
            assert!(parse_frames(output, 1000).is_err(), "{output}");
        }
    }
}
