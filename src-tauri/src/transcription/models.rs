use super::TranscriptionLanguage;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct WhisperModelInfo {
    pub name: String,
    pub label: String,
    pub path: String,
    pub size_bytes: u64,
}

pub fn search_dirs() -> Vec<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    vec![
        PathBuf::from(format!("{home}/.local/share/whisper-cpp/models")),
        PathBuf::from(format!("{home}/whisper.cpp/models")),
        PathBuf::from("/opt/homebrew/share/whisper-cpp/models"),
        PathBuf::from(format!(
            "{home}/Library/Application Support/com.pais.handy/models"
        )),
    ]
}

pub fn list(dirs: &[PathBuf]) -> Vec<WhisperModelInfo> {
    let mut models = Vec::new();
    for dir in dirs {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() || path.extension().is_none_or(|e| e != "bin") {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if name.contains("silero") || name.contains("vad") {
                    continue;
                }
                let label = match name.as_str() {
                    "ggml-nb-whisper-large.bin" => "NB-Whisper Large · Norwegian".to_string(),
                    "ggml-nb-whisper-large-q5_0.bin" => {
                        "NB-Whisper Large Q5 · Norwegian".to_string()
                    }
                    "ggml-large-v3.bin" => "Whisper Large v3 · multilingual".to_string(),
                    "ggml-large-v3-turbo.bin" => {
                        "Whisper Large v3 Turbo · multilingual".to_string()
                    }
                    _ => name.clone(),
                };
                models.push(WhisperModelInfo {
                    name,
                    label,
                    path: path.to_string_lossy().to_string(),
                    size_bytes: entry.metadata().map(|m| m.len()).unwrap_or(0),
                });
            }
        }
    }
    models.sort_by(|a, b| a.label.cmp(&b.label).then(a.path.cmp(&b.path)));
    models
}

pub fn select(
    dirs: &[PathBuf],
    selected: Option<&str>,
    language: TranscriptionLanguage,
) -> Result<PathBuf, String> {
    let compatible = |path: &Path| -> Result<(), String> {
        if path
            .file_name()
            .is_some_and(|n| n.to_string_lossy().contains(".en."))
            && language != TranscriptionLanguage::En
        {
            return Err("This model supports English only. Choose English or a multilingual transcription model.".into());
        }
        Ok(())
    };
    if let Some(name) = selected.filter(|n| !n.trim().is_empty()) {
        let path = if Path::new(name).is_absolute() {
            Some(PathBuf::from(name)).filter(|p| p.is_file())
        } else {
            dirs.iter().map(|dir| dir.join(name)).find(|p| p.is_file())
        };
        let path = path.ok_or_else(|| format!("Selected transcription model '{name}' is missing. Download it or choose another model in Settings."))?;
        compatible(&path)?;
        return Ok(path);
    }
    let mut preferred = Vec::new();
    if language == TranscriptionLanguage::No {
        preferred.extend([
            "ggml-nb-whisper-large.bin",
            "ggml-nb-whisper-large-q5_0.bin",
        ]);
    }
    preferred.extend([
        "ggml-large-v3.bin",
        "ggml-large-v3-turbo.bin",
        "ggml-medium.bin",
        "whisper-medium-q4_1.bin",
        "ggml-small.bin",
        "ggml-base.bin",
        "ggml-tiny.bin",
    ]);
    // Apply preference across all search directories, not just the first one.
    for name in preferred {
        if let Some(path) = dirs.iter().map(|dir| dir.join(name)).find(|p| p.is_file()) {
            return Ok(path);
        }
    }
    for model in list(dirs) {
        let path = PathBuf::from(model.path);
        if compatible(&path).is_ok() {
            return Ok(path);
        }
    }
    Err("No compatible Whisper model found. Download a model in Settings.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn norwegian_prefers_nb_but_auto_and_english_keep_multilingual_and_explicit_choices_win() {
        let dir = std::env::temp_dir().join(format!("lore-model-test-{}", uuid::Uuid::new_v4()));
        let later = dir.join("other");
        std::fs::create_dir_all(&later).unwrap();
        let generic = dir.join("ggml-large-v3.bin");
        let norwegian = later.join("ggml-nb-whisper-large.bin");
        std::fs::write(&generic, b"model").unwrap();
        std::fs::write(&norwegian, b"model").unwrap();
        let dirs = vec![dir.clone(), later];
        assert_eq!(
            select(&dirs, None, TranscriptionLanguage::No).unwrap(),
            norwegian
        );
        assert_eq!(
            select(&dirs, None, TranscriptionLanguage::Auto).unwrap(),
            generic
        );
        assert_eq!(
            select(&dirs, None, TranscriptionLanguage::En).unwrap(),
            generic
        );
        assert_eq!(
            select(&dirs, Some("ggml-large-v3.bin"), TranscriptionLanguage::No).unwrap(),
            generic
        );
        assert!(select(&dirs, Some("missing.bin"), TranscriptionLanguage::No).is_err());
        let english = dir.join("ggml-small.en.bin");
        std::fs::write(&english, b"model").unwrap();
        assert!(select(
            &dirs,
            Some("ggml-small.en.bin"),
            TranscriptionLanguage::Auto
        )
        .is_err());
        assert!(select(&dirs, Some("ggml-small.en.bin"), TranscriptionLanguage::En).is_ok());
        assert!(list(&dirs)
            .iter()
            .any(|m| m.label == "NB-Whisper Large · Norwegian"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
