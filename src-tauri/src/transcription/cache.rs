use super::{render, timestamp, Problem, Section, Segment, TranscriptionLanguage};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};

const PIPELINE_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Identity {
    pipeline_version: u32,
    audio_sha256: String,
    model_sha256: String,
    language: TranscriptionLanguage,
    engine_version: String,
    sections: Vec<Section>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Completed {
    section: Section,
    segments: Vec<Segment>,
}

#[derive(Serialize, Deserialize)]
struct Checkpoint {
    identity: Identity,
    completed: Vec<Completed>,
    problems: Vec<Problem>,
    complete: bool,
}

pub(super) struct Session {
    pub dir: PathBuf,
    pub attempts: PathBuf,
    checkpoint: Checkpoint,
}

impl Session {
    pub async fn open(
        wav: &Path,
        model: &Path,
        language: TranscriptionLanguage,
        engine: &Path,
        sections: &[Section],
    ) -> Result<Self, String> {
        let audio_path = wav.to_owned();
        let model_path = model.to_owned();
        let (audio_sha256, model_sha256) = tokio::task::spawn_blocking(move || {
            Ok::<_, String>((hash_file(&audio_path)?, hash_file(&model_path)?))
        })
        .await
        .map_err(|e| format!("Fingerprint task: {e}"))??;
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            crate::qmd::cmd(&engine.to_string_lossy())
                .kill_on_drop(true)
                .arg("--version")
                .output(),
        )
        .await
        .map_err(|_| "Whisper version check timed out")?
        .map_err(|e| format!("Check whisper-cli version: {e}"))?;
        if !output.status.success() {
            return Err("Could not determine whisper-cli version".into());
        }
        let engine_version = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let identity = Identity {
            pipeline_version: PIPELINE_VERSION,
            audio_sha256,
            model_sha256,
            language,
            engine_version,
            sections: sections.to_vec(),
        };
        let identity_json = serde_json::to_vec(&identity).map_err(|e| e.to_string())?;
        let key = format!("{:x}", Sha256::digest(&identity_json));
        let dir = wav
            .parent()
            .ok_or("Audio has no parent directory")?
            .join(".transcription")
            .join(wav.file_stem().ok_or("Audio has no file stem")?)
            .join(&key[..20]);
        std::fs::create_dir_all(&dir).map_err(|e| format!("Create transcription cache: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        let checkpoint = std::fs::read(dir.join("checkpoint.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Checkpoint>(&bytes).ok())
            .filter(|saved| saved.identity == identity)
            .unwrap_or(Checkpoint {
                identity,
                completed: Vec::new(),
                problems: Vec::new(),
                complete: false,
            });
        let attempts = dir.join("attempts").join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&attempts).map_err(|e| e.to_string())?;
        let session = Self {
            dir,
            attempts,
            checkpoint,
        };
        session.save()?;
        Ok(session)
    }

    pub fn get(&self, section: &Section) -> Option<Vec<Segment>> {
        self.checkpoint
            .completed
            .iter()
            .find(|c| &c.section == section)
            .map(|c| c.segments.clone())
    }

    pub fn has_retry_parts(&self, section: &Section) -> bool {
        super::retry_parts(section)
            .iter()
            .any(|part| self.get(part).is_some())
    }

    pub fn store(&mut self, section: &Section, segments: &[Segment]) -> Result<(), String> {
        self.checkpoint.completed.retain(|c| &c.section != section);
        self.checkpoint.completed.push(Completed {
            section: section.clone(),
            segments: segments.to_vec(),
        });
        self.checkpoint.complete = false;
        self.save()
    }

    pub fn finish(&mut self, segments: &[Segment], problems: &[Problem]) -> Result<(), String> {
        self.checkpoint.problems = problems.to_vec();
        self.checkpoint.complete = problems.is_empty();
        let text = render(segments);
        let partial = format!(
            "# Partial transcription\n\n{}\n\n{}\n",
            if problems.is_empty() {
                "All sections processed. See transcript.md for the completed output.".into()
            } else {
                problems
                    .iter()
                    .map(|p| {
                        format!(
                            "- **INCOMPLETE {}–{}:** {}",
                            timestamp(p.section.start_ms),
                            timestamp(p.section.end_ms),
                            p.reason
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            },
            text
        );
        atomic_write(&self.dir.join("partial.md"), partial.as_bytes())?;
        if problems.is_empty() {
            atomic_write(&self.dir.join("transcript.md"), text.as_bytes())?;
        } else {
            // A previous complete result must not look current after a failed retry.
            match std::fs::remove_file(self.dir.join("transcript.md")) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        self.save()
    }

    fn save(&self) -> Result<(), String> {
        write_json(&self.dir.join("checkpoint.json"), &self.checkpoint)
    }
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("Open {}: {e}", path.display()))?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65_536];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub(super) fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    atomic_write(
        path,
        &serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?,
    )
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result.map_err(|e| format!("Save {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprints_distinguish_changes_with_the_same_file_size() {
        let path = std::env::temp_dir().join(format!("lore-fingerprint-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"first").unwrap();
        let before = hash_file(&path).unwrap();
        std::fs::write(&path, b"other").unwrap();
        assert_ne!(before, hash_file(&path).unwrap());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn checkpoints_keep_successful_parts_and_explicitly_mark_incomplete_output() {
        let dir = std::env::temp_dir().join(format!("lore-checkpoint-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let section = Section {
            start_ms: 0,
            end_ms: 30_000,
        };
        let identity = Identity {
            pipeline_version: PIPELINE_VERSION,
            audio_sha256: "audio".into(),
            model_sha256: "model".into(),
            language: TranscriptionLanguage::Auto,
            engine_version: "test".into(),
            sections: vec![section.clone()],
        };
        let mut session = Session {
            attempts: dir.clone(),
            dir: dir.clone(),
            checkpoint: Checkpoint {
                identity,
                completed: vec![],
                problems: vec![],
                complete: false,
            },
        };
        let segments = vec![Segment {
            start_ms: 0,
            end_ms: 10_000,
            text: "Saved speech".into(),
        }];
        session.store(&section, &segments).unwrap();
        let saved: Checkpoint =
            serde_json::from_slice(&std::fs::read(dir.join("checkpoint.json")).unwrap()).unwrap();
        assert_eq!(saved.completed[0].segments, segments);
        assert!(session
            .get(&Section {
                start_ms: 30_000,
                end_ms: 60_000
            })
            .is_none());
        session.finish(&segments, &[]).unwrap();
        assert!(dir.join("transcript.md").exists());
        session
            .finish(
                &segments,
                &[Problem {
                    section,
                    reason: "Unresolved speech".into(),
                }],
            )
            .unwrap();
        assert!(!dir.join("transcript.md").exists());
        assert!(std::fs::read_to_string(dir.join("partial.md"))
            .unwrap()
            .contains("INCOMPLETE 00:00–00:30"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
