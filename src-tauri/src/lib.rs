mod git_sync;
mod notes;
mod qmd;
mod recording;

use git_sync::GitSyncHandle;
use notes::{NoteIndex, NoteMetadata};
use qmd::QmdHandle;
use recording::RecordingHandle;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager, RunEvent, State};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelSettings {
    pub keyword_model: Option<String>,
    pub summary_model: Option<String>,
    pub whisper_model: Option<String>,
}

fn model_settings_path(notes_dir: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(notes_dir).join(".dump-models.json")
}

fn load_model_settings(notes_dir: &str) -> ModelSettings {
    let path = model_settings_path(notes_dir);
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_model_settings(notes_dir: &str, settings: &ModelSettings) {
    let path = model_settings_path(notes_dir);
    if let Ok(json) = serde_json::to_string_pretty(settings) {
        let _ = std::fs::write(path, json);
    }
}

pub struct AppState {
    pub notes_dir: Mutex<String>,
    pub index: Mutex<NoteIndex>,
    pub git: Mutex<GitSyncHandle>,
    pub qmd: Mutex<QmdHandle>,
    pub recording: Mutex<RecordingHandle>,
    pub model_settings: Mutex<ModelSettings>,
}

fn shell_escape_single_quoted(input: &str) -> String {
    input.replace('\'', "'\"'\"'")
}

fn resolve_setup_script(app_handle: &tauri::AppHandle, file_name: &str) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    // Dev mode (repo checkout)
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("scripts")
            .join(file_name),
    );
    // Packaged app resources (path layout can vary)
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        candidates.push(resource_dir.join("scripts").join(file_name));
        candidates.push(resource_dir.join(file_name));
    }
    candidates.into_iter().find(|p| p.exists())
}

#[cfg(target_os = "macos")]
fn open_terminal(command: &str) -> Result<(), String> {
    let escaped = command.replace('\\', "\\\\").replace('\"', "\\\"");
    let script = format!("tell application \"Terminal\" to do script \"{escaped}\"");
    let status = std::process::Command::new("osascript")
        .arg("-e")
        .arg("tell application \"Terminal\" to activate")
        .arg("-e")
        .arg(script)
        .status()
        .map_err(|e| format!("Failed to open Terminal: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Failed to launch Terminal command".into())
    }
}

