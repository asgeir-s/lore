use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, Manager, State};
use tokio::process::Command;
use tokio::sync::{mpsc, RwLock};
use tokio::time::{Duration, Instant};

const DEBOUNCE: Duration = Duration::from_secs(5);
const REINDEX_INTERVAL: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelatedEntry {
    pub id: String,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct RelatedCache {
    generation: u64,
    relations: HashMap<String, CacheEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheEntry {
    gen: u64,
    entries: Vec<RelatedEntry>,
}

enum Msg {
    NoteChanged { id: String, title: String },
    NoteDeleted { id: String },
    Shutdown,
}

#[derive(Clone)]
pub struct QmdHandle {
    tx: mpsc::UnboundedSender<Msg>,
    cache: Arc<RwLock<RelatedCache>>,
}

impl QmdHandle {
    pub fn new(notes_dir: &str, app_handle: tauri::AppHandle) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let dir = PathBuf::from(notes_dir);
        let cache_path = dir.join(".dump-related.json");

        let cache = load_cache(&cache_path);
        let cache = Arc::new(RwLock::new(cache));
        let worker_cache = cache.clone();

        tauri::async_runtime::spawn(async move {
            run_worker(rx, dir, app_handle, worker_cache).await;
        });

        Self { tx, cache }
    }

    pub fn notify_change(&self, id: &str, title: &str) {
        let _ = self.tx.send(Msg::NoteChanged {
            id: id.to_string(),
            title: title.to_string(),
        });
    }

    pub fn notify_delete(&self, id: &str) {
        let _ = self.tx.send(Msg::NoteDeleted {
            id: id.to_string(),
        });
    }

    pub fn shutdown(&self) {
        let _ = self.tx.send(Msg::Shutdown);
    }

    pub async fn get_related(&self, id: &str) -> Vec<RelatedEntry> {
        let cache = self.cache.read().await;
        cache.relations.get(id).map(|e| e.entries.clone()).unwrap_or_default()
    }
}

fn load_cache(path: &Path) -> RelatedCache {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_cache(path: &Path, cache: &RelatedCache) {
    if let Ok(json) = serde_json::to_string_pretty(cache) {
        let _ = std::fs::write(path, json);
    }
}

async fn qmd_available() -> bool {
    Command::new("qmd")
        .arg("--version")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

async fn qmd(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("qmd")
        .args(args)
        .current_dir(dir)
        .output()
        .await
        .map_err(|e| format!("failed to run qmd: {e}"))?;

    if output.status.success() {
        let raw = String::from_utf8_lossy(&output.stdout).to_string();
        Ok(strip_ansi(&raw))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Err(stderr)
    }
}

/// Strip ANSI escape sequences from qmd output (spinner, colors, cursor movement).
fn strip_ansi(s: &str) -> String {
    let re = regex::Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07").unwrap();
    re.replace_all(s, "").to_string()
}

async fn run_worker(
    mut rx: mpsc::UnboundedReceiver<Msg>,
    dir: PathBuf,
    app_handle: tauri::AppHandle,
    cache: Arc<RwLock<RelatedCache>>,
) {
    if !qmd_available().await {
        eprintln!("qmd: not installed, entering drain mode");
        // Drain all messages silently.
        while rx.recv().await.is_some() {}
        return;
    }

    // Initialize qmd collection.
    let dir_str = dir.to_string_lossy().to_string();
    if let Err(e) = qmd(&dir, &["collection", "add", &dir_str, "--name", "notes", "--mask", "*.md"]).await {
        eprintln!("qmd: collection add failed (may already exist): {e}");
    }
    if let Err(e) = qmd(&dir, &["update"]).await {
        eprintln!("qmd: initial update failed: {e}");
    }
    if let Err(e) = qmd(&dir, &["embed"]).await {
        eprintln!("qmd: initial embed failed: {e}");
    }

    let has_ollama = ollama_available().await;
    if has_ollama {
        eprintln!("qmd: ollama available, using {OLLAMA_MODEL} for keyword extraction");
    } else {
        eprintln!("qmd: ollama not available, using title-only queries");
    }

    let cache_path = dir.join(".dump-related.json");
    let mut pending: HashMap<String, String> = HashMap::new();
    let mut deadline: Option<Instant> = None;
    let mut last_reindex = Instant::now();

    loop {
        let msg = if let Some(dl) = deadline {
            tokio::select! {
                msg = rx.recv() => msg,
                _ = tokio::time::sleep_until(dl) => {
                    process_pending(&dir, &mut pending, &cache, &cache_path, &app_handle, has_ollama).await;
                    deadline = None;
                    last_reindex = Instant::now();
                    continue;
                }
            }
        } else {
            tokio::select! {
                msg = rx.recv() => msg,
                _ = tokio::time::sleep(REINDEX_INTERVAL.saturating_sub(last_reindex.elapsed())) => {
                    // Periodic re-embed to stay current.
                    if let Err(e) = qmd(&dir, &["embed"]).await {
                        eprintln!("qmd: periodic embed failed: {e}");
                    }
                    last_reindex = Instant::now();
                    continue;
                }
            }
        };

        match msg {
            Some(Msg::NoteChanged { id, title }) => {
                pending.insert(id, title);
                deadline = Some(Instant::now() + DEBOUNCE);
            }
            Some(Msg::NoteDeleted { id }) => {
                pending.remove(&id);
                let mut c = cache.write().await;
                c.relations.remove(&id);
                // Prune deleted note from other notes' lists.
                for entry in c.relations.values_mut() {
                    entry.entries.retain(|e| e.id != id);
                }
                save_cache(&cache_path, &c);
                let _ = app_handle.emit("related-notes-changed", ());
            }
            Some(Msg::Shutdown) => {
                if !pending.is_empty() {
                    process_pending(&dir, &mut pending, &cache, &cache_path, &app_handle, has_ollama).await;
                }
                break;
            }
            None => {
                if !pending.is_empty() {
                    process_pending(&dir, &mut pending, &cache, &cache_path, &app_handle, has_ollama).await;
                }
                break;
            }
        }
    }
}

async fn process_pending(
    dir: &Path,
    pending: &mut HashMap<String, String>,
    cache: &Arc<RwLock<RelatedCache>>,
    cache_path: &Path,
    app_handle: &tauri::AppHandle,
    has_ollama: bool,
) {
    if pending.is_empty() {
        return;
    }

    // Update and embed incrementally.
    if let Err(e) = qmd(dir, &["update"]).await {
        eprintln!("qmd: update failed: {e}");
    }
    if let Err(e) = qmd(dir, &["embed"]).await {
        eprintln!("qmd: embed failed: {e}");
    }

    let items: Vec<(String, String)> = pending.drain().collect();

    // Advance the generation counter — any cached entry with an older gen is stale.
    {
        let mut c = cache.write().await;
        c.generation += 1;
        eprintln!("qmd: generation now {}", c.generation);
    }

    // Build maps from the note index.
    let (path_to_id, id_to_path) = build_maps(app_handle);

    for (note_id, title) in &items {
        let query_text = build_query(dir, title, id_to_path.get(note_id), has_ollama).await;
        if query_text.trim().is_empty() {
            continue;
        }
        eprintln!("qmd: query for '{}': {}", &note_id[..8.min(note_id.len())], &query_text[..100.min(query_text.len())]);

        match qmd(dir, &["query", &query_text, "--json", "-n", "10", "--min-score", "0.35"]).await {
            Ok(output) => {
                let json_preview = extract_json(&output).unwrap_or("(no JSON)");
                let preview_len = json_preview.len().min(200);
                eprintln!("qmd: raw for '{}': {}", &note_id[..8.min(note_id.len())], &json_preview[..preview_len]);
                let mut entries = parse_qmd_results(&output, &path_to_id, note_id);
                entries.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
                eprintln!("qmd: results for '{}': {} matches{}", &note_id[..8.min(note_id.len())], entries.len(),
                    entries.iter().take(5).map(|e| format!(" {:.2}={}", e.score, &e.id[..8.min(e.id.len())])).collect::<String>());
                let mut c = cache.write().await;
                let gen = c.generation;
                c.relations.insert(note_id.clone(), CacheEntry { gen, entries });
            }
            Err(e) => {
                eprintln!("qmd: query failed for '{}': {e}", note_id);
            }
        }
    }

    let c = cache.read().await;
    save_cache(cache_path, &c);
    let _ = app_handle.emit("related-notes-changed", ());
}

/// Normalize a filename for fuzzy matching: collapse runs of `_` and `-` into a single `-`.
/// e.g. `20260217223736-jeg_liker_dyr.md` → `20260217223736-jeg-liker-dyr.md`
/// and  `20260217230442-er_har_vi_noen_dyr_som_bor_i_gammmle_hus__ikke_i_n.md`
///    → `20260217230442-er-har-vi-noen-dyr-som-bor-i-gammmle-hus-ikke-i-n.md`
fn normalize_filename(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_sep = false;
    for c in s.chars() {
        if c == '_' || c == '-' {
            if !prev_sep {
                out.push('-');
            }
            prev_sep = true;
        } else {
            prev_sep = false;
            out.push(c);
        }
    }
    out
}

fn build_maps(app_handle: &tauri::AppHandle) -> (HashMap<String, String>, HashMap<String, String>) {
    let mut path_to_id = HashMap::new();
    let mut id_to_path = HashMap::new();
    if let Some(state) = app_handle.try_state::<AppState>() {
        if let Ok(index) = state.index.lock() {
            for (id, meta) in &index.notes {
                path_to_id.insert(meta.path.clone(), id.clone());
                id_to_path.insert(id.clone(), meta.path.clone());
                if let Some(fname) = Path::new(&meta.path).file_name() {
                    let fname_str = fname.to_string_lossy().to_string();
                    path_to_id.insert(fname_str.clone(), id.clone());
                    // Also store a normalized variant for fuzzy matching.
                    let normalized = normalize_filename(&fname_str);
                    if normalized != fname_str {
                        path_to_id.insert(normalized, id.clone());
                    }
                }
            }
            eprintln!("qmd: build_maps: {} notes indexed", index.notes.len());
        } else {
            eprintln!("qmd: build_maps: failed to lock index");
        }
    } else {
        eprintln!("qmd: build_maps: no AppState available");
    }
    (path_to_id, id_to_path)
}

/// Build a search query by asking ollama to extract key topics, falling back to title only.
async fn build_query(dir: &Path, title: &str, rel_path: Option<&String>, has_ollama: bool) -> String {
    if !has_ollama {
        return title.to_string();
    }
    if let Some(path) = rel_path {
        let full_path = dir.join(path);
        if let Ok(content) = std::fs::read_to_string(&full_path) {
            let body = strip_frontmatter(&content);
            // Limit to ~2000 chars to keep the prompt short and fast.
            let truncated: String = body.chars().take(2000).collect();
            if truncated.trim().len() > 20 {
                if let Some(keywords) = ollama_extract_keywords(&truncated).await {
                    return format!("{} {}", title, keywords);
                }
            }
        }
    }
    title.to_string()
}

fn strip_frontmatter(content: &str) -> &str {
    let trimmed = content.trim_start();
    if trimmed.starts_with("---") {
        if let Some(rest) = trimmed.strip_prefix("---") {
            if let Some(end) = rest.find("\n---") {
                return &rest[end + 4..];
            }
        }
    }
    content
}

const OLLAMA_MODEL: &str = "qwen2.5:1.5b";

async fn ollama_available() -> bool {
    // Check if ollama binary exists.
    if Command::new("ollama").arg("--version").output().await.is_err() {
        return false;
    }

    // Check if model is available (also tests if server is running).
    if let Ok(o) = Command::new("ollama").args(["show", OLLAMA_MODEL]).output().await {
        if o.status.success() {
            return true;
        }
        // Server might not be running — try starting it.
        let stderr = String::from_utf8_lossy(&o.stderr);
        if stderr.contains("could not connect") {
            eprintln!("qmd: starting ollama serve...");
            let _ = Command::new("ollama").arg("serve").spawn();
            // Give it a moment to start.
            tokio::time::sleep(Duration::from_secs(2)).await;
            // Retry.
            return Command::new("ollama")
                .args(["show", OLLAMA_MODEL])
                .output()
                .await
                .map(|o| o.status.success())
                .unwrap_or(false);
        }
    }
    false
}

async fn ollama_extract_keywords(text: &str) -> Option<String> {
    let preview: String = text.chars().take(60).collect();
    eprintln!("qmd: ollama → \"{}...\"", preview.replace('\n', " "));

    let prompt = format!(
        "What is this text about? Reply with exactly 5 topic words separated by commas. No explanation, no formatting.\n\n{}",
        text
    );
    let output = Command::new("ollama")
        .args(["run", OLLAMA_MODEL, &prompt])
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        eprintln!("qmd: ollama failed");
        return None;
    }

    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    // Strip markdown bold/italic and take only the first line.
    let result: String = raw
        .lines()
        .next()
        .unwrap_or("")
        .replace("**", "")
        .replace('*', "")
        .replace('`', "");
    if result.is_empty() || result.len() > 200 {
        eprintln!("qmd: ollama returned empty/too long");
        return None;
    }
    eprintln!("qmd: ollama ← \"{}\"", result);
    Some(result)
}

/// Extract the JSON portion from qmd output, which may contain spinner text before the actual JSON.
fn extract_json(output: &str) -> Option<&str> {
    // Find the first '[' or '{' that starts the JSON payload.
    let start = output.find('[').or_else(|| output.find('{'))?;
    let candidate = &output[start..];
    // Find the matching end by searching from the end of the string.
    let end_char = if candidate.starts_with('[') { ']' } else { '}' };
    let end = candidate.rfind(end_char)?;
    Some(&candidate[..=end])
}

fn parse_qmd_results(
    output: &str,
    path_to_id: &HashMap<String, String>,
    exclude_id: &str,
) -> Vec<RelatedEntry> {
    let mut entries = Vec::new();

    // Extract JSON from potentially noisy output (spinner text, progress bars, etc.).
    let json_str = match extract_json(output) {
        Some(s) => s,
        None => {
            if !output.trim().is_empty() {
                eprintln!("qmd: no JSON found in output: {}", &output[..output.len().min(200)]);
            }
            return entries;
        }
    };

    if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) {
        if let Some(arr) = val.as_array() {
            for item in arr {
                if let Some(entry) = extract_entry(item, path_to_id, exclude_id) {
                    entries.push(entry);
                }
            }
            return entries;
        }
        // Single object
        if let Some(entry) = extract_entry(&val, path_to_id, exclude_id) {
            entries.push(entry);
        }
        if !entries.is_empty() {
            return entries;
        }
    }

    // Try line-by-line JSON (NDJSON) as last resort.
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(entry) = extract_entry(&val, path_to_id, exclude_id) {
                entries.push(entry);
            }
        }
    }

    if entries.is_empty() && !output.trim().is_empty() {
        eprintln!("qmd: could not parse results: {}", &json_str[..json_str.len().min(200)]);
    }

    entries
}

