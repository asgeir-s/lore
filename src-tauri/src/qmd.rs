use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use tauri::{Emitter, Manager, State};
use tokio::process::Command as TokioCommand;
use tokio::sync::{mpsc, RwLock};
use tokio::time::{Duration, Instant};

const DEBOUNCE: Duration = Duration::from_secs(5);
const REINDEX_INTERVAL: Duration = Duration::from_secs(300);
const STARTUP_PENDING_DELAY: Duration = Duration::from_secs(1);
const RELATED_CACHE_FILE: &str = ".lore-related.json";
const PENDING_FILE: &str = ".lore-qmd-pending.json";

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
    pub fn new(
        notes_dir: &str,
        app_handle: tauri::AppHandle,
        keyword_model: Option<String>,
    ) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let dir = PathBuf::from(notes_dir);
        let cache_path = cache_path(&dir);
        let initial_pending = load_pending(&pending_path(&dir));

        let cache = load_cache(&cache_path);
        let cache = Arc::new(RwLock::new(cache));
        let worker_cache = cache.clone();

        let model = keyword_model.unwrap_or_else(|| DEFAULT_OLLAMA_MODEL.to_string());
        tauri::async_runtime::spawn(async move {
            run_worker(rx, dir, app_handle, worker_cache, model, initial_pending).await;
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
        let _ = self.tx.send(Msg::NoteDeleted { id: id.to_string() });
    }

    pub fn shutdown(&self) {
        let _ = self.tx.send(Msg::Shutdown);
    }

    pub async fn get_related(&self, id: &str) -> Vec<RelatedEntry> {
        let cache = self.cache.read().await;
        cache
            .relations
            .get(id)
            .map(|e| e.entries.clone())
            .unwrap_or_default()
    }
}

pub fn defer_note_processing(notes_dir: &str, id: &str, title: &str) {
    let path = pending_path(Path::new(notes_dir));
    let mut pending = load_pending(&path);
    pending.insert(id.to_string(), title.to_string());
    save_pending(&path, &pending);
}

fn cache_path(notes_dir: &Path) -> PathBuf {
    notes_dir.join(RELATED_CACHE_FILE)
}

fn load_cache(path: &Path) -> RelatedCache {
    if let Ok(contents) = std::fs::read_to_string(path) {
        if let Ok(cache) = serde_json::from_str(&contents) {
            return cache;
        }
    }
    RelatedCache::default()
}

fn save_cache(path: &Path, cache: &RelatedCache) {
    if let Ok(json) = serde_json::to_string_pretty(cache) {
        let _ = std::fs::write(path, json);
    }
}

fn pending_path(notes_dir: &Path) -> PathBuf {
    notes_dir.join(PENDING_FILE)
}

fn load_pending(path: &Path) -> HashMap<String, String> {
    if let Ok(contents) = std::fs::read_to_string(path) {
        if let Ok(pending) = serde_json::from_str(&contents) {
            return pending;
        }
    }
    HashMap::default()
}

fn save_pending(path: &Path, pending: &HashMap<String, String>) {
    if pending.is_empty() {
        let _ = std::fs::remove_file(path);
        return;
    }
    if let Ok(json) = serde_json::to_string_pretty(pending) {
        let _ = std::fs::write(path, json);
    }
}

fn nvm_bin_dirs(root: &Path) -> Vec<String> {
    let mut bins: Vec<(std::time::SystemTime, String)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let bin = entry.path().join("bin");
            if !bin.is_dir() {
                continue;
            }
            let modified = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            bins.push((modified, bin.to_string_lossy().to_string()));
        }
    }
    bins.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    bins.into_iter().map(|(_, path)| path).collect()
}