#[cfg(target_os = "linux")]
fn open_terminal(command: &str) -> Result<(), String> {
    let wrapped = format!(
        "{command}; EXIT_CODE=$?; echo; if [ $EXIT_CODE -eq 0 ]; then echo \"Setup complete.\"; else echo \"Setup failed (exit $EXIT_CODE).\"; fi; echo \"Press Enter to close...\"; read -r _"
    );
    let mut attempts: Vec<(&str, Vec<String>)> = vec![
        (
            "x-terminal-emulator",
            vec!["-e".into(), "bash".into(), "-lc".into(), wrapped.clone()],
        ),
        (
            "gnome-terminal",
            vec!["--".into(), "bash".into(), "-lc".into(), wrapped.clone()],
        ),
        (
            "konsole",
            vec!["-e".into(), "bash".into(), "-lc".into(), wrapped.clone()],
        ),
        (
            "alacritty",
            vec!["-e".into(), "bash".into(), "-lc".into(), wrapped.clone()],
        ),
        (
            "xterm",
            vec!["-e".into(), "bash".into(), "-lc".into(), wrapped],
        ),
    ];
    let mut last_err: Option<String> = None;
    for (terminal, args) in attempts.drain(..) {
        match std::process::Command::new(terminal).args(&args).spawn() {
            Ok(_) => return Ok(()),
            Err(e) => {
                last_err = Some(format!("{terminal}: {e}"));
            }
        }
    }
    Err(last_err.unwrap_or_else(|| "No supported terminal emulator found".into()))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn open_terminal(_command: &str) -> Result<(), String> {
    Err("Tool installer is not supported on this platform".into())
}

#[tauri::command]
fn open_tool_installer(app_handle: tauri::AppHandle, tool: String) -> Result<(), String> {
    let tool = tool.trim().to_lowercase();
    let command = match tool.as_str() {
        "git" => {
            #[cfg(target_os = "macos")]
            {
                "xcode-select --install".to_string()
            }
            #[cfg(target_os = "linux")]
            {
                "sudo apt-get update && sudo apt-get install -y git".to_string()
            }
            #[cfg(not(any(target_os = "macos", target_os = "linux")))]
            {
                return Err("Git installer is not supported on this platform".into());
            }
        }
        "ffmpeg" | "whisper" | "ollama" | "qmd" => {
            #[cfg(target_os = "macos")]
            let script_name = "setup-macos.sh";
            #[cfg(target_os = "linux")]
            let script_name = "setup-ubuntu.sh";
            #[cfg(not(any(target_os = "macos", target_os = "linux")))]
            {
                return Err("Installer is not supported on this platform".into());
            }

            let script = resolve_setup_script(&app_handle, script_name)
                .ok_or_else(|| format!("Setup script '{script_name}' not found"))?;
            let script_path = script.to_string_lossy().to_string();
            format!("bash '{}'", shell_escape_single_quoted(&script_path))
        }
        _ => return Err(format!("Unknown tool: {tool}")),
    };

    open_terminal(&command)
}

#[tauri::command]
fn get_notes_dir(state: State<AppState>) -> Result<String, String> {
    let dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
    Ok(dir.clone())
}

#[tauri::command]
fn set_notes_dir(
    state: State<AppState>,
    app_handle: tauri::AppHandle,
    path: String,
) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;

    // Flush and shut down the old git worker.
    let old_git = {
        let git = state.git.lock().map_err(|e| e.to_string())?;
        git.clone()
    };
    old_git.flush_and_push();
    old_git.shutdown();

    // Shut down the old qmd worker.
    if let Ok(old_qmd) = state.qmd.lock() {
        old_qmd.shutdown();
    }

    // Shut down old recording worker.
    if let Ok(old_rec) = state.recording.lock() {
        old_rec.shutdown();
    }

    {
        let mut dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
        *dir = path.clone();
    }

    // Rebuild index for new directory.
    {
        let mut index = state.index.lock().map_err(|e| e.to_string())?;
        *index = notes::rebuild_index(&path).map_err(|e| e.to_string())?;
    }

    // Start and store a new git worker for the new directory.
    let new_git = GitSyncHandle::new(&path, app_handle.clone());
    let mut git = state.git.lock().map_err(|e| e.to_string())?;
    *git = new_git;

    // Reload model settings for new directory.
    let new_model_settings = load_model_settings(&path);
    {
        let mut ms = state.model_settings.lock().map_err(|e| e.to_string())?;
        *ms = new_model_settings.clone();
    }

    // Start a new qmd worker for the new directory.
    let new_qmd = QmdHandle::new(&path, app_handle.clone(), new_model_settings.keyword_model);
    let mut qmd = state.qmd.lock().map_err(|e| e.to_string())?;
    *qmd = new_qmd;

    // Start a new recording worker.
    let new_rec = RecordingHandle::new(app_handle);
    let mut rec = state.recording.lock().map_err(|e| e.to_string())?;
    *rec = new_rec;

    Ok(())
}

#[tauri::command]
fn save_note(
    state: State<AppState>,
    id: Option<String>,
    content: String,
    tags: Vec<String>,
    title: Option<String>,
) -> Result<NoteMetadata, String> {
    let is_new = id.is_none();
    // Get old tags before saving to detect changes.
    let old_tags = id.as_ref().and_then(|existing_id| {
        state
            .index
            .lock()
            .ok()
            .and_then(|idx| idx.notes.get(existing_id).map(|m| m.tags.clone()))
    });
    let meta = {
        let dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
        let mut index = state.index.lock().map_err(|e| e.to_string())?;
        notes::save_note(&dir, id, &content, &tags, title, &mut index).map_err(|e| e.to_string())?
    };
    let git = state.git.lock().map_err(|e| e.to_string())?;
    git.notify_change(&meta.path, &meta.title, is_new);
    // Only notify QMD when tags changed or it's a new note (needs auto-tagging).
    let tags_changed = is_new || old_tags.as_ref() != Some(&tags);
    if tags_changed {
        if let Ok(qmd) = state.qmd.lock() {
            qmd.notify_change(&meta.id, &meta.title);
        }
    }
    Ok(meta)
}