fn extract_entry(
    val: &serde_json::Value,
    path_to_id: &HashMap<String, String>,
    exclude_id: &str,
) -> Option<RelatedEntry> {
    let score = val
        .get("score")
        .or_else(|| val.get("similarity"))
        .or_else(|| val.get("rank"))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);

    // Try to extract the note ID directly from the snippet frontmatter.
    if let Some(snippet) = val.get("snippet").and_then(|v| v.as_str()) {
        if let Some(id) = extract_id_from_snippet(snippet) {
            if id != exclude_id {
                return Some(RelatedEntry { id, score });
            }
            return None;
        }
    }

    // Fall back to resolving file path → note ID.
    let path_str = val
        .get("path")
        .or_else(|| val.get("filepath"))
        .or_else(|| val.get("file"))
        .or_else(|| val.get("document"))
        .and_then(|v| v.as_str())?;

    let id = resolve_path_to_id(path_str, path_to_id)?;

    if id == exclude_id {
        return None;
    }

    Some(RelatedEntry { id, score })
}

/// Extract note ID from qmd snippet which contains frontmatter like "id: uuid-here".
fn extract_id_from_snippet(snippet: &str) -> Option<String> {
    for line in snippet.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("id:") {
            let id = rest.trim().to_string();
            if !id.is_empty() {
                return Some(id);
            }
        }
    }
    None
}