fn preferred_path_entries(home: &str) -> Vec<String> {
    let mut preferred = nvm_bin_dirs(&Path::new(home).join(".nvm/versions/node"));
    preferred.extend([
        format!("{home}/.volta/bin"),
        format!("{home}/.local/bin"),
        format!("{home}/.linuxbrew/bin"),
        format!("{home}/.linuxbrew/sbin"),
        format!("{home}/.npm/bin"),
        format!("{home}/.npm-global/bin"),
        format!("{home}/.yarn/bin"),
        format!("{home}/.config/yarn/global/node_modules/.bin"),
        format!("{home}/.local/share/pnpm"),
        format!("{home}/.bun/bin"),
        format!("{home}/.asdf/shims"),
        format!("{home}/.n/bin"),
        "/opt/homebrew/bin".into(),
        "/opt/homebrew/sbin".into(),
        "/home/linuxbrew/.linuxbrew/bin".into(),
        "/home/linuxbrew/.linuxbrew/sbin".into(),
        "/usr/local/bin".into(),
        "/usr/local/sbin".into(),
        "/usr/bin".into(),
        "/usr/sbin".into(),
        "/bin".into(),
        "/snap/bin".into(),
    ]);
    preferred
}

fn push_unique(parts: &mut Vec<String>, candidate: &str) {
    if !candidate.is_empty() && !parts.iter().any(|existing| existing == candidate) {
        parts.push(candidate.to_string());
    }
}

fn prepend_path(dir: &str, path: &str) -> String {
    let mut parts = Vec::new();
    push_unique(&mut parts, dir);
    for p in path.split(':') {
        push_unique(&mut parts, p);
    }
    parts.join(":")
}

/// Build an enriched PATH so desktop app launches can still find external tools even when
/// the GUI process inherits a narrower PATH than an interactive shell.
pub(crate) fn enriched_path() -> String {
    static ENRICHED_PATH: OnceLock<String> = OnceLock::new();
    ENRICHED_PATH
        .get_or_init(|| {
            let base = std::env::var("PATH").unwrap_or_default();
            let home = std::env::var("HOME").unwrap_or_else(|_| "/Users/default".to_string());
            let mut parts: Vec<String> = Vec::new();
            for p in preferred_path_entries(&home) {
                push_unique(&mut parts, &p);
            }
            for p in base.split(':') {
                push_unique(&mut parts, p);
            }
            parts.join(":")
        })
        .clone()
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && (meta.permissions().mode() & 0o111 != 0))
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|meta| meta.is_file())
        .unwrap_or(false)
}

fn resolved_program_path(program: &str) -> Option<PathBuf> {
    if program.contains('/') {
        let path = PathBuf::from(program);
        return is_executable_file(&path).then_some(path);
    }

    for dir in enriched_path().split(':') {
        let candidate = Path::new(dir).join(program);
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
    }
    None
}

pub(crate) fn cmd(program: &str) -> TokioCommand {
    let path = enriched_path();
    if let Some(resolved) = resolved_program_path(program) {
        let mut c = TokioCommand::new(&resolved);
        if let Some(parent) = resolved.parent().and_then(Path::to_str) {
            c.env("PATH", prepend_path(parent, &path));
        } else {
            c.env("PATH", &path);
        }
        return c;
    }

    let mut c = TokioCommand::new(program);
    c.env("PATH", path);
    c
}

