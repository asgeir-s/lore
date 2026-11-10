//! End-to-end process failures without downloading models or changing PATH.
use super::*;
use std::os::unix::fs::PermissionsExt;

struct Fixture {
    dir: PathBuf,
    audio: PathBuf,
    model: PathBuf,
    engine: PathBuf,
}
impl Fixture {
    fn new(mode: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("lore-process-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let audio = dir.join("audio.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&audio, spec).unwrap();
        for _ in 0..RATE * 60 {
            writer.write_sample(0i16).unwrap();
        }
        writer.finalize().unwrap();
        let model = dir.join("model.bin");
        std::fs::write(&model, b"fake model").unwrap();
        let engine = dir.join("fake-whisper");
        std::fs::write(&engine, r#"#!/usr/bin/env python3
import json, pathlib, sys, wave
root = pathlib.Path(__file__).parent
if '--version' in sys.argv:
    print('fake whisper version 1')
    sys.exit(0)
arg = lambda flag: sys.argv[sys.argv.index(flag) + 1]
base = pathlib.Path(arg('-of'))
start = int(base.name.split('-')[0])
with wave.open(arg('-f')) as audio:
    duration = audio.getnframes() * 1000 // audio.getframerate()
with (root / 'calls').open('a') as log:
    log.write(str(start) + ':' + arg('-l') + '\n')
mode = (root / 'mode').read_text()
if mode == 'exit':
    base.with_suffix('.json').write_text('{"transcription":[]}')
    print('Deliberate process failure', file=sys.stderr)
    sys.exit(9)
fail = mode == 'fail' or (mode == 'partial' and (duration > 35000 or start == 30000))
if fail:
    segments = [{'text':'This is a stuck decoder.', 'offsets':{'from':i*1000,'to':i*1000+1000}} for i in range(4)]
else:
    segments = [{'text':'Accepted speech for section ' + str(start), 'offsets':{'from':0,'to':duration - 5000 if mode == 'missing' else duration}}]
base.with_suffix('.json').write_text(json.dumps({'transcription':segments}))
print('Retained recognizer output')
"#).unwrap();
        std::fs::set_permissions(&engine, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(dir.join("mode"), mode).unwrap();
        Self {
            dir,
            audio,
            model,
            engine,
        }
    }
    async fn run(&self, language: TranscriptionLanguage) -> Result<String, String> {
        transcribe_using(&self.audio, &self.model, language, &self.engine, |_| {}).await
    }
    fn calls(&self) -> usize {
        std::fs::read_to_string(self.dir.join("calls"))
            .unwrap()
            .lines()
            .count()
    }
    fn cache(&self) -> PathBuf {
        std::fs::read_dir(self.dir.join(".transcription/audio"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[tokio::test]
async fn resumes_only_failed_parts_and_retains_logs_and_partial_output() {
    let f = Fixture::new("partial");
    let error = f.run(TranscriptionLanguage::Auto).await.unwrap_err();
    assert!(error.contains("00:30–01:00"));
    assert_eq!(f.calls(), 3); // full section, successful first half, failed second half
    let cache = f.cache();
    assert!(!cache.join("transcript.md").exists());
    assert!(std::fs::read_to_string(cache.join("partial.md"))
        .unwrap()
        .contains("INCOMPLETE"));
    let run = std::fs::read_dir(cache.join("attempts"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let artifacts = std::fs::read_dir(run)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect::<Vec<_>>();
    assert!(artifacts
        .iter()
        .any(|p| p.to_string_lossy().ends_with("stdout.log")));
    assert!(artifacts
        .iter()
        .any(|p| p.to_string_lossy().ends_with("attempt.json")));
    assert!(!artifacts
        .iter()
        .any(|p| p.extension().is_some_and(|e| e == "wav")));
    std::fs::write(f.dir.join("mode"), "fixed").unwrap();
    f.run(TranscriptionLanguage::Auto).await.unwrap();
    assert_eq!(f.calls(), 4); // only the failed half is rerun
    f.run(TranscriptionLanguage::Auto).await.unwrap();
    assert_eq!(f.calls(), 4); // completed result reused
    assert!(cache.join("transcript.md").exists());
}

#[tokio::test]
async fn cache_invalidates_on_language_model_and_audio_changes() {
    let f = Fixture::new("fixed");
    f.run(TranscriptionLanguage::Auto).await.unwrap();
    f.run(TranscriptionLanguage::Auto).await.unwrap();
    assert_eq!(f.calls(), 1);
    f.run(TranscriptionLanguage::No).await.unwrap();
    assert_eq!(f.calls(), 2);
    std::fs::write(&f.model, b"other data").unwrap();
    f.run(TranscriptionLanguage::No).await.unwrap();
    assert_eq!(f.calls(), 3);
    let mut audio = std::fs::read(&f.audio).unwrap();
    *audio.last_mut().unwrap() = 1;
    std::fs::write(&f.audio, audio).unwrap();
    f.run(TranscriptionLanguage::No).await.unwrap();
    assert_eq!(f.calls(), 4);
}

#[tokio::test]
async fn nonzero_exit_never_accepts_json_even_when_the_process_writes_it() {
    let f = Fixture::new("exit");
    assert!(f.run(TranscriptionLanguage::En).await.is_err());
    assert_eq!(f.calls(), 3);
    assert!(!f.cache().join("transcript.md").exists());
}

#[tokio::test]
async fn concurrent_runs_for_one_recording_are_rejected_and_the_lock_is_released() {
    let f = Fixture::new("fixed");
    let (first, second) = tokio::join!(
        f.run(TranscriptionLanguage::Auto),
        f.run(TranscriptionLanguage::Auto)
    );
    assert_ne!(first.is_ok(), second.is_ok());
    assert!(first
        .err()
        .or_else(|| second.err())
        .unwrap()
        .contains("already running"));
    assert_eq!(f.calls(), 1);
    f.run(TranscriptionLanguage::Auto).await.unwrap();
    assert_eq!(f.calls(), 1);
}

#[tokio::test]
async fn missing_coverage_keeps_valid_text_in_partial_output_without_caching_it_as_complete() {
    let f = Fixture::new("missing");
    let mut audio = Audio::read(&f.audio).unwrap();
    // Controlled speech decisions isolate the recovery behavior from VAD.
    audio.voice.fill(true);
    let section = Section {
        start_ms: 0,
        end_ms: 60_000,
    };
    let mut session = Session::open(
        &f.audio,
        &f.model,
        TranscriptionLanguage::En,
        &f.engine,
        &[section.clone()],
    )
    .await
    .unwrap();
    let (segments, problems) = recover_section(
        &audio,
        &section,
        &f.model,
        TranscriptionLanguage::En,
        &f.engine,
        &mut session,
        &|_| {},
    )
    .await
    .unwrap();
    assert_eq!(f.calls(), 3);
    assert_eq!(segments.len(), 2);
    assert!(!problems.is_empty());
    assert!(session.get(&section).is_none());
    session.finish(&segments, &problems).unwrap();
    let partial = std::fs::read_to_string(session.dir.join("partial.md")).unwrap();
    assert!(partial.contains("Accepted speech for section 30000"));
    assert!(partial.contains("INCOMPLETE"));
    assert!(!session.dir.join("transcript.md").exists());
}
