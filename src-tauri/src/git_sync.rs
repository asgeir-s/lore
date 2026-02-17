use crate::AppState;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager, State};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::time::{Duration, Instant, MissedTickBehavior};
use uuid::Uuid;

const DEBOUNCE: Duration = Duration::from_secs(2);
const PULL_INTERVAL: Duration = Duration::from_secs(60);

/// Describes a file change to be committed.
#[derive(Debug, Clone)]
pub struct FileChange {
    pub path: String,
    pub title: String,
    pub is_new: bool,
}

/// Messages sent to the background git worker.
enum Msg {
    Change(FileChange),
    /// Flush pending changes and sync, then signal completion.
    Flush(tokio::sync::oneshot::Sender<()>),
    Shutdown,
}

/// Clonable handle used by Tauri commands to talk to the worker.
#[derive(Clone)]
pub struct GitSyncHandle {
    tx: mpsc::UnboundedSender<Msg>,
    dismissed: Arc<AtomicBool>,
}

impl GitSyncHandle {
    /// Start a new git sync worker for the given notes directory.
    /// `app_handle` is used to emit events to the frontend.
    pub fn new(notes_dir: &str, app_handle: tauri::AppHandle) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let dir = PathBuf::from(notes_dir);

        tauri::async_runtime::spawn(async move {
            // Ensure the directory is a git repo and commit any leftover files.
            if let Err(e) = ensure_git_repo(&dir).await {
                eprintln!("git_sync: failed to init repo: {e}");
                return;
            }
            if let Err(e) = commit_leftover_md(&dir).await {
                eprintln!("git_sync: failed to commit leftover files: {e}");
            }
            if let Err(e) = sync_with_remote(&dir, &app_handle, false).await {
                eprintln!("git_sync: startup sync failed: {e}");
            }
            run_worker(rx, dir, app_handle).await;
        });

