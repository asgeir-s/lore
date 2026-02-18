mod git_sync;
mod notes;
mod qmd;
mod recording;

use git_sync::GitSyncHandle;
use notes::{NoteIndex, NoteMetadata};
use qmd::QmdHandle;
use recording::RecordingHandle;
use std::sync::Mutex;
use tauri::{Manager, RunEvent, State};

pub struct AppState {
    pub notes_dir: Mutex<String>,
    pub index: Mutex<NoteIndex>,
    pub git: Mutex<GitSyncHandle>,
    pub qmd: Mutex<QmdHandle>,
    pub recording: Mutex<RecordingHandle>,
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

    // Start a new qmd worker for the new directory.
    let new_qmd = QmdHandle::new(&path, app_handle.clone());
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
        state.index.lock().ok()
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
    Ok(meta)
}

#[tauri::command]
fn list_input_devices() -> Vec<recording::InputDeviceInfo> {
    recording::list_input_devices()
}

#[tauri::command]
fn start_recording(state: State<AppState>, device: Option<String>, note_id: Option<String>) -> Result<String, String> {
    let rec = state.recording.lock().map_err(|e| e.to_string())?;
    if rec.state().active {
        return Err("Recording already in progress".to_string());
    }
    let note_id = note_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let notes_dir = state.notes_dir.lock().map_err(|e| e.to_string())?.clone();
    rec.start(&note_id, &notes_dir, device);
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
async fn check_pending_jobs(state: State<'_, AppState>, app_handle: tauri::AppHandle) -> Result<(), String> {
    let notes_dir = state.notes_dir.lock().map_err(|e| e.to_string())?.clone();
    recording::resume_pending_jobs(&app_handle, &notes_dir).await;
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
            let git = GitSyncHandle::new(&default_dir, handle.clone());
            let qmd = QmdHandle::new(&default_dir, handle.clone());
            let rec = RecordingHandle::new(handle);
            app.manage(AppState {
                notes_dir: Mutex::new(default_dir),
                index: Mutex::new(index),
                git: Mutex::new(git),
                qmd: Mutex::new(qmd),
                recording: Mutex::new(rec),
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
            stop_recording,
            get_recording_state,
            check_pending_jobs,
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