async fn qmd_available() -> bool {
    // 1) Binary exists and responds.
    let has_binary = cmd("qmd")
        .arg("--version")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !has_binary {
        return false;
    }

    // 2) Runtime is healthy (native modules load, DB can be opened).
    cmd("qmd")
        .args(["collection", "list"])
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

async fn qmd(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = cmd("qmd")
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

fn parse_collection_show(output: &str) -> (Option<String>, Option<String>) {
    let mut path = None;
    let mut pattern = None;
    for line in output.lines() {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("Path:") {
            path = Some(value.trim().to_string());
        } else if let Some(value) = trimmed.strip_prefix("Pattern:") {
            pattern = Some(value.trim().to_string());
        }
    }
    (path, pattern)
}

async fn ensure_collection(dir: &Path, name: &str, target_path: &Path) -> Result<(), String> {
    let target = target_path.to_string_lossy().to_string();

    let needs_recreate = match qmd(dir, &["collection", "show", name]).await {
        Ok(output) => {
            let (path, pattern) = parse_collection_show(&output);
            path.as_deref() != Some(target.as_str()) || pattern.as_deref() == Some("*.md")
        }
        Err(_) => false,
    };

    if needs_recreate {
        let _ = qmd(dir, &["collection", "remove", name]).await;
    }

    if qmd(dir, &["collection", "show", name]).await.is_err() {
        qmd(dir, &["collection", "add", &target, "--name", name]).await?;
    }

    Ok(())
}

async fn ensure_context(dir: &Path, target: &str, text: &str) -> Result<(), String> {
    let _ = qmd(dir, &["context", "rm", target]).await;
    qmd(dir, &["context", "add", target, text]).await?;
    Ok(())
}

async fn ensure_qmd_setup(dir: &Path) -> Result<(), String> {
    ensure_collection(dir, "notes", &dir.join(crate::notes::NOTES_COLLECTION_DIR)).await?;
    ensure_collection(
        dir,
        "pinned",
        &dir.join(crate::notes::PINNED_COLLECTION_DIR),
    )
    .await?;

    ensure_context(
        dir,
        "qmd://notes",
        "Stream of personal notes including journal entries, meeting notes, drafts, ideas, and brain dumps. These are temporal records that capture a moment. They provide context and history but are not authoritative.",
    )
    .await?;
    ensure_context(
        dir,
        "qmd://pinned",
        "Pinned notes. These represent the user's deliberate, current positions on topics like values, goals, routines, and business strategy. When a query matches both a pinned note and a regular note, the pinned note is the authoritative source.",
    )
    .await?;

    Ok(())
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
    ollama_model: String,
    mut pending: HashMap<String, String>,
) {
    if !qmd_available().await {
        eprintln!("qmd: unavailable (missing or runtime-broken), entering drain mode");
        // Drain all messages silently.
        while rx.recv().await.is_some() {}
        return;
    }

    if let Err(e) = ensure_qmd_setup(&dir).await {
        eprintln!("qmd: setup failed: {e}");
    }
    if let Err(e) = qmd(&dir, &["update"]).await {
        eprintln!("qmd: initial update failed: {e}");
    }
    if let Err(e) = qmd(&dir, &["embed"]).await {
        eprintln!("qmd: initial embed failed: {e}");
    }

    let has_ollama = ollama_available(&ollama_model).await;
    if has_ollama {
        eprintln!("qmd: ollama available, using {ollama_model} for keyword extraction");
    } else {
        eprintln!("qmd: ollama not available, using title-only queries");
    }

    let cache_path = cache_path(&dir);
    let pending_path = pending_path(&dir);
    let mut deadline = if pending.is_empty() {
        None
    } else {
        Some(Instant::now() + STARTUP_PENDING_DELAY)
    };
    let mut last_reindex = Instant::now();

    loop {
        let msg = if let Some(dl) = deadline {
            tokio::select! {
                msg = rx.recv() => msg,
                _ = tokio::time::sleep_until(dl) => {
                    process_pending(&dir, &mut pending, &pending_path, &cache, &cache_path, &app_handle, has_ollama, &ollama_model).await;
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
                save_pending(&pending_path, &pending);
                deadline = Some(Instant::now() + DEBOUNCE);
            }
            Some(Msg::NoteDeleted { id }) => {
                pending.remove(&id);
                save_pending(&pending_path, &pending);
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
                save_pending(&pending_path, &pending);
                break;
            }
            None => {
                save_pending(&pending_path, &pending);
                break;
            }
        }
    }
}

async fn process_pending(
    dir: &Path,
    pending: &mut HashMap<String, String>,
    pending_path: &Path,
    cache: &Arc<RwLock<RelatedCache>>,
    cache_path: &Path,
    app_handle: &tauri::AppHandle,
    has_ollama: bool,
    ollama_model: &str,
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

    let items: Vec<(String, String)> = pending
        .iter()
        .map(|(id, title)| (id.clone(), title.clone()))
        .collect();

    let processing_ids: Vec<&str> = items.iter().map(|(id, _)| id.as_str()).collect();
    let _ = app_handle.emit("qmd-processing", processing_ids);

    // Advance the generation counter — any cached entry with an older gen is stale.
    {
        let mut c = cache.write().await;
        c.generation += 1;
        eprintln!("qmd: generation now {}", c.generation);
    }

    // Build maps from the note index.
    let (path_to_id, id_to_path, id_to_tags, id_to_title) = build_maps(app_handle);

    let mut did_auto_tag = false;

    for (note_id, title) in &items {
        let note_tags = id_to_tags.get(note_id).cloned().unwrap_or_default();
        let (query_text, keywords) = build_query(
            dir,
            title,
            id_to_path.get(note_id),
            &note_tags,
            has_ollama,
            ollama_model,
        )
        .await;

        // Auto-tag notes that have no tags
        if let Some(ref kw) = keywords {
            if let Some(state) = app_handle.try_state::<AppState>() {
                let applied = {
                    let notes_dir = state.notes_dir.lock().ok();
                    let mut index = state.index.lock().ok();
                    match (notes_dir, index.as_mut()) {
                        (Some(dir), Some(idx)) => {
                            crate::notes::set_auto_tags(&dir, note_id, kw, idx, false)
                                .ok()
                                .flatten()
                        }
                        _ => None,
                    }
                };
                if let Some(meta) = applied {
                    eprintln!(
                        "qmd: auto-tagged '{}' with {:?}",
                        &note_id[..8.min(note_id.len())],
                        kw
                    );
                    if let Ok(git) = state.git.lock() {
                        git.notify_change(&meta.path, &meta.title, false);
                    }
                    did_auto_tag = true;
                }
            }
        }

        if query_text.trim().is_empty() {
            continue;
        }
        eprintln!(
            "qmd: query for '{}': {}",
            &note_id[..8.min(note_id.len())],
            &query_text[..100.min(query_text.len())]
        );

        match qmd(
            dir,
            &[
                "query",
                &query_text,
                "--json",
                "-n",
                "10",
                "--min-score",
                "0.35",
            ],
        )
        .await
        {
            Ok(output) => {
                let mut entries = parse_qmd_results(&output, &path_to_id, note_id);
                entries.sort_by(|a, b| {
                    b.score
                        .partial_cmp(&a.score)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
                let source_title = id_to_title.get(note_id).map(|s| s.as_str()).unwrap_or("?");
                eprintln!(
                    "qmd: results for '{}' ({}):",
                    &note_id[..8.min(note_id.len())],
                    source_title
                );
                for e in &entries {
                    let t = id_to_title.get(&e.id).map(|s| s.as_str()).unwrap_or("?");
                    eprintln!("qmd:   {:.2}  {}", e.score, t);
                }
                let mut c = cache.write().await;
                let gen = c.generation;
                c.relations
                    .insert(note_id.clone(), CacheEntry { gen, entries });
            }
            Err(e) => {
                eprintln!("qmd: query failed for '{}': {e}", note_id);
            }
        }
    }

    let c = cache.read().await;
    save_cache(cache_path, &c);
    // Emit notes-changed once after all auto-tagging is done (not per-note)
    // to avoid triggering cascading frontend refreshes during processing.
    if did_auto_tag {
        let _ = app_handle.emit("notes-changed", ());
    }
    let _ = app_handle.emit("related-notes-changed", ());
    pending.clear();
    save_pending(pending_path, pending);
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

/// Canonicalize a note stem for resilient matching across separators/punctuation.
/// Example: `my_note-title!.md` -> `mynotetitle`
fn canonical_stem(s: &str) -> String {
    let stem = Path::new(s)
        .file_stem()
        .map(|v| v.to_string_lossy().to_string())
        .unwrap_or_else(|| s.to_string());
    stem.chars()
        .flat_map(|c| c.to_lowercase())
        .filter(|c| c.is_alphanumeric())
        .collect()
}

fn build_maps(
    app_handle: &tauri::AppHandle,
) -> (
    HashMap<String, String>,
    HashMap<String, String>,
    HashMap<String, Vec<String>>,
    HashMap<String, String>,
) {
    let mut path_to_id = HashMap::new();
    let mut id_to_path = HashMap::new();
    let mut id_to_tags = HashMap::new();
    let mut id_to_title = HashMap::new();
    if let Some(state) = app_handle.try_state::<AppState>() {
        if let Ok(index) = state.index.lock() {
            for (id, meta) in &index.notes {
                path_to_id.insert(meta.path.clone(), id.clone());
                id_to_path.insert(id.clone(), meta.path.clone());
                id_to_tags.insert(id.clone(), meta.tags.clone());
                id_to_title.insert(id.clone(), meta.title.clone());
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
    (path_to_id, id_to_path, id_to_tags, id_to_title)
}

/// Build a search query for finding related notes.
/// If an ordinary note already has tags, uses them directly (no ollama call).
/// Otherwise asks ollama to extract keywords from content.
/// Returns (query_string, parsed_keywords) — keywords are only Some when ollama was called
/// (used for auto-tagging empty-tag, meeting, and voice memo notes).
async fn build_query(
    dir: &Path,
    title: &str,
    rel_path: Option<&String>,
    tags: &[String],
    has_ollama: bool,
    ollama_model: &str,
) -> (String, Option<Vec<String>>) {
    let is_meeting_note = tags.iter().any(|t| t.as_str() == "meeting")
        || rel_path.is_some_and(|path| crate::notes::is_meeting_path(path));
    let is_voice_memo_note = tags.iter().any(|t| t.as_str() == "voice-memo");
    let should_extract_keywords = is_meeting_note || is_voice_memo_note;

    // For ordinary notes, existing tags are enough and we skip ollama extraction.
    // For meetings and imported voice memos, still extract keywords so they can be
    // appended as topic tags even when the user already added tags manually.
    if !should_extract_keywords && !tags.is_empty() {
        let tag_str = tags.join(", ");
        return (tag_str, None);
    }

    if !has_ollama {
        return (title.to_string(), None);
    }
    if let Some(path) = rel_path {
        let full_path = dir.join(path);
        if let Ok(content) = std::fs::read_to_string(&full_path) {
            let body = strip_frontmatter(&content);
            // Limit to ~2000 chars to keep the prompt short and fast.
            let truncated: String = body.chars().take(2000).collect();
            if truncated.trim().len() > 20 {
                if let Some(keywords) = ollama_extract_keywords(&truncated, ollama_model).await {
                    let parsed: Vec<String> = keywords
                        .split(',')
                        .map(|k| k.trim().to_lowercase())
                        .filter(|k| !k.is_empty())
                        .collect();
                    return (keywords, Some(parsed));
                }
            }
        }
    }
    (title.to_string(), None)
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

const DEFAULT_OLLAMA_MODEL: &str = "qwen2.5:1.5b";

async fn ollama_available(model: &str) -> bool {
    crate::ollama::model_available(model).await
}

async fn ollama_extract_keywords(text: &str, model: &str) -> Option<String> {
    let preview: String = text.chars().take(60).collect();
    eprintln!("qmd: ollama → \"{}...\"", preview.replace('\n', " "));

    let prompt = format!(
        "What is this text about? Reply with exactly 5 topic words separated by commas. No explanation, no formatting.\n\n{}",
        text
    );
    let raw = match crate::ollama::generate(model, &prompt).await {
        Ok(raw) => raw.trim().to_string(),
        Err(err) => {
            eprintln!("qmd: ollama failed: {err}");
            return None;
        }
    };
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
                eprintln!(
                    "qmd: no JSON found in output: {}",
                    &output[..output.len().min(200)]
                );
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
        eprintln!(
            "qmd: could not parse results: {}",
            &json_str[..json_str.len().min(200)]
        );
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
    let path_str = path_str.trim();

    // Direct match.
    if let Some(id) = path_to_id.get(path_str) {
        return Some(id.clone());
    }

    // Strip qmd:// URI scheme (e.g. "qmd://notes/filename.md" → "filename.md").
    let stripped = if let Some(rest) = path_str.strip_prefix("qmd://") {
        let rest = rest.trim_start_matches('/');
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

    // Handle chunked qmd paths like "notename/chunkid.md" or
    // "subdir/notename/chunkid.md".
    if let Some((source_path, _chunk)) = stripped.rsplit_once('/') {
        let mut tried: Vec<String> = Vec::new();

        let source_file = if source_path.ends_with(".md") {
            source_path.to_string()
        } else {
            format!("{source_path}.md")
        };
        tried.push(source_file.clone());
        let normalized = normalize_filename(&source_file);
        if normalized != source_file {
            tried.push(normalized);
        }

        if let Some(base_name) = Path::new(&source_file).file_name() {
            let base_name = base_name.to_string_lossy().to_string();
            tried.push(base_name.clone());
            let normalized = normalize_filename(&base_name);
            if normalized != base_name {
                tried.push(normalized);
            }
        }

        for candidate in tried {
            if let Some(id) = path_to_id.get(&candidate) {
                return Some(id.clone());
            }
        }

        // Final fallback: canonical stem match, only when it uniquely maps to one ID.
        let target = canonical_stem(source_path);
        if !target.is_empty() {
            let mut unique: Option<&String> = None;
            let mut ambiguous = false;
            for (k, id) in path_to_id {
                if canonical_stem(k) == target {
                    if let Some(existing) = unique {
                        if existing != id {
                            ambiguous = true;
                            break;
                        }
                    } else {
                        unique = Some(id);
                    }
                }
            }
            if !ambiguous {
                if let Some(id) = unique {
                    return Some(id.clone());
                }
            }
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

        // Fallback for punctuation/spacing variants.
        let target = canonical_stem(&fname_str);
        if !target.is_empty() {
            let mut unique: Option<&String> = None;
            let mut ambiguous = false;
            for (k, id) in path_to_id {
                if canonical_stem(k) == target {
                    if let Some(existing) = unique {
                        if existing != id {
                            ambiguous = true;
                            break;
                        }
                    } else {
                        unique = Some(id);
                    }
                }
            }
            if !ambiguous {
                if let Some(id) = unique {
                    return Some(id.clone());
                }
            }
        }
    }

    eprintln!(
        "qmd: resolve FAILED for '{}' (stripped='{}', map_size={})",
        path_str,
        stripped,
        path_to_id.len()
    );
    None
}

// ── Tauri command ──────────────────────────────────────────────────

#[tauri::command]
pub async fn get_related_notes(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<crate::notes::NoteMetadata>, String> {
    let cache = {
        let qmd = state.qmd.lock().map_err(|e| e.to_string())?;
        qmd.cache.clone()
    };

    // Return cached results only — notes are re-queried when they actually change
    // (via notify_change on save), not on every read.  The previous approach of
    // re-queuing "stale" entries here caused an infinite ping-pong loop when
    // multiple panels were open: processing note A bumped the global generation,
    // making note B stale, which triggered re-processing of B, bumping generation
    // again and making A stale, ad infinitum.
    let entries = {
        let c = cache.read().await;
        c.relations
            .get(&id)
            .map(|e| e.entries.clone())
            .unwrap_or_default()
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

#[tauri::command]
pub async fn regenerate_tags(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    id: String,
) -> Result<crate::notes::NoteMetadata, String> {
    // Read note content from disk
    let (notes_dir, rel_path) = {
        let dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
        let index = state.index.lock().map_err(|e| e.to_string())?;
        let meta = index.notes.get(&id).ok_or("Note not found")?;
        (dir.clone(), meta.path.clone())
    };

    let full_path = std::path::Path::new(&notes_dir).join(&rel_path);
    let content = std::fs::read_to_string(&full_path).map_err(|e| e.to_string())?;
    let body = strip_frontmatter(&content);
    let truncated: String = body.chars().take(2000).collect();

    if truncated.trim().len() <= 20 {
        return Err("Note content too short for keyword extraction".into());
    }

    let keyword_model = state
        .model_settings
        .lock()
        .ok()
        .and_then(|ms| ms.keyword_model.clone())
        .unwrap_or_else(|| DEFAULT_OLLAMA_MODEL.to_string());
    let keywords_str = ollama_extract_keywords(&truncated, &keyword_model)
        .await
        .ok_or("Ollama keyword extraction failed")?;

    let keywords: Vec<String> = keywords_str
        .split(',')
        .map(|k| k.trim().to_lowercase())
        .filter(|k| !k.is_empty())
        .collect();

    if keywords.is_empty() {
        return Err("No keywords extracted".into());
    }

    let meta = {
        let dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
        let mut index = state.index.lock().map_err(|e| e.to_string())?;
        crate::notes::set_auto_tags(&dir, &id, &keywords, &mut index, true)
            .map_err(|e| e.to_string())?
            .ok_or("Failed to apply tags")?
    };

    if let Ok(git) = state.git.lock() {
        git.notify_change(&meta.path, &meta.title, false);
    }
    if let Ok(qmd) = state.qmd.lock() {
        qmd.notify_change(&id, &meta.title);
    }
    let _ = app_handle.emit("notes-changed", ());

    Ok(meta)
}

#[derive(Clone, Serialize)]
pub struct ToolStatus {
    pub git: bool,
    pub qmd: bool,
    pub ollama: bool,
    pub ffmpeg: bool,
    pub whisper: bool,
}

#[tauri::command]
pub async fn check_tools() -> ToolStatus {
    let git = cmd("git")
        .arg("--version")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);

    let qmd = qmd_available().await;
    let ollama = cmd("ollama")
        .arg("--version")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);

    let ffmpeg = cmd("ffmpeg")
        .arg("-version")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);

    let whisper = cmd("whisper-cli")
        .arg("--help")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);

    eprintln!("qmd: tool check — git={git}, qmd={qmd}, ollama={ollama}, ffmpeg={ffmpeg}, whisper={whisper}");

    ToolStatus {
        git,
        qmd,
        ollama,
        ffmpeg,
        whisper,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_path_map(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn nvm_bin_dirs_includes_all_versions() {
        let root = std::env::temp_dir().join(format!("lore-qmd-test-{}", uuid::Uuid::new_v4()));
        let v20 = root.join("v20.0.0/bin");
        let v22 = root.join("v22.0.0/bin");
        std::fs::create_dir_all(&v20).unwrap();
        std::fs::create_dir_all(&v22).unwrap();

        let bins = nvm_bin_dirs(&root);

        assert_eq!(bins.len(), 2);
        assert!(bins.iter().any(|path| path.ends_with("v20.0.0/bin")));
        assert!(bins.iter().any(|path| path.ends_with("v22.0.0/bin")));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn prepend_path_moves_resolved_bin_to_front_once() {
        assert_eq!(
            prepend_path("/custom/bin", "/usr/local/bin:/custom/bin:/usr/bin"),
            "/custom/bin:/usr/local/bin:/usr/bin"
        );
    }

    #[test]
    fn preferred_path_entries_include_linuxbrew_locations() {
        let entries = preferred_path_entries("/home/testuser");

        assert!(entries
            .iter()
            .any(|path| path == "/home/testuser/.linuxbrew/bin"));
        assert!(entries
            .iter()
            .any(|path| path == "/home/testuser/.linuxbrew/sbin"));
        assert!(entries
            .iter()
            .any(|path| path == "/home/linuxbrew/.linuxbrew/bin"));
        assert!(entries
            .iter()
            .any(|path| path == "/home/linuxbrew/.linuxbrew/sbin"));
        assert!(entries.iter().any(|path| path == "/usr/local/bin"));
    }

    #[test]
    fn resolve_direct_path() {
        let map = make_path_map(&[("notes/hello.md", "id1")]);
        assert_eq!(
            resolve_path_to_id("notes/hello.md", &map),
            Some("id1".into())
        );
    }

    #[test]
    fn resolve_qmd_uri() {
        let map = make_path_map(&[("hello.md", "id1")]);
        assert_eq!(
            resolve_path_to_id("qmd://notes/hello.md", &map),
            Some("id1".into())
        );
    }

    #[test]
    fn resolve_chunked_qmd_path() {
        // qmd chunks large docs: "qmd://notes/notename/chunkid.md"
        // The directory part is the original filename (without .md).
        let map = make_path_map(&[(
            "20260217221315-dette-er-en-notat-som-jeg-skriver-note.md",
            "7535072e",
        )]);
        assert_eq!(
            resolve_path_to_id(
                "qmd://notes/20260217221315-dette-er-en-notat-som-jeg-skriver-note/7535072e.md",
                &map,
            ),
            Some("7535072e".into()),
        );
    }

    #[test]
    fn resolve_chunked_path_with_normalization() {
        // build_maps stores both original and normalized filenames.
        // Actual filename uses underscores; qmd path uses dashes.
        let map = make_path_map(&[
            ("20260217221315-dette_er_en_notat.md", "abc123"),
            ("20260217221315-dette-er-en-notat.md", "abc123"), // normalized by build_maps
        ]);
        assert_eq!(
            resolve_path_to_id(
                "qmd://notes/20260217221315-dette-er-en-notat/chunk99.md",
                &map,
            ),
            Some("abc123".into()),
        );
    }

    #[test]
    fn resolve_chunked_qmd_path_with_nested_source_path() {
        let map = make_path_map(&[("archive/20260217221315-dette-er-en-notat.md", "id-nested")]);
        assert_eq!(
            resolve_path_to_id(
                "qmd://notes/archive/20260217221315-dette-er-en-notat/chunk99.md",
                &map,
            ),
            Some("id-nested".into()),
        );
    }

    #[test]
    fn resolve_chunked_qmd_path_with_canonical_stem_fallback() {
        let map = make_path_map(&[("20260217221315-dette__er__en__notat!!.md", "id1")]);
        assert_eq!(
            resolve_path_to_id(
                "qmd://notes/20260217221315-dette-er-en-notat/chunk99.md",
                &map,
            ),
            Some("id1".into()),
        );
    }

    #[test]
    fn resolve_qmd_uri_with_leading_slashes() {
        let map = make_path_map(&[("hello.md", "id1")]);
        assert_eq!(
            resolve_path_to_id("qmd:///notes/hello.md", &map),
            Some("id1".into())
        );
    }

    #[test]
    fn resolve_filename_with_normalization() {
        // build_maps stores both original and normalized filenames.
        let map = make_path_map(&[
            ("my_cool_note.md", "id1"),
            ("my-cool-note.md", "id1"), // normalized by build_maps
        ]);
        assert_eq!(
            resolve_path_to_id("qmd://notes/my-cool-note.md", &map),
            Some("id1".into())
        );
    }

    #[test]
    fn resolve_unknown_returns_none() {
        let map = make_path_map(&[("existing.md", "id1")]);
        assert_eq!(resolve_path_to_id("qmd://notes/nonexistent.md", &map), None);
    }
}