fn resolve_path_to_id(path_str: &str, path_to_id: &HashMap<String, String>) -> Option<String> {
    // Direct match.
    if let Some(id) = path_to_id.get(path_str) {
        return Some(id.clone());
    }

    // Strip qmd:// URI scheme (e.g. "qmd://notes/filename.md" → "filename.md").
    let stripped = if let Some(rest) = path_str.strip_prefix("qmd://") {
        // Skip the collection name segment.
        rest.find('/').map(|i| &rest[i + 1..]).unwrap_or(rest)
    } else {
        path_str
    };

    if stripped != path_str {
        if let Some(id) = path_to_id.get(stripped) {
            return Some(id.clone());
        }
    }

    // Try just the filename.
    if let Some(fname) = Path::new(stripped).file_name() {
        let fname_str = fname.to_string_lossy().to_string();
        if let Some(id) = path_to_id.get(&fname_str) {
            return Some(id.clone());
        }
        // Try normalized form (collapses _/- runs into single `-`).
        let normalized = normalize_filename(&fname_str);
        if let Some(id) = path_to_id.get(&normalized) {
            return Some(id.clone());
        }
    }

    eprintln!("qmd: resolve FAILED for '{}' (stripped='{}')", path_str, stripped);
    None
}

// ── Tauri command ──────────────────────────────────────────────────

#[tauri::command]
pub async fn get_related_notes(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<crate::notes::NoteMetadata>, String> {
    let (cache, tx) = {
        let qmd = state.qmd.lock().map_err(|e| e.to_string())?;
        (qmd.cache.clone(), qmd.tx.clone())
    };

    let needs_query = {
        let c = cache.read().await;
        match c.relations.get(&id) {
            None => true,                       // never queried
            Some(e) => e.gen < c.generation,    // stale (new notes added since)
        }
    };

    if needs_query {
        let title = {
            let index = state.index.lock().map_err(|e| e.to_string())?;
            index.notes.get(&id).map(|m| m.title.clone())
        };
        if let Some(title) = title {
            let _ = tx.send(Msg::NoteChanged {
                id: id.clone(),
                title,
            });
        }
    }

    let entries = {
        let c = cache.read().await;
        c.relations.get(&id).map(|e| e.entries.clone()).unwrap_or_default()
    };

    let index = state.index.lock().map_err(|e| e.to_string())?;
    let mut results = Vec::new();
    for entry in entries {
        if let Some(meta) = index.notes.get(&entry.id) {
            results.push(meta.clone());
        }
    }
    Ok(results)
}