#[tauri::command]
fn delete_note(state: State<AppState>, id: String) -> Result<(), String> {
    let path = {
        let dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
        let mut index = state.index.lock().map_err(|e| e.to_string())?;
        let path = index.notes.get(&id).map(|m| m.path.clone());
        notes::delete_note(&dir, &id, &mut index).map_err(|e| e.to_string())?;
        path
    };
    if let Some(path) = path {
        let git = state.git.lock().map_err(|e| e.to_string())?;
        git.notify_change(&path, "deleted", false);
    }
    if let Ok(qmd) = state.qmd.lock() {
        qmd.notify_delete(&id);
    }
    Ok(())
}

#[tauri::command]
fn get_note(state: State<AppState>, id: String) -> Result<notes::NoteContent, String> {
    let dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
    let index = state.index.lock().map_err(|e| e.to_string())?;
    notes::get_note(&dir, &id, &index).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_recent_notes(
    state: State<AppState>,
    limit: usize,
    sort_by: Option<String>,
) -> Result<Vec<NoteMetadata>, String> {
    let index = state.index.lock().map_err(|e| e.to_string())?;
    Ok(notes::list_recent_notes(
        &index,
        limit,
        sort_by.as_deref().unwrap_or("created"),
    ))
}

#[tauri::command]
fn search_notes(state: State<AppState>, query: String) -> Result<Vec<NoteMetadata>, String> {
    let dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
    let index = state.index.lock().map_err(|e| e.to_string())?;
    notes::search_notes(&dir, &query, &index).map_err(|e| e.to_string())
}

#[tauri::command]
fn rebuild_index(state: State<AppState>) -> Result<(), String> {
    let dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
    let mut index = state.index.lock().map_err(|e| e.to_string())?;
    *index = notes::rebuild_index(&dir).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_all_tags(state: State<AppState>) -> Result<Vec<String>, String> {
    let index = state.index.lock().map_err(|e| e.to_string())?;
    Ok(notes::get_all_tags(&index))
}

#[tauri::command]
fn toggle_star(state: State<AppState>, id: String) -> Result<NoteMetadata, String> {
    let meta = {
        let dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
        let mut index = state.index.lock().map_err(|e| e.to_string())?;
        notes::toggle_star(&dir, &id, &mut index).map_err(|e| e.to_string())?
    };
    let git = state.git.lock().map_err(|e| e.to_string())?;
    git.notify_change(&meta.path, &meta.title, false);
    Ok(meta)
}

#[tauri::command]
fn import_markdown_file(
    state: State<AppState>,
    source_path: String,
) -> Result<NoteMetadata, String> {
    let meta = {
        let dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
        let mut index = state.index.lock().map_err(|e| e.to_string())?;
        notes::import_markdown_file(&dir, &source_path, &mut index).map_err(|e| e.to_string())?
    };
    let git = state.git.lock().map_err(|e| e.to_string())?;
    git.notify_change(&meta.path, &meta.title, true);
    if let Ok(qmd) = state.qmd.lock() {
        qmd.notify_change(&meta.id, &meta.title);
    }
    Ok(meta)
}

#[tauri::command]
fn list_input_devices() -> Vec<recording::InputDeviceInfo> {
    recording::list_input_devices()
}

#[tauri::command]
fn start_recording(
    state: State<AppState>,
    device: Option<String>,
    note_id: Option<String>,
) -> Result<String, String> {
    let rec = state.recording.lock().map_err(|e| e.to_string())?;
    if rec.state().active {
        return Err("Recording already in progress".to_string());
    }
    let note_id = note_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let notes_dir = state.notes_dir.lock().map_err(|e| e.to_string())?.clone();
    let ms = state.model_settings.lock().map_err(|e| e.to_string())?;
    rec.start(
        &note_id,
        &notes_dir,
        device,
        ms.summary_model.clone(),
        ms.whisper_model.clone(),
    );
    Ok(note_id)
}

#[tauri::command]
fn append_meeting_data(
    state: State<AppState>,
    id: String,
    summary: String,
    transcript: String,
) -> Result<NoteMetadata, String> {
    let (meta, tags_changed) = {
        let dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
        let mut index = state.index.lock().map_err(|e| e.to_string())?;
        let old_tags = index
            .notes
            .get(&id)
            .map(|m| m.tags.clone())
            .unwrap_or_default();
        let meta = notes::append_meeting_data(&dir, &id, &summary, &transcript, &mut index)
            .map_err(|e| e.to_string())?;
        let tags_changed = old_tags != meta.tags;
        (meta, tags_changed)
    };

    let git = state.git.lock().map_err(|e| e.to_string())?;
    git.notify_change(&meta.path, &meta.title, false);
    if tags_changed {
        if let Ok(qmd) = state.qmd.lock() {
            qmd.notify_change(&meta.id, &meta.title);
        }
    }
    Ok(meta)
}

#[tauri::command]
async fn retranscribe_note(state: State<'_, AppState>, id: String) -> Result<NoteMetadata, String> {
    let (notes_dir, audio_path, whisper_model) = {
        let dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
        let ms = state.model_settings.lock().map_err(|e| e.to_string())?;
        let audio_path = std::path::Path::new(&*dir)
            .join("meetings")
            .join(".audio")
            .join(format!("{id}.wav"));
        (dir.clone(), audio_path, ms.whisper_model.clone())
    };

    if !audio_path.exists() {
        return Err(format!("Audio file not found: {}", audio_path.display()));
    }

    let transcript = recording::transcribe(&audio_path, whisper_model.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    let meta = {
        let mut index = state.index.lock().map_err(|e| e.to_string())?;
        notes::replace_meeting_transcript(&notes_dir, &id, &transcript, &mut index)
            .map_err(|e| e.to_string())?
    };

    let git = state.git.lock().map_err(|e| e.to_string())?;
    git.notify_change(&meta.path, &meta.title, false);
    Ok(meta)
}

#[tauri::command]
async fn resummarize_note(state: State<'_, AppState>, id: String) -> Result<NoteMetadata, String> {
    let (notes_dir, transcript, summary_model) = {
        let dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
        let ms = state.model_settings.lock().map_err(|e| e.to_string())?;
        let index = state.index.lock().map_err(|e| e.to_string())?;
        let transcript =
            notes::get_note_transcript(&dir, &id, &index).map_err(|e| e.to_string())?;
        (dir.clone(), transcript, ms.summary_model.clone())
    };

    let summary = recording::summarize(&transcript, summary_model.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    let meta = {
        let mut index = state.index.lock().map_err(|e| e.to_string())?;
        notes::replace_meeting_summary(&notes_dir, &id, &summary, &mut index)
            .map_err(|e| e.to_string())?
    };

    let git = state.git.lock().map_err(|e| e.to_string())?;
    git.notify_change(&meta.path, &meta.title, false);
    Ok(meta)
}

#[tauri::command]
fn stop_recording(state: State<AppState>) -> Result<(), String> {
    let rec = state.recording.lock().map_err(|e| e.to_string())?;
    rec.stop();
    Ok(())
}

#[tauri::command]
fn get_recording_state(state: State<AppState>) -> Result<recording::RecordingState, String> {
    let rec = state.recording.lock().map_err(|e| e.to_string())?;
    Ok(rec.state())
}

#[tauri::command]
async fn check_pending_jobs(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let notes_dir = state.notes_dir.lock().map_err(|e| e.to_string())?.clone();
    recording::resume_pending_jobs(&app_handle, &notes_dir).await;
    Ok(())
}

#[tauri::command]
fn get_model_settings(state: State<AppState>) -> Result<ModelSettings, String> {
    let settings = state.model_settings.lock().map_err(|e| e.to_string())?;
    Ok(settings.clone())
}

#[tauri::command]
fn set_model_settings(state: State<AppState>, settings: ModelSettings) -> Result<(), String> {
    let notes_dir = state.notes_dir.lock().map_err(|e| e.to_string())?.clone();
    save_model_settings(&notes_dir, &settings);
    let mut current = state.model_settings.lock().map_err(|e| e.to_string())?;
    *current = settings;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct OllamaModelInfo {
    pub name: String,
    pub size_bytes: Option<u64>,
    pub installed: bool,
    pub parameter_size: Option<String>,
}

#[tauri::command]
async fn list_ollama_models() -> Result<Vec<OllamaModelInfo>, String> {
    let mut models: Vec<OllamaModelInfo> = Vec::new();
    let mut installed_names: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Query ollama REST API for installed models.
    if let Ok(resp) = reqwest::get("http://localhost:11434/api/tags").await {
        if let Ok(json) = resp.json::<serde_json::Value>().await {
            if let Some(arr) = json.get("models").and_then(|v| v.as_array()) {
                for m in arr {
                    let name = m
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let size = m.get("size").and_then(|v| v.as_u64());
                    let param_size = m
                        .get("details")
                        .and_then(|d| d.get("parameter_size"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    if !name.is_empty() {
                        installed_names.insert(name.clone());
                        models.push(OllamaModelInfo {
                            name,
                            size_bytes: size,
                            installed: true,
                            parameter_size: param_size,
                        });
                    }
                }
            }
        }
    }

    // Add recommended models that aren't installed.
    let recommended = [
        ("llama3.2", "2.0B", 2_000_000_000u64),
        ("mistral", "7.2B", 4_100_000_000),
        ("qwen2.5:7b", "7.6B", 4_700_000_000),
        ("qwen2.5:1.5b", "1.5B", 986_000_000),
        ("gemma2:2b", "2.6B", 1_600_000_000),
        ("phi3:mini", "3.8B", 2_300_000_000),
    ];
    for (name, param, approx_size) in recommended {
        if !installed_names.contains(name) {
            models.push(OllamaModelInfo {
                name: name.to_string(),
                size_bytes: Some(approx_size),
                installed: false,
                parameter_size: Some(param.to_string()),
            });
        }
    }

    Ok(models)
}

#[derive(Debug, Clone, Serialize)]
pub struct WhisperModelInfo {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
}

#[tauri::command]
async fn list_whisper_models() -> Result<Vec<WhisperModelInfo>, String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/Users/default".to_string());
    let search_dirs = [
        format!("{home}/.local/share/whisper-cpp/models"),
        format!("{home}/whisper.cpp/models"),
        "/opt/homebrew/share/whisper-cpp/models".to_string(),
        format!("{home}/Library/Application Support/com.pais.handy/models"),
    ];

    let mut models = Vec::new();
    for dir in &search_dirs {
        let dir_path = std::path::Path::new(dir);
        if !dir_path.is_dir() {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(dir_path) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map(|e| e == "bin").unwrap_or(false) {
                    let name = path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    let path_str = path.to_string_lossy().to_string();
                    models.push(WhisperModelInfo {
                        name,
                        path: path_str,
                        size_bytes: size,
                    });
                }
            }
        }
    }

    // Sort by size descending (larger = better quality).
    models.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    Ok(models)
}

#[derive(Debug, Clone, Serialize)]
struct OllamaPullProgress {
    model: String,
    status: String,
    completed: Option<u64>,
    total: Option<u64>,
}

#[tauri::command]
async fn pull_ollama_model(app_handle: tauri::AppHandle, name: String) -> Result<(), String> {
    use futures_util::StreamExt;

    let client = reqwest::Client::new();
    let resp = client
        .post("http://localhost:11434/api/pull")
        .json(&serde_json::json!({ "name": &name }))
        .send()
        .await
        .map_err(|e| format!("Failed to connect to ollama: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("ollama pull failed: HTTP {}", resp.status()));
    }

    let mut stream = resp.bytes_stream();
    let mut buf = Vec::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream error: {e}"))?;
        buf.extend_from_slice(&chunk);

        // Process complete NDJSON lines
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            if let Ok(json) = serde_json::from_str::<serde_json::Value>(line) {
                let status = json
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let completed = json.get("completed").and_then(|v| v.as_u64());
                let total = json.get("total").and_then(|v| v.as_u64());

                if let Some(error) = json.get("error").and_then(|v| v.as_str()) {
                    return Err(format!("ollama pull failed: {error}"));
                }

                let _ = app_handle.emit(
                    "ollama-pull-progress",
                    OllamaPullProgress {
                        model: name.clone(),
                        status: status.clone(),
                        completed,
                        total,
                    },
                );
            }
        }
    }

    // Process any remaining data in buffer
    if !buf.is_empty() {
        let line = String::from_utf8_lossy(&buf);
        let line = line.trim();
        if !line.is_empty() {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(error) = json.get("error").and_then(|v| v.as_str()) {
                    return Err(format!("ollama pull failed: {error}"));
                }
                let status = json
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let completed = json.get("completed").and_then(|v| v.as_u64());
                let total = json.get("total").and_then(|v| v.as_u64());
                let _ = app_handle.emit(
                    "ollama-pull-progress",
                    OllamaPullProgress {
                        model: name.clone(),
                        status,
                        completed,
                        total,
                    },
                );
            }
        }
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let home = dirs_home();
    let default_dir = format!("{}/notes", home);
    let _ = std::fs::create_dir_all(&default_dir);

    let index = notes::rebuild_index(&default_dir).unwrap_or_default();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let model_settings = load_model_settings(&default_dir);
            let git = GitSyncHandle::new(&default_dir, handle.clone());
            let qmd = QmdHandle::new(
                &default_dir,
                handle.clone(),
                model_settings.keyword_model.clone(),
            );
            let rec = RecordingHandle::new(handle);
            app.manage(AppState {
                notes_dir: Mutex::new(default_dir),
                index: Mutex::new(index),
                git: Mutex::new(git),
                qmd: Mutex::new(qmd),
                recording: Mutex::new(rec),
                model_settings: Mutex::new(model_settings),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_notes_dir,
            set_notes_dir,
            save_note,
            delete_note,
            get_note,
            list_recent_notes,
            search_notes,
            rebuild_index,
            get_all_tags,
            toggle_star,
            import_markdown_file,
            git_sync::get_git_remote,
            git_sync::set_git_remote,
            git_sync::dismiss_git_setup,
            qmd::get_related_notes,
            qmd::regenerate_tags,
            qmd::check_tools,
            list_input_devices,
            start_recording,
            append_meeting_data,
            retranscribe_note,
            resummarize_note,
            stop_recording,
            get_recording_state,
            check_pending_jobs,
            get_model_settings,
            set_model_settings,
            list_ollama_models,
            list_whisper_models,
            pull_ollama_model,
            open_tool_installer,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if let RunEvent::ExitRequested { .. } = &event {
            let state = handle.state::<AppState>();
            let git = state.git.lock().ok().map(|g| g.clone());
            let qmd = state.qmd.lock().ok().map(|q| q.clone());
            let rec = state.recording.lock().ok().map(|r| r.clone());
            drop(state);
            if let Some(rec) = rec {
                rec.shutdown();
            }
            if let Some(git) = git {
                git.flush_and_push();
            }
            if let Some(qmd) = qmd {
                qmd.shutdown();
            }
        }
    });
}

fn dirs_home() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string())
}