        Self {
            tx,
            dismissed: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Fire-and-forget: enqueue a file change.
    pub fn notify_change(&self, path: &str, title: &str, is_new: bool) {
        let _ = self.tx.send(Msg::Change(FileChange {
            path: path.to_string(),
            title: title.to_string(),
            is_new,
        }));
    }

    /// Block until all pending changes are committed and synced.
    pub fn flush_and_push(&self) {
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let _ = self.tx.send(Msg::Flush(done_tx));
        // Block the current thread waiting for the async worker to finish.
        let _ = tauri::async_runtime::block_on(async {
            let _ = done_rx.await;
        });
    }

    /// Shut down the worker (used when switching notes directories).
    pub fn shutdown(&self) {
        let _ = self.tx.send(Msg::Shutdown);
    }

    pub fn is_dismissed(&self) -> bool {
        self.dismissed.load(Ordering::Relaxed)
    }

    pub fn dismiss(&self) {
        self.dismissed.store(true, Ordering::Relaxed);
    }
}

/// The long-lived background worker.
async fn run_worker(
    mut rx: mpsc::UnboundedReceiver<Msg>,
    dir: PathBuf,
    app_handle: tauri::AppHandle,
) {
    let mut pending: Vec<FileChange> = Vec::new();
    let mut deadline: Option<Instant> = None;
    let mut pull_interval = tokio::time::interval(PULL_INTERVAL);
    pull_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    // Consume the immediate first tick.
    pull_interval.tick().await;

    loop {
        let msg = if let Some(dl) = deadline {
            tokio::select! {
                msg = rx.recv() => msg,
                _ = tokio::time::sleep_until(dl) => {
                    // Debounce fired — sync what we have.
                    do_sync_once(&dir, &mut pending, &app_handle, true).await;
                    deadline = None;
                    continue;
                }
                _ = pull_interval.tick() => {
                    // Only pull/push periodically when there are no unsaved local changes pending commit.
                    if pending.is_empty() {
                        do_sync_once(&dir, &mut pending, &app_handle, false).await;
                    }
                    continue;
                }
            }
        } else {
            tokio::select! {
                msg = rx.recv() => msg,
                _ = pull_interval.tick() => {
                    do_sync_once(&dir, &mut pending, &app_handle, false).await;
                    continue;
                }
            }
        };

        match msg {
            Some(Msg::Change(change)) => {
                pending.push(change);
                deadline = Some(Instant::now() + DEBOUNCE);
            }
            Some(Msg::Flush(done)) => {
                do_sync_once(&dir, &mut pending, &app_handle, true).await;
                deadline = None;
                let _ = done.send(());
            }
            Some(Msg::Shutdown) | None => {
                // Final best-effort sync before exiting.
                do_sync_once(&dir, &mut pending, &app_handle, true).await;
                break;
            }
        }
    }
}

async fn do_sync_once(
    dir: &Path,
    pending: &mut Vec<FileChange>,
    app_handle: &tauri::AppHandle,
    emit_errors: bool,
) {
    if let Err(e) = commit_pending_changes(dir, pending).await {
        eprintln!("git_sync: commit failed: {e}");
        if emit_errors {
            emit_error(app_handle, &format!("Git commit failed: {e}"));
        }
        return;
    }

    if let Err(e) = sync_with_remote(dir, app_handle, emit_errors).await {
        eprintln!("git_sync: sync failed: {e}");
    }
}

/// Stage specific files, commit with an auto-generated message.
async fn commit_pending_changes(dir: &Path, pending: &mut Vec<FileChange>) -> Result<(), String> {
    if pending.is_empty() {
        return Ok(());
    }

    let changes = pending.clone();

    // Stage each changed file individually.
    for change in &changes {
        let file = Path::new(&change.path);
        // If the path is absolute, make it relative to dir.
        let rel = if file.is_absolute() {
            file.strip_prefix(dir)
                .unwrap_or(file)
                .to_string_lossy()
                .to_string()
        } else {
            change.path.clone()
        };
        if let Err(e) = git(dir, &["add", &rel]).await {
            eprintln!("git_sync: failed to stage {rel}: {e}");
        }
    }

    // Also stage the index and related-cache files.
    let _ = git(dir, &["add", ".dump-index.json"]).await;
    let _ = git(dir, &["add", ".dump-related.json"]).await;

    // Check if there's actually anything staged.
    let diff = git(dir, &["diff", "--cached", "--quiet"]).await;
    if diff.is_ok() {
        // Exit code 0 means no diff — nothing to commit.
        pending.clear();
        return Ok(());
    }

    let message = build_commit_message(&changes);
    git(dir, &["commit", "-m", &message]).await?;
    pending.clear();
    Ok(())
}

/// Sync local branch against remote: pull/reindex when behind, push when ahead.
async fn sync_with_remote(
    dir: &Path,
    app_handle: &tauri::AppHandle,
    emit_errors: bool,
) -> Result<(), String> {
    if !has_remote(dir).await {
        return Ok(());
    }

    do_pull_and_reindex(dir, app_handle, emit_errors).await?;
    push_if_ahead(dir, app_handle, emit_errors).await?;
    Ok(())
}

/// Fetch and rebase on top of remote when behind; rebuild index and notify frontend.
async fn do_pull_and_reindex(
    dir: &Path,
    app_handle: &tauri::AppHandle,
    emit_errors: bool,
) -> Result<bool, String> {
    if !has_remote(dir).await {
        return Ok(false);
    }

    git(dir, &["fetch", "origin"]).await?;

    let target = resolve_sync_target(dir).await?;
    if !remote_ref_exists(dir, &target.remote_ref).await {
        return Ok(false);
    }

    let (_, behind) = ahead_behind(dir, &target.remote_ref).await?;
    if behind == 0 {
        return Ok(false);
    }

    if let Err(rebase_err) = git(dir, &["rebase", &target.remote_ref]).await {
        if !is_conflict_error(&rebase_err) {
            let _ = git(dir, &["rebase", "--abort"]).await;
            let msg = format!(
                "Git sync pull failed from {}: {}",
                target.remote_ref,
                rebase_err.trim()
            );
            if emit_errors {
                emit_error(app_handle, &msg);
            }
            return Err(msg);
        }

        if let Err(resolve_err) = resolve_conflicts_keep_both(dir).await {
            let _ = git(dir, &["rebase", "--abort"]).await;
            let msg = format!(
                "Git sync conflict auto-resolution failed for {}: {}",
                target.remote_ref,
                resolve_err.trim()
            );
            if emit_errors {
                emit_error(app_handle, &msg);
            }
            return Err(msg);
        }

        if let Err(continue_err) = continue_rebase_keep_both(dir).await {
            let _ = git(dir, &["rebase", "--abort"]).await;
            let msg = format!(
                "Git sync conflict auto-resolution could not finish for {}: {}",
                target.remote_ref,
                continue_err.trim()
            );
            if emit_errors {
                emit_error(app_handle, &msg);
            }
            return Err(msg);
        }
    }

    rebuild_index_from_worker(dir, app_handle)?;
    Ok(true)
}

/// Push local commits if local is ahead of remote.
async fn push_if_ahead(
    dir: &Path,
    app_handle: &tauri::AppHandle,
    emit_errors: bool,
) -> Result<(), String> {
    let target = resolve_sync_target(dir).await?;

    if !remote_ref_exists(dir, &target.remote_ref).await {
        if has_local_commit(dir).await {
            push_with_retry(dir, app_handle, emit_errors).await?;
        }
        return Ok(());
    }

    let (ahead, _) = ahead_behind(dir, &target.remote_ref).await?;
    if ahead == 0 {
        return Ok(());
    }

    push_with_retry(dir, app_handle, emit_errors).await
}

async fn push_with_retry(
    dir: &Path,
    app_handle: &tauri::AppHandle,
    emit_errors: bool,
) -> Result<(), String> {
    match push_current_branch(dir).await {
        Ok(()) => return Ok(()),
        Err(first_err) => {
            if !is_non_fast_forward(&first_err) {
                if emit_errors {
                    emit_error(app_handle, &format!("Git push failed: {first_err}"));
                }
                return Err(first_err);
            }

            // Pull and retry once when push was rejected because remote advanced.
            if let Err(pull_err) = do_pull_and_reindex(dir, app_handle, false).await {
                let msg = format!(
                    "Git push was rejected and retry pull failed. push: {}; pull: {}",
                    first_err.trim(),
                    pull_err.trim()
                );
                if emit_errors {
                    emit_error(app_handle, &msg);
                }
                return Err(msg);
            }

            match push_current_branch(dir).await {
                Ok(()) => Ok(()),
                Err(retry_err) => {
                    if emit_errors {
                        emit_error(app_handle, &format!("Git push retry failed: {retry_err}"));
                    }
                    Err(retry_err)
                }
            }
        }
    }
}

async fn push_current_branch(dir: &Path) -> Result<(), String> {
    match git(dir, &["push"]).await {
        Ok(_) => Ok(()),
        Err(e) if needs_upstream(&e) => git(dir, &["push", "-u", "origin", "HEAD"]).await.map(|_| ()),
        Err(e) => Err(e),
    }
}

fn needs_upstream(err: &str) -> bool {
    let e = err.to_lowercase();
    e.contains("no upstream branch") || e.contains("set-upstream")
}

fn is_non_fast_forward(err: &str) -> bool {
    let e = err.to_lowercase();
    e.contains("non-fast-forward")
        || e.contains("fetch first")
        || e.contains("failed to push some refs")
        || e.contains("[rejected]")
}

fn is_conflict_error(err: &str) -> bool {
    let e = err.to_lowercase();
    e.contains("conflict")
        || e.contains("could not apply")
        || e.contains("merge conflict")
        || e.contains("needs merge")
}

fn is_empty_patch_error(err: &str) -> bool {
    let e = err.to_lowercase();
    e.contains("previous cherry-pick is now empty") || e.contains("nothing to commit")
}

async fn continue_rebase_keep_both(dir: &Path) -> Result<(), String> {
    loop {
        match git_with_env(dir, &["rebase", "--continue"], &[("GIT_EDITOR", "true")]).await {
            Ok(_) => return Ok(()),
            Err(e) if is_empty_patch_error(&e) => {
                git(dir, &["rebase", "--skip"]).await?;
            }
            Err(e) if is_conflict_error(&e) => {
                resolve_conflicts_keep_both(dir).await?;
            }
            Err(e) => return Err(e),
        }
    }
}

async fn resolve_conflicts_keep_both(dir: &Path) -> Result<(), String> {
    let conflicted = conflicted_files(dir).await?;
    if conflicted.is_empty() {
        return Ok(());
    }

    for rel in conflicted {
        let is_markdown = rel.ends_with(".md");
        let local_variant = if is_markdown {
            read_stage_content(dir, 3, &rel).await?
        } else {
            None
        };

        // In rebase conflicts, --ours is the upstream (remote) side.
        if git(dir, &["checkout", "--ours", &rel]).await.is_err() {
            let _ = git(dir, &["checkout", "--theirs", &rel]).await;
        }

        if let Some(local_content) = local_variant {
            let copy_rel = write_conflict_copy(dir, &rel, &local_content)?;
            git(dir, &["add", &copy_rel]).await?;
        }

        // Stage file updates or deletions.
        git(dir, &["add", "-A", &rel]).await?;
    }

    Ok(())
}

async fn conflicted_files(dir: &Path) -> Result<Vec<String>, String> {
    let output = git(dir, &["diff", "--name-only", "--diff-filter=U"]).await?;
    let files = output
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    Ok(files)
}

async fn read_stage_content(dir: &Path, stage: u8, rel: &str) -> Result<Option<String>, String> {
    let spec = format!(":{}:{}", stage, rel);
    if git(dir, &["cat-file", "-e", &spec]).await.is_err() {
        return Ok(None);
    }
    Ok(Some(git(dir, &["show", &spec]).await?))
}

fn write_conflict_copy(dir: &Path, rel: &str, content: &str) -> Result<String, String> {
    let rel_path = Path::new(rel);
    let stem = rel_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("note");
    let ext = rel_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("md");
    let suffix = Uuid::new_v4()
        .to_string()
        .chars()
        .take(8)
        .collect::<String>();
    let copy_name = if ext.is_empty() {
        format!("{stem}-conflict-{suffix}")
    } else {
        format!("{stem}-conflict-{suffix}.{ext}")
    };

    let rel_copy = if let Some(parent) = rel_path.parent() {
        parent.join(copy_name)
    } else {
        PathBuf::from(copy_name)
    };

    let content = ensure_note_id_for_copy(content);
    let abs_copy = dir.join(&rel_copy);
    std::fs::write(&abs_copy, content).map_err(|e| format!("write conflict copy {}: {e}", abs_copy.display()))?;

    Ok(rel_copy.to_string_lossy().to_string())
}

fn ensure_note_id_for_copy(content: &str) -> String {
    let new_id = Uuid::new_v4().to_string();

    if let Some(after_first) = content.strip_prefix("---\n") {
        if let Some(end_pos) = after_first.find("\n---\n") {
            let yaml_part = &after_first[..end_pos];
            let body = &after_first[end_pos + 5..];
            let mut replaced = false;
            let mut lines = Vec::new();

            for line in yaml_part.lines() {
                if line.trim_start().starts_with("id:") {
                    lines.push(format!("id: {new_id}"));
                    replaced = true;
                } else {
                    lines.push(line.to_string());
                }
            }
            if !replaced {
                lines.insert(0, format!("id: {new_id}"));
            }

            return format!("---\n{}\n---\n{}", lines.join("\n"), body);
        }
    }

    format!("---\nid: {new_id}\n---\n{content}")
}

#[derive(Debug, Clone)]
struct SyncTarget {
    remote_ref: String,
}

async fn resolve_sync_target(dir: &Path) -> Result<SyncTarget, String> {
    // Prefer current branch's configured upstream.
    if let Ok(upstream) = git(
        dir,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .await
    {
        let upstream = upstream.trim();
        if !upstream.is_empty() {
            return Ok(SyncTarget {
                remote_ref: upstream.to_string(),
            });
        }
    }

    // Otherwise use remote default branch.
    if let Ok(default_ref) = git(dir, &["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]).await
    {
        let default_ref = default_ref.trim();
        if !default_ref.is_empty() {
            return Ok(SyncTarget {
                remote_ref: default_ref.to_string(),
            });
        }
    }

    // Final fallback: assume origin/<current-branch>.
    let branch = get_current_branch(dir).await?;
    Ok(SyncTarget {
        remote_ref: format!("origin/{branch}"),
    })
}

async fn remote_ref_exists(dir: &Path, remote_ref: &str) -> bool {
    git(dir, &["rev-parse", "--verify", remote_ref]).await.is_ok()
}

async fn ahead_behind(dir: &Path, remote_ref: &str) -> Result<(usize, usize), String> {
    let range = format!("HEAD...{remote_ref}");
    let counts = git(dir, &["rev-list", "--left-right", "--count", &range]).await?;
    let mut parts = counts.split_whitespace();
    let ahead = parts
        .next()
        .ok_or_else(|| format!("failed to parse git rev-list output: {}", counts.trim()))?
        .parse::<usize>()
        .map_err(|_| format!("failed to parse ahead count: {}", counts.trim()))?;
    let behind = parts
        .next()
        .ok_or_else(|| format!("failed to parse git rev-list output: {}", counts.trim()))?
        .parse::<usize>()
        .map_err(|_| format!("failed to parse behind count: {}", counts.trim()))?;
    Ok((ahead, behind))
}

/// Run a git command in the given directory.
async fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    git_with_env(dir, args, &[]).await
}

async fn git_with_env(
    dir: &Path,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(dir);
    for (key, value) in envs {
        cmd.env(key, value);
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("failed to run git: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Err(stderr)
    }
}

async fn has_remote(dir: &Path) -> bool {
    git(dir, &["remote"])
        .await
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

async fn has_local_commit(dir: &Path) -> bool {
    git(dir, &["rev-parse", "--verify", "HEAD"]).await.is_ok()
}

async fn get_current_branch(dir: &Path) -> Result<String, String> {
    let branch = git(dir, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
    Ok(branch.trim().to_string())
}

fn rebuild_index_from_worker(dir: &Path, app_handle: &tauri::AppHandle) -> Result<(), String> {
    let dir_str = dir.to_string_lossy().to_string();
    let rebuilt = crate::notes::rebuild_index(&dir_str).map_err(|e| e.to_string())?;

    if let Some(state) = app_handle.try_state::<AppState>() {
        let mut index = state.index.lock().map_err(|e| e.to_string())?;
        *index = rebuilt;
    }

    emit_notes_changed(app_handle);
    Ok(())
}

fn emit_notes_changed(app_handle: &tauri::AppHandle) {
    let _ = app_handle.emit("notes-changed", ());
}

/// Ensure the notes directory is a git repo. If not, init one.
async fn ensure_git_repo(dir: &Path) -> Result<(), String> {
    // Check if git is available.
    if Command::new("git")
        .arg("--version")
        .output()
        .await
        .is_err()
    {
        return Err("git not found".into());
    }

    let check = git(dir, &["rev-parse", "--is-inside-work-tree"]).await;
    if check.is_ok() {
        return Ok(());
    }

    // Not a repo — initialise.
    git(dir, &["init"]).await?;

    // Write .gitignore.
    let gitignore = dir.join(".gitignore");
    if !gitignore.exists() {
        std::fs::write(
            &gitignore,
            ".dump-index.json\n.DS_Store\n*.swp\n*.tmp\n",
        )
        .map_err(|e| format!("write .gitignore: {e}"))?;
    }

    // Stage .gitignore and any existing .md files.
    let _ = git(dir, &["add", ".gitignore"]).await;
    let _ = git(dir, &["add", "*.md"]).await;

    // Initial commit (only if there's something staged).
    let diff = git(dir, &["diff", "--cached", "--quiet"]).await;
    if diff.is_err() {
        let _ = git(dir, &["commit", "-m", "Initial commit"]).await;
    }

    Ok(())
}

/// On startup, commit any .md files that might have been left uncommitted after a crash.
async fn commit_leftover_md(dir: &Path) -> Result<(), String> {
    // Stage all .md files — `git add` is a no-op for unchanged files.
    let _ = git(dir, &["add", "*.md"]).await;
    let _ = git(dir, &["add", ".dump-index.json"]).await;

    let diff = git(dir, &["diff", "--cached", "--quiet"]).await;
    if diff.is_err() {
        git(dir, &["commit", "-m", "Auto-commit: recover unsaved changes"]).await?;
    }
    Ok(())
}

fn build_commit_message(changes: &[FileChange]) -> String {
    if changes.len() == 1 {
        let c = &changes[0];
        let verb = if c.is_new { "Create" } else { "Update" };
        format!("{verb}: {}", c.title)
    } else {
        let new_count = changes.iter().filter(|c| c.is_new).count();
        let update_count = changes.len() - new_count;
        let mut parts = Vec::new();
        if new_count > 0 {
            parts.push(format!(
                "Create {} note{}",
                new_count,
                if new_count == 1 { "" } else { "s" }
            ));
        }
        if update_count > 0 {
            parts.push(format!(
                "Update {} note{}",
                update_count,
                if update_count == 1 { "" } else { "s" }
            ));
        }
        parts.join(", ")
    }
}

fn emit_error(app_handle: &tauri::AppHandle, message: &str) {
    let _ = app_handle.emit("git-sync-error", message.to_string());
}

// ── Tauri commands ─────────────────────────────────────────────────

#[tauri::command]
pub fn get_git_remote(state: State<AppState>) -> Result<Option<String>, String> {
    let dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
    let output = std::process::Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(&*dir)
        .output();

    match output {
        Ok(o) if o.status.success() => {
            let url = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if url.is_empty() {
                Ok(None)
            } else {
                Ok(Some(url))
            }
        }
        _ => Ok(None),
    }
}

async fn resolve_remote_branch_for_setup(dir: &Path) -> Result<String, String> {
    if let Ok(default_ref) = git(dir, &["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]).await
    {
        let default_ref = default_ref.trim();
        if let Some(branch) = default_ref.strip_prefix("origin/") {
            if !branch.is_empty() {
                return Ok(branch.to_string());
            }
        }
        if !default_ref.is_empty() {
            return Ok(default_ref.to_string());
        }
    }

    let branch = get_current_branch(dir).await?;
    if branch == "HEAD" || branch.is_empty() {
        Ok("main".to_string())
    } else {
        Ok(branch)
    }
}

#[tauri::command]
pub async fn set_git_remote(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    url: String,
) -> Result<(), String> {
    let dir_str = {
        let dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
        dir.clone()
    };
    let dir = PathBuf::from(dir_str);

    // Try set-url first (in case remote already exists), fall back to add.
    match git(&dir, &["remote", "set-url", "origin", &url]).await {
        Ok(_) => {}
        Err(_) => {
            git(&dir, &["remote", "add", "origin", &url]).await?;
        }
    }

    git(&dir, &["fetch", "origin"]).await?;

    let branch = resolve_remote_branch_for_setup(&dir).await?;
    let remote_ref = format!("origin/{branch}");
    if remote_ref_exists(&dir, &remote_ref).await {
        let pull_res = if has_local_commit(&dir).await && git(&dir, &["merge-base", "HEAD", &remote_ref]).await.is_ok() {
            git(&dir, &["pull", "--rebase", "origin", &branch]).await
        } else {
            git(
                &dir,
                &[
                    "pull",
                    "--no-rebase",
                    "--allow-unrelated-histories",
                    "origin",
                    &branch,
                ],
            )
            .await
        };

        if let Err(e) = pull_res {
            let msg = format!(
                "Git pull failed while connecting remote. Resolve conflicts locally and retry. {}",
                e.trim()
            );
            emit_error(&app_handle, &msg);
            return Err(msg);
        }

        rebuild_index_from_worker(&dir, &app_handle)?;
    }

    push_with_retry(&dir, &app_handle, true).await?;
    Ok(())
}

#[tauri::command]
pub fn dismiss_git_setup(state: State<AppState>) -> Result<(), String> {
    let git = state.git.lock().map_err(|e| e.to_string())?;
    git.dismiss();
    Ok(())
}
