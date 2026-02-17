mod git_sync;
mod notes;

use git_sync::GitSyncHandle;
use notes::{NoteIndex, NoteMetadata};
use std::sync::Mutex;
use tauri::{Manager, RunEvent, State};

pub struct AppState {
    pub notes_dir: Mutex<String>,
    pub index: Mutex<NoteIndex>,
    pub git: Mutex<GitSyncHandle>,
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
    let new_git = GitSyncHandle::new(&path, app_handle);
    let mut git = state.git.lock().map_err(|e| e.to_string())?;
    *git = new_git;

    Ok(())
}

#[tauri::command]
fn save_note(
    state: State<AppState>,
    id: Option<String>,
    content: String,
    tags: Vec<String>,
) -> Result<NoteMetadata, String> {
    let is_new = id.is_none();
    let meta = {
        let dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
        let mut index = state.index.lock().map_err(|e| e.to_string())?;
        notes::save_note(&dir, id, &content, &tags, &mut index).map_err(|e| e.to_string())?
    };
    let git = state.git.lock().map_err(|e| e.to_string())?;
    git.notify_change(&meta.path, &meta.title, is_new);
    Ok(meta)
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
            let git = GitSyncHandle::new(&default_dir, handle);
            app.manage(AppState {
                notes_dir: Mutex::new(default_dir),
                index: Mutex::new(index),
                git: Mutex::new(git),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_notes_dir,
            set_notes_dir,
            save_note,
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
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if let RunEvent::ExitRequested { .. } = &event {
            let state: State<AppState> = handle.state();
            if let Ok(git) = state.git.lock() {
                let git = git.clone();
                git.flush_and_push();
            }
        }
    });
}

fn dirs_home() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string())
}
