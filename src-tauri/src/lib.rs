mod notes;

use notes::{NoteIndex, NoteMetadata};
use std::sync::Mutex;
use tauri::State;

pub struct AppState {
    pub notes_dir: Mutex<String>,
    pub index: Mutex<NoteIndex>,
}

#[tauri::command]
fn get_notes_dir(state: State<AppState>) -> Result<String, String> {
    let dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
    Ok(dir.clone())
}

#[tauri::command]
fn set_notes_dir(state: State<AppState>, path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    let mut dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
    *dir = path.clone();
    // Rebuild index for new directory
    let mut index = state.index.lock().map_err(|e| e.to_string())?;
    *index = notes::rebuild_index(&path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn save_note(
    state: State<AppState>,
    id: Option<String>,
    content: String,
    tags: Vec<String>,
) -> Result<NoteMetadata, String> {
    let dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
    let mut index = state.index.lock().map_err(|e| e.to_string())?;
    let meta = notes::save_note(&dir, id, &content, &tags, &mut index)
        .map_err(|e| e.to_string())?;
    Ok(meta)
}

#[tauri::command]
fn get_note(state: State<AppState>, id: String) -> Result<notes::NoteContent, String> {
    let dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
    let index = state.index.lock().map_err(|e| e.to_string())?;
    notes::get_note(&dir, &id, &index).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_recent_notes(state: State<AppState>, limit: usize) -> Result<Vec<NoteMetadata>, String> {
    let index = state.index.lock().map_err(|e| e.to_string())?;
    Ok(notes::list_recent_notes(&index, limit))
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
    let dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
    let mut index = state.index.lock().map_err(|e| e.to_string())?;
    notes::toggle_star(&dir, &id, &mut index).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let home = dirs_home();
    let default_dir = format!("{}/dump", home);
    let _ = std::fs::create_dir_all(&default_dir);

    let index = notes::rebuild_index(&default_dir).unwrap_or_default();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            notes_dir: Mutex::new(default_dir),
            index: Mutex::new(index),
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn dirs_home() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string())
}
