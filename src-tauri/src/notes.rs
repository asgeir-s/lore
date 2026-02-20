use chrono::{DateTime, Local, TimeZone};
use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteMetadata {
    pub id: String,
    pub path: String,
    pub title: String,
    pub created: String,
    pub modified: String,
    pub tags: Vec<String>,
    pub starred: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteContent {
    pub id: String,
    pub title: String,
    pub content: String,
    pub tags: Vec<String>,
    pub created: String,
    pub modified: String,
    pub starred: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NoteIndex {
    pub version: u32,
    pub notes: HashMap<String, NoteMetadata>,
}

#[derive(Debug, Deserialize)]
struct Frontmatter {
    id: Option<String>,
    title: Option<String>,
    created: Option<String>,
    modified: Option<String>,
    tags: Option<Vec<String>>,
    starred: Option<bool>,
}

/// Parse frontmatter and body from markdown content
fn parse_frontmatter(content: &str) -> (Option<Frontmatter>, String) {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return (None, content.to_string());
    }

    let after_first = &trimmed[3..];
    if let Some(end_pos) = after_first.find("\n---") {
        let yaml_str = &after_first[..end_pos];
        let body = &after_first[end_pos + 4..];
        let body = body.strip_prefix('\n').unwrap_or(body);
        let fm: Option<Frontmatter> = serde_yaml::from_str(yaml_str).ok();
        (fm, body.to_string())
    } else {
        (None, content.to_string())
    }
}

/// Parse frontmatter as a raw serde_yaml::Mapping, preserving all fields
fn parse_raw_yaml(content: &str) -> (Option<Mapping>, String) {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return (None, content.to_string());
    }

    let after_first = &trimmed[3..];
    if let Some(end_pos) = after_first.find("\n---") {
        let yaml_str = &after_first[..end_pos];
        let body = &after_first[end_pos + 4..];
        let body = body.strip_prefix('\n').unwrap_or(body);
        let mapping: Option<Mapping> = serde_yaml::from_str(yaml_str).ok();
        (mapping, body.to_string())
    } else {
        (None, content.to_string())
    }
}

/// Extract title from markdown body (first # heading or first line)
fn extract_title(body: &str) -> String {
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(heading) = trimmed.strip_prefix("# ") {
            return heading.trim().to_string();
        }
        return trimmed.to_string();
    }
    "Untitled".to_string()
}

/// Generate a filename slug from a title
fn slugify(title: &str) -> String {
    let slug: String = title
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '_' {
                c
            } else if c == ' ' {
                '_'
            } else {
                '_'
            }
        })
        .collect();
    // Truncate to reasonable length
    let slug = slug.trim_matches('_').to_string();
    if slug.is_empty() {
        "untitled".to_string()
    } else if slug.len() > 50 {
        slug[..50].trim_end_matches('_').to_string()
    } else {
        slug
    }
}

fn format_meeting_title_from_tags(tags: &[String]) -> Option<String> {
    let topic_tags: Vec<&String> = tags
        .iter()
        .filter(|t| t.as_str() != "meeting")
        .take(2)
        .collect();
    if topic_tags.is_empty() {
        return None;
    }
    let tag_part = topic_tags
        .iter()
        .map(|t| {
            let mut chars = t.chars();
            match chars.next() {
                None => String::new(),
                Some(c) => c.to_lowercase().collect::<String>() + chars.as_str(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    Some(format!("Meeting about {tag_part}"))
}

fn is_auto_meeting_title(title: &str) -> bool {
    if title == "Untitled" || title == "Meeting about" || title.starts_with("Meeting about ") {
        return true;
    }
    let Some(rest) = title.strip_prefix("Meeting ") else {
        return false;
    };

    // Matches "Meeting Feb 19"
    let mut parts = rest.split_whitespace();
    if let (Some(month), Some(day), None) = (parts.next(), parts.next(), parts.next()) {
        const MONTHS: &[&str] = &[
            "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        ];
        if MONTHS.contains(&month) && day.chars().all(|c| c.is_ascii_digit()) {
            return true;
        }
    }

    // Matches "Meeting 2026-02-19 14:32"
    if rest.len() == 16 {
        let bytes = rest.as_bytes();
        if bytes[4] == b'-'
            && bytes[7] == b'-'
            && bytes[10] == b' '
            && bytes[13] == b':'
            && bytes
                .iter()
                .enumerate()
                .all(|(i, b)| matches!(i, 4 | 7 | 10 | 13) || b.is_ascii_digit())
        {
            return true;
        }
    }

    false
}

/// Build frontmatter string, merging any extra fields from a raw YAML mapping
fn build_frontmatter(
    id: &str,
    created: &str,
    modified: &str,
    tags: &[String],
    starred: bool,
    title: Option<&str>,
    extra: Option<&Mapping>,
) -> String {
    let mut map = Mapping::new();
    map.insert(Value::String("id".into()), Value::String(id.into()));
    if let Some(t) = title {
        map.insert(Value::String("title".into()), Value::String(t.into()));
    }
    map.insert(
        Value::String("created".into()),
        Value::String(created.into()),
    );
    map.insert(
        Value::String("modified".into()),
        Value::String(modified.into()),
    );
    if !tags.is_empty() {
        let seq: Vec<Value> = tags.iter().map(|t| Value::String(t.clone())).collect();
        map.insert(Value::String("tags".into()), Value::Sequence(seq));
    }
    if starred {
        map.insert(Value::String("starred".into()), Value::Bool(true));
    }

    // Merge extra fields (skip known keys)
    if let Some(extra) = extra {
        const KNOWN: &[&str] = &["id", "created", "modified", "tags", "starred", "title"];
        for (key, value) in extra {
            if let Value::String(k) = key {
                if !KNOWN.contains(&k.as_str()) {
                    map.insert(key.clone(), value.clone());
                }
            }
        }
    }

    let yaml_str = serde_yaml::to_string(&map).unwrap_or_default();
    // serde_yaml::to_string may prepend "---\n"; strip it since we add our own
    let yaml_body = yaml_str.strip_prefix("---\n").unwrap_or(&yaml_str);
    format!("---\n{}---\n", yaml_body)
}

/// Save a note. If id is Some, update existing; otherwise create new.
/// When `title` is None, auto-extract from content.
pub fn save_note(
    notes_dir: &str,
    id: Option<String>,
    content: &str,
    tags: &[String],
    title: Option<String>,
    index: &mut NoteIndex,
) -> io::Result<NoteMetadata> {
    let now: DateTime<Local> = Local::now();
    let note_id: String;
    let created: String;
    let starred: bool;
    let file_path: PathBuf;
    let extra: Option<Mapping>;

    let title = title.unwrap_or_else(|| extract_title(content));

    if let Some(existing_id) = id {
        // Update existing note
        note_id = existing_id.clone();
        if let Some(existing) = index.notes.get(&existing_id) {
            created = existing.created.clone();
            starred = existing.starred;
            file_path = Path::new(notes_dir).join(&existing.path);
            // Read existing file to preserve extra frontmatter fields
            extra = if file_path.exists() {
                let raw = fs::read_to_string(&file_path).unwrap_or_default();
                let (mapping, _) = parse_raw_yaml(&raw);
                mapping
            } else {
                None
            };
        } else {
            created = now.to_rfc3339();
            starred = false;
            extra = None;
            let timestamp = now.format("%Y%m%d%H%M%S").to_string();
            let slug = slugify(&title);
            let filename = format!("{}-{}.md", timestamp, slug);
            file_path = Path::new(notes_dir).join(&filename);
        }
    } else {
        // New note
        note_id = Uuid::new_v4().to_string();
        created = now.to_rfc3339();
        starred = false;
        extra = None;
        let timestamp = now.format("%Y%m%d%H%M%S").to_string();
        let slug = slugify(&title);
        let filename = format!("{}-{}.md", timestamp, slug);
        file_path = Path::new(notes_dir).join(&filename);
    }

    let modified = now.to_rfc3339();
    let frontmatter = build_frontmatter(
        &note_id,
        &created,
        &modified,
        tags,
        starred,
        Some(&title),
        extra.as_ref(),
    );
    let full_content = format!("{}{}", frontmatter, content);

    fs::write(&file_path, &full_content)?;

    let filename = file_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let meta = NoteMetadata {
        id: note_id.clone(),
        path: filename,
        title,
        created,
        modified,
        tags: tags.to_vec(),
        starred,
    };

    index.notes.insert(note_id, meta.clone());

    // Save index
    save_index(notes_dir, index)?;

    Ok(meta)
}

/// Append meeting summary/transcript to an existing note and ensure it has the `meeting` tag.
pub fn append_meeting_data(
    notes_dir: &str,
    id: &str,
    summary: &str,
    transcript: &str,
    index: &mut NoteIndex,
) -> io::Result<NoteMetadata> {
    let meta = index
        .notes
        .get(id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Note not found"))?
        .clone();

    let file_path = Path::new(notes_dir).join(&meta.path);
    let raw = fs::read_to_string(&file_path)?;
    let (raw_yaml, body) = parse_raw_yaml(&raw);

    let mut tags = meta.tags.clone();
    if !tags.iter().any(|t| t == "meeting") {
        tags.push("meeting".to_string());
    }

    let has_summary = body.lines().any(|line| line.trim() == "## Summary");
    let has_transcript = body.lines().any(|line| line.trim() == "## Transcript");
    let content = if has_summary && has_transcript {
        body
    } else {
        let trimmed = body.trim_end();
        let separator = if trimmed.is_empty() { "" } else { "\n\n" };
        format!("{trimmed}{separator}## Summary\n\n{summary}\n\n## Transcript\n\n{transcript}\n")
    };

    // Keep user-defined titles. Replace only known auto-generated placeholders.
    let title = if is_auto_meeting_title(&meta.title) {
        format_meeting_title_from_tags(&tags).unwrap_or_else(|| "Meeting about".to_string())
    } else {
        meta.title.clone()
    };

    let modified = Local::now().to_rfc3339();
    let frontmatter = build_frontmatter(
        &meta.id,
        &meta.created,
        &modified,
        &tags,
        meta.starred,
        Some(&title),
        raw_yaml.as_ref(),
    );
    let full_content = format!("{frontmatter}{content}");
    fs::write(&file_path, full_content)?;

    let updated = NoteMetadata {
        title,
        modified,
        tags,
        ..meta
    };
    index.notes.insert(id.to_string(), updated.clone());
    save_index(notes_dir, index)?;

    Ok(updated)
}

/// Extract the transcript text from a meeting note.
pub fn get_note_transcript(notes_dir: &str, id: &str, index: &NoteIndex) -> io::Result<String> {
    let meta = index
        .notes
        .get(id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Note not found"))?;
    let file_path = Path::new(notes_dir).join(&meta.path);
    let raw = fs::read_to_string(&file_path)?;
    let (_, body) = parse_raw_yaml(&raw);
    let transcript = extract_section(&body, "## Transcript")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "No transcript section found"))?;
    Ok(transcript)
}

/// Replace only the `## Transcript` section of a meeting note.
pub fn replace_meeting_transcript(
    notes_dir: &str,
    id: &str,
    transcript: &str,
    index: &mut NoteIndex,
) -> io::Result<NoteMetadata> {
    let meta = index
        .notes
        .get(id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Note not found"))?
        .clone();
    let file_path = Path::new(notes_dir).join(&meta.path);
    let raw = fs::read_to_string(&file_path)?;
    let (raw_yaml, body) = parse_raw_yaml(&raw);

    let pos = body
        .find("## Transcript")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "No transcript section found"))?;
    let new_body = format!("{}## Transcript\n\n{}\n", &body[..pos], transcript);

    write_meeting_section(notes_dir, &meta, raw_yaml, new_body, index, &file_path)
}

/// Replace only the `## Summary` section of a meeting note.
pub fn replace_meeting_summary(
    notes_dir: &str,
    id: &str,
    summary: &str,
    index: &mut NoteIndex,
) -> io::Result<NoteMetadata> {
    let meta = index
        .notes
        .get(id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Note not found"))?
        .clone();
    let file_path = Path::new(notes_dir).join(&meta.path);
    let raw = fs::read_to_string(&file_path)?;
    let (raw_yaml, body) = parse_raw_yaml(&raw);

    let sum_pos = body
        .find("## Summary")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "No summary section found"))?;
    let trans_pos = body
        .find("## Transcript")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "No transcript section found"))?;
    let new_body = format!(
        "{}## Summary\n\n{}\n\n{}",
        &body[..sum_pos],
        summary,
        &body[trans_pos..]
    );

    write_meeting_section(notes_dir, &meta, raw_yaml, new_body, index, &file_path)
}

fn extract_section(body: &str, header: &str) -> Option<String> {
    let pos = body.find(header)?;
    let after = &body[pos + header.len()..];
    Some(after.trim_start_matches('\n').trim_end().to_string())
}

fn write_meeting_section(
    notes_dir: &str,
    meta: &NoteMetadata,
    raw_yaml: Option<serde_yaml::Mapping>,
    body: String,
    index: &mut NoteIndex,
    file_path: &Path,
) -> io::Result<NoteMetadata> {
    let modified = Local::now().to_rfc3339();
    let frontmatter = build_frontmatter(
        &meta.id,
        &meta.created,
        &modified,
        &meta.tags,
        meta.starred,
        Some(&meta.title),
        raw_yaml.as_ref(),
    );
    let full_content = format!("{frontmatter}{body}");
    fs::write(file_path, full_content)?;

    let updated = NoteMetadata {
        modified,
        ..meta.clone()
    };
    index.notes.insert(meta.id.clone(), updated.clone());
    save_index(notes_dir, index)?;
    Ok(updated)
}

/// Toggle the starred state of a note
pub fn toggle_star(notes_dir: &str, id: &str, index: &mut NoteIndex) -> io::Result<NoteMetadata> {
    let meta = index
        .notes
        .get(id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Note not found"))?
        .clone();

    let new_starred = !meta.starred;

    // Read the file, preserving extra frontmatter fields
    let file_path = Path::new(notes_dir).join(&meta.path);
    let raw = fs::read_to_string(&file_path)?;
    let (raw_yaml, body) = parse_raw_yaml(&raw);

    let frontmatter = build_frontmatter(
        &meta.id,
        &meta.created,
        &meta.modified,
        &meta.tags,
        new_starred,
        Some(&meta.title),
        raw_yaml.as_ref(),
    );
    let full_content = format!("{}{}", frontmatter, body);
    fs::write(&file_path, &full_content)?;

    let updated = NoteMetadata {
        starred: new_starred,
        ..meta
    };

    index.notes.insert(id.to_string(), updated.clone());
    save_index(notes_dir, index)?;

    Ok(updated)
}

/// Set auto-generated tags on a note that currently has no tags.
/// When `force` is true, overwrite existing tags (used by regenerate).
/// Returns Some(updated metadata) if tags were applied, None if skipped.
pub fn set_auto_tags(
    notes_dir: &str,
    id: &str,
    tags: &[String],
    index: &mut NoteIndex,
    force: bool,
) -> io::Result<Option<NoteMetadata>> {
    let meta = match index.notes.get(id) {
        Some(m) => m.clone(),
        None => return Ok(None),
    };

    if tags.is_empty() {
        return Ok(None);
    }

    let is_meeting_note =
        meta.tags.iter().any(|t| t == "meeting") || meta.path.starts_with("meetings/");

    // Normal flow:
    // - For regular notes, only auto-tag when empty.
    // - For meeting notes, merge generated tags into existing tags.
    // - For forced regenerate, replace tags.
    let next_tags = if force {
        let mut next = tags.to_vec();
        if is_meeting_note && !next.iter().any(|t| t == "meeting") {
            next.push("meeting".to_string());
        }
        next
    } else if meta.tags.is_empty() {
        tags.to_vec()
    } else if is_meeting_note {
        let mut merged = meta.tags.clone();
        for tag in tags {
            if !merged.iter().any(|t| t == tag) {
                merged.push(tag.clone());
            }
        }
        if merged == meta.tags {
            return Ok(None);
        }
        merged
    } else {
        return Ok(None);
    };

    let mut next_title = meta.title.clone();
    if !force && is_meeting_note && is_auto_meeting_title(&meta.title) {
        // For auto meeting titles, prefer the freshly generated backend tags
        // so "Meeting about ..." reflects new inferred topics.
        next_title = format_meeting_title_from_tags(tags)
            .or_else(|| format_meeting_title_from_tags(&next_tags))
            .unwrap_or_else(|| "Meeting about".to_string());
    }

    // Read the file and update frontmatter with new tags
    let file_path = Path::new(notes_dir).join(&meta.path);
    let raw = fs::read_to_string(&file_path)?;
    let (raw_yaml, body) = parse_raw_yaml(&raw);

    let frontmatter = build_frontmatter(
        &meta.id,
        &meta.created,
        &meta.modified,
        &next_tags,
        meta.starred,
        Some(&next_title),
        raw_yaml.as_ref(),
    );
    let full_content = format!("{}{}", frontmatter, body);
    fs::write(&file_path, &full_content)?;

    let updated = NoteMetadata {
        tags: next_tags,
        title: next_title,
        ..meta
    };

    index.notes.insert(id.to_string(), updated.clone());
    save_index(notes_dir, index)?;

    Ok(Some(updated))
}

/// Delete a note by ID
pub fn delete_note(notes_dir: &str, id: &str, index: &mut NoteIndex) -> io::Result<()> {
    let meta = index
        .notes
        .get(id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Note not found"))?
        .clone();

    let file_path = Path::new(notes_dir).join(&meta.path);
    if file_path.exists() {
        fs::remove_file(&file_path)?;
    }

    index.notes.remove(id);
    save_index(notes_dir, index)?;

    Ok(())
}

/// Get a note by ID
pub fn get_note(notes_dir: &str, id: &str, index: &NoteIndex) -> io::Result<NoteContent> {
    let meta = index
        .notes
        .get(id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Note not found"))?;

    let file_path = Path::new(notes_dir).join(&meta.path);
    let raw = fs::read_to_string(&file_path)?;
    let (_fm, body) = parse_frontmatter(&raw);

    Ok(NoteContent {
        id: meta.id.clone(),
        title: meta.title.clone(),
        content: body,
        tags: meta.tags.clone(),
        created: meta.created.clone(),
        modified: meta.modified.clone(),
        starred: meta.starred,
    })
}

/// List recent notes sorted by the given field descending, starred pinned to top
pub fn list_recent_notes(index: &NoteIndex, limit: usize, sort_by: &str) -> Vec<NoteMetadata> {
    let mut notes: Vec<&NoteMetadata> = index.notes.values().collect();
    notes.sort_by(|a, b| {
        // Starred notes first
        b.starred.cmp(&a.starred).then_with(|| match sort_by {
            "modified" => b.modified.cmp(&a.modified),
            _ => b.created.cmp(&a.created),
        })
    });
    notes.into_iter().take(limit).cloned().collect()
}

/// Fuzzy-match `query` against `target` by walking query chars in order through target.
/// Returns `None` if not all query chars are found in order.
/// Scoring: +1 per matched char, +2 for word-boundary matches, +3 for consecutive matches.
fn fuzzy_score(query: &str, target: &str) -> Option<i32> {
    let query_lower: Vec<char> = query.to_lowercase().chars().collect();
    let target_lower: Vec<char> = target.to_lowercase().chars().collect();

    if query_lower.is_empty() {
        return None;
    }

    let mut score: i32 = 0;
    let mut qi = 0;
    let mut last_match: Option<usize> = None;

    for (ti, tc) in target_lower.iter().enumerate() {
        if qi < query_lower.len() && *tc == query_lower[qi] {
            score += 1; // base point per match

            // Word-boundary bonus: start of string, or after space/_/-
            if ti == 0 || matches!(target_lower.get(ti.wrapping_sub(1)), Some(' ' | '_' | '-')) {
                score += 2;
            }

            // Consecutive bonus
            if last_match == Some(ti.wrapping_sub(1)) {
                score += 3;
            }

            last_match = Some(ti);
            qi += 1;
        }
    }

    if qi == query_lower.len() {
        Some(score)
    } else {
        None
    }
}

/// Search notes by simple text matching (fallback when qmd is not available)
pub fn search_notes(
    notes_dir: &str,
    query: &str,
    index: &NoteIndex,
) -> io::Result<Vec<NoteMetadata>> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }

    let mut seen = std::collections::HashSet::new();
    let mut merged: Vec<NoteMetadata> = Vec::new();

    // 1. Fuzzy title matches from in-memory index
    let mut fuzzy_hits: Vec<(i32, &NoteMetadata)> = index
        .notes
        .values()
        .filter_map(|meta| fuzzy_score(query, &meta.title).map(|s| (s, meta)))
        .collect();
    fuzzy_hits.sort_by(|a, b| b.0.cmp(&a.0));

    for (_, meta) in &fuzzy_hits {
        if seen.insert(meta.id.clone()) {
            merged.push((*meta).clone());
        }
    }

    // 2. Content matches (qmd first, then substring fallback)
    let content_results = if let Ok(results) = search_with_qmd(notes_dir, query, index) {
        if !results.is_empty() {
            results
        } else {
            content_search_fallback(notes_dir, query, index)
        }
    } else {
        content_search_fallback(notes_dir, query, index)
    };

    for meta in content_results {
        if seen.insert(meta.id.clone()) {
            merged.push(meta);
        }
    }

    Ok(merged.into_iter().take(20).collect())
}

/// Fallback content search using simple substring matching
fn content_search_fallback(notes_dir: &str, query: &str, index: &NoteIndex) -> Vec<NoteMetadata> {
    let query_lower = query.to_lowercase();
    let terms: Vec<&str> = query_lower.split_whitespace().collect();

    if terms.is_empty() {
        return vec![];
    }

    let mut results: Vec<NoteMetadata> = Vec::new();

    for meta in index.notes.values() {
        let file_path = Path::new(notes_dir).join(&meta.path);
        if let Ok(content) = fs::read_to_string(&file_path) {
            let content_lower = content.to_lowercase();
            let matches = terms.iter().any(|term| content_lower.contains(term));
            if matches {
                results.push(meta.clone());
            }
        }
    }

    results.sort_by(|a, b| b.created.cmp(&a.created));
    results
}

/// Try to search using qmd
fn search_with_qmd(
    notes_dir: &str,
    query: &str,
    index: &NoteIndex,
) -> io::Result<Vec<NoteMetadata>> {
    let output = std::process::Command::new("qmd")
        .args(["search", query])
        .current_dir(notes_dir)
        .output()?;

    if !output.status.success() {
        return Err(io::Error::new(io::ErrorKind::Other, "qmd search failed"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut results: Vec<NoteMetadata> = Vec::new();

    for line in stdout.lines() {
        let path = line.trim();
        if path.is_empty() {
            continue;
        }
        // Find note in index by path
        for meta in index.notes.values() {
            if meta.path == path || path.ends_with(&meta.path) {
                results.push(meta.clone());
                break;
            }
        }
    }

    Ok(results)
}

/// Rebuild the full index by scanning all .md files
pub fn rebuild_index(notes_dir: &str) -> io::Result<NoteIndex> {
    let mut index = NoteIndex {
        version: 1,
        notes: HashMap::new(),
    };

    let dir_path = Path::new(notes_dir);
    if !dir_path.exists() {
        return Ok(index);
    }

    // Scan both top-level and meetings/ subdirectory.
    let patterns = [
        format!("{}/*.md", notes_dir),
        format!("{}/meetings/*.md", notes_dir),
    ];
    for pattern in &patterns {
        if let Ok(entries) = glob::glob(pattern) {
            for entry in entries.flatten() {
                if let Ok(content) = fs::read_to_string(&entry) {
                    let (fm, body) = parse_frontmatter(&content);
                    if let Some(fm) = fm {
                        if let Some(id) = fm.id {
                            let title = fm.title.unwrap_or_else(|| extract_title(&body));
                            // Store relative path from notes_dir.
                            let rel_path = entry
                                .strip_prefix(notes_dir)
                                .unwrap_or(&entry)
                                .to_string_lossy()
                                .trim_start_matches('/')
                                .to_string();
                            let created = fm.created.unwrap_or_default();
                            let modified = fm.modified.unwrap_or_else(|| created.clone());
                            let meta = NoteMetadata {
                                id: id.clone(),
                                path: rel_path,
                                title,
                                created,
                                modified,
                                tags: fm.tags.unwrap_or_default(),
                                starred: fm.starred.unwrap_or(false),
                            };
                            index.notes.insert(id, meta);
                        }
                    }
                }
            }
        }
    }

    save_index(notes_dir, &index)?;
    Ok(index)
}

/// Save the index to .dump-index.json (public for use by recording module)
pub fn save_index_pub(notes_dir: &str, index: &NoteIndex) -> io::Result<()> {
    save_index(notes_dir, index)
}

/// Save the index to .dump-index.json
fn save_index(notes_dir: &str, index: &NoteIndex) -> io::Result<()> {
    let index_path = Path::new(notes_dir).join(".dump-index.json");
    let json =
        serde_json::to_string_pretty(index).map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
    fs::write(index_path, json)
}

/// Get all unique tags across all notes
pub fn get_all_tags(index: &NoteIndex) -> Vec<String> {
    let mut tags: BTreeSet<String> = BTreeSet::new();
    for meta in index.notes.values() {
        for tag in &meta.tags {
            tags.insert(tag.clone());
        }
    }
    tags.into_iter().collect()
}

/// Extract Notion-style inline metadata from body text after the title heading.
/// Returns (extra_fields, cleaned_body) where metadata lines are removed from body.
fn extract_notion_metadata(body: &str) -> (Mapping, String) {
    let mut extra = Mapping::new();
    let lines: Vec<&str> = body.lines().collect();
    let mut cleaned_lines: Vec<&str> = Vec::new();
    let mut i = 0;
    let mut title_text: Option<String> = None;

    // Find the first # heading (title)
    while i < lines.len() {
        let trimmed = lines[i].trim();
        if trimmed.starts_with("# ") {
            title_text = Some(trimmed[2..].trim().to_string());
            cleaned_lines.push(lines[i]);
            i += 1;
            break;
        }
        cleaned_lines.push(lines[i]);
        i += 1;
    }

    // After title, consume metadata lines (key: value) and empty lines
    while i < lines.len() {
        let trimmed = lines[i].trim();

        if trimmed.is_empty() {
            i += 1;
            continue;
        }

        // Skip duplicate title heading (Notion repeats the title)
        if let Some(ref title) = title_text {
            if trimmed.starts_with("# ") && trimmed[2..].trim() == title.as_str() {
                i += 1;
                continue;
            }
        }

        // Check for key: value pattern
        if let Some(colon_pos) = trimmed.find(": ") {
            let key = &trimmed[..colon_pos];
            let value = &trimmed[colon_pos + 2..];

            // Validate: key should be short, alphanumeric/spaces/dashes
            if !key.is_empty()
                && key.len() < 30
                && key
                    .chars()
                    .all(|c| c.is_alphanumeric() || c == '_' || c == ' ' || c == '-')
                && !key.contains("  ")
            {
                let normalized_key = key.to_lowercase().replace(' ', "_").replace('-', "_");
                extra.insert(
                    Value::String(normalized_key),
                    Value::String(value.to_string()),
                );
                i += 1;
                continue;
            }
        }

        // Not metadata — stop consuming
        break;
    }

    // Add remaining lines
    while i < lines.len() {
        cleaned_lines.push(lines[i]);
        i += 1;
    }

    (extra, cleaned_lines.join("\n"))
}

/// Parse natural-language dates like "January 12, 2026" into RFC3339.
fn parse_natural_date(s: &str) -> Option<String> {
    const MONTHS: &[(&str, u32)] = &[
        ("january", 1),
        ("february", 2),
        ("march", 3),
        ("april", 4),
        ("may", 5),
        ("june", 6),
        ("july", 7),
        ("august", 8),
        ("september", 9),
        ("october", 10),
        ("november", 11),
        ("december", 12),
    ];

    let lower = s.trim().to_lowercase();

    for (month_name, month_num) in MONTHS {
        if lower.starts_with(month_name) {
            let rest = lower[month_name.len()..].trim();
            let parts: Vec<&str> = rest
                .split(|c: char| c == ',' || c.is_whitespace())
                .filter(|p| !p.is_empty())
                .collect();
            if parts.len() == 2 {
                if let (Ok(day), Ok(year)) = (parts[0].parse::<u32>(), parts[1].parse::<i32>()) {
                    let date = chrono::NaiveDate::from_ymd_opt(year, *month_num, day)?;
                    let datetime = date.and_hms_opt(0, 0, 0)?;
                    let local = Local.from_local_datetime(&datetime).single()?;
                    return Some(local.to_rfc3339());
                }
            }
        }
    }

    None
}

/// Import an external markdown file into the notes directory.
/// Handles both YAML frontmatter files and Notion-style inline metadata.
pub fn import_markdown_file(
    notes_dir: &str,
    source_path: &str,
    index: &mut NoteIndex,
) -> io::Result<NoteMetadata> {
    let raw = fs::read_to_string(source_path)?;
    let now: DateTime<Local> = Local::now();

    let (raw_yaml, body) = parse_raw_yaml(&raw);

    let (extra, body) = if let Some(yaml) = raw_yaml {
        // File has YAML frontmatter — preserve all fields
        (yaml, body)
    } else {
        // Check for Notion-style inline metadata
        let (notion_meta, cleaned_body) = extract_notion_metadata(&body);
        (notion_meta, cleaned_body)
    };

    // Always generate a new UUID to avoid ID collisions
    let note_id = Uuid::new_v4().to_string();

    // Use date from metadata if available
    let created = extra
        .get(Value::String("date".into()))
        .and_then(|v| v.as_str())
        .and_then(parse_natural_date)
        .or_else(|| {
            extra
                .get(Value::String("created".into()))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| now.to_rfc3339());

    let modified = now.to_rfc3339();
    let title = extract_title(&body);
    let tags: Vec<String> = extra
        .get(Value::String("tags".into()))
        .and_then(|v| match v {
            Value::Sequence(seq) => Some(
                seq.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect(),
            ),
            _ => None,
        })
        .unwrap_or_default();
    let starred = extra
        .get(Value::String("starred".into()))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let frontmatter = build_frontmatter(
        &note_id,
        &created,
        &modified,
        &tags,
        starred,
        Some(&title),
        Some(&extra),
    );
    let full_content = format!("{}{}", frontmatter, body);

    let timestamp = now.format("%Y%m%d%H%M%S").to_string();
    let slug = slugify(&title);
    let filename = format!("{}-{}.md", timestamp, slug);
    let file_path = Path::new(notes_dir).join(&filename);

    fs::write(&file_path, &full_content)?;

    let meta = NoteMetadata {
        id: note_id.clone(),
        path: filename,
        title,
        created,
        modified,
        tags,
        starred,
    };

    index.notes.insert(note_id, meta.clone());
    save_index(notes_dir, index)?;

    Ok(meta)
}

/// Import markdown files from notes_dir/inbox into the normal notes directory.
/// Imported files are removed from inbox after successful conversion.
pub fn import_inbox_markdown(
    notes_dir: &str,
    index: &mut NoteIndex,
) -> io::Result<Vec<NoteMetadata>> {
    let inbox_dir = Path::new(notes_dir).join("inbox");
    if !inbox_dir.exists() {
        return Ok(Vec::new());
    }

    let patterns = [
        format!("{}/inbox/*.md", notes_dir),
        format!("{}/inbox/**/*.md", notes_dir),
    ];

    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut sources: Vec<PathBuf> = Vec::new();
    for pattern in &patterns {
        if let Ok(entries) = glob::glob(pattern) {
            for entry in entries.flatten() {
                if !entry.is_file() {
                    continue;
                }
                let key = entry.to_string_lossy().to_string();
                if seen.insert(key) {
                    sources.push(entry);
                }
            }
        }
    }

    sources.sort();

    let mut imported: Vec<NoteMetadata> = Vec::new();
    for source in sources {
        let source_path = source.to_string_lossy().to_string();
        let meta = import_markdown_file(notes_dir, &source_path, index)?;
        fs::remove_file(&source)?;
        imported.push(meta);
    }

    Ok(imported)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn setup_test_dir() -> String {
        let dir = format!("/tmp/dump_test_{}", Uuid::new_v4());
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_parse_frontmatter() {
        let content = "---\nid: abc-123\ncreated: 2026-01-01T00:00:00+00:00\ntags: [test, demo]\n---\n# Hello\n\nWorld";
        let (fm, body) = parse_frontmatter(content);
        assert!(fm.is_some());
        let fm = fm.unwrap();
        assert_eq!(fm.id.unwrap(), "abc-123");
        assert_eq!(fm.tags.unwrap(), vec!["test", "demo"]);
        assert!(body.contains("# Hello"));
        assert!(body.contains("World"));
    }

    #[test]
    fn test_extract_title() {
        assert_eq!(extract_title("# My Title\n\nContent"), "My Title");
        assert_eq!(extract_title("Just text"), "Just text");
        assert_eq!(extract_title(""), "Untitled");
    }

    #[test]
    fn test_slugify() {
        assert_eq!(slugify("My Note Title"), "my_note_title");
        assert_eq!(slugify("Hello World!"), "hello_world");
        assert_eq!(slugify(""), "untitled");
    }

    #[test]
    fn test_save_and_get_note() {
        let dir = setup_test_dir();
        let mut index = NoteIndex::default();

        let meta = save_note(
            &dir,
            None,
            "# Test Note\n\nHello world",
            &["test".to_string()],
            None,
            &mut index,
        )
        .unwrap();
        assert_eq!(meta.title, "Test Note");
        assert!(!meta.id.is_empty());

        let note = get_note(&dir, &meta.id, &index).unwrap();
        assert_eq!(note.title, "Test Note");
        assert!(note.content.contains("Hello world"));
        assert_eq!(note.tags, vec!["test"]);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_list_recent_notes() {
        let dir = setup_test_dir();
        let mut index = NoteIndex::default();

        save_note(&dir, None, "# First", &[], None, &mut index).unwrap();
        save_note(&dir, None, "# Second", &[], None, &mut index).unwrap();
        save_note(&dir, None, "# Third", &[], None, &mut index).unwrap();

        let recent = list_recent_notes(&index, 2, "created");
        assert_eq!(recent.len(), 2);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_rebuild_index() {
        let dir = setup_test_dir();
        let mut index = NoteIndex::default();

        save_note(
            &dir,
            None,
            "# Indexed Note",
            &["tag1".to_string()],
            None,
            &mut index,
        )
        .unwrap();

        // Rebuild from scratch
        let rebuilt = rebuild_index(&dir).unwrap();
        assert_eq!(rebuilt.notes.len(), 1);
        let note = rebuilt.notes.values().next().unwrap();
        assert_eq!(note.title, "Indexed Note");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_get_all_tags() {
        let dir = setup_test_dir();
        let mut index = NoteIndex::default();

        save_note(
            &dir,
            None,
            "# A",
            &["alpha".to_string(), "beta".to_string()],
            None,
            &mut index,
        )
        .unwrap();
        save_note(
            &dir,
            None,
            "# B",
            &["beta".to_string(), "gamma".to_string()],
            None,
            &mut index,
        )
        .unwrap();

        let tags = get_all_tags(&index);
        assert_eq!(tags, vec!["alpha", "beta", "gamma"]);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_search_notes_fallback() {
        let dir = setup_test_dir();
        let mut index = NoteIndex::default();

        save_note(
            &dir,
            None,
            "# Apple pie recipe\n\nDelicious apple pie",
            &[],
            None,
            &mut index,
        )
        .unwrap();
        save_note(
            &dir,
            None,
            "# Banana bread\n\nYummy banana bread",
            &[],
            None,
            &mut index,
        )
        .unwrap();

        let results = search_notes(&dir, "apple", &index).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Apple pie recipe");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_fuzzy_score_basic() {
        // All chars found in order
        assert!(fuzzy_score("mn", "Meeting Notes").is_some());
        // Not all chars found
        assert!(fuzzy_score("zz", "Meeting Notes").is_none());
        // Empty query
        assert!(fuzzy_score("", "Meeting Notes").is_none());
    }

    #[test]
    fn test_fuzzy_score_word_boundary() {
        let s1 = fuzzy_score("mn", "Meeting Notes").unwrap();
        let s2 = fuzzy_score("mn", "ameeting bnotes").unwrap();
        // Word-boundary matches should score higher
        assert!(s1 > s2);
    }

    #[test]
    fn test_fuzzy_score_consecutive() {
        let s1 = fuzzy_score("meet", "Meeting Notes").unwrap();
        let s2 = fuzzy_score("meet", "My extra extra things").unwrap();
        // Consecutive matches should score higher
        assert!(s1 > s2);
    }

    #[test]
    fn test_fuzzy_score_case_insensitive() {
        assert_eq!(fuzzy_score("MTG", "Meeting"), fuzzy_score("mtg", "Meeting"));
    }

    #[test]
    fn test_search_notes_fuzzy_title() {
        let dir = setup_test_dir();
        let mut index = NoteIndex::default();

        save_note(
            &dir,
            None,
            "# Meeting Notes\n\nSome content",
            &[],
            None,
            &mut index,
        )
        .unwrap();
        save_note(
            &dir,
            None,
            "# Quick Start Guide\n\nAnother doc",
            &[],
            None,
            &mut index,
        )
        .unwrap();
        save_note(
            &dir,
            None,
            "# Random Thoughts\n\nUnrelated",
            &[],
            None,
            &mut index,
        )
        .unwrap();

        // "mtg" fuzzy matches "Meeting" (m-t from Mee_t_ing, g from Meetin_g_... wait, no g in Meeting)
        // Actually: "mtg" → M(eeting) → no t or g... Let me think.
        // M-e-e-t-i-n-g  N-o-t-e-s: m✓, t✓ (pos 3), g✓ (pos 6)  → matches!
        let results = search_notes(&dir, "mtg", &index).unwrap();
        assert!(results.iter().any(|r| r.title == "Meeting Notes"));

        // "qck" fuzzy matches "Quick" → q✓, c✓ (pos 3 in "Quick"), k✓ (pos 4)
        let results = search_notes(&dir, "qck", &index).unwrap();
        assert!(results.iter().any(|r| r.title == "Quick Start Guide"));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_search_notes_deduplication() {
        let dir = setup_test_dir();
        let mut index = NoteIndex::default();

        // Title AND content both match "apple"
        save_note(
            &dir,
            None,
            "# Apple pie recipe\n\nDelicious apple pie",
            &[],
            None,
            &mut index,
        )
        .unwrap();

        let results = search_notes(&dir, "apple", &index).unwrap();
        // Should appear only once despite matching both fuzzy title and content
        assert_eq!(
            results
                .iter()
                .filter(|r| r.title == "Apple pie recipe")
                .count(),
            1
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_import_inbox_markdown() {
        let dir = setup_test_dir();
        let mut index = NoteIndex::default();

        let inbox = Path::new(&dir).join("inbox");
        fs::create_dir_all(&inbox).unwrap();
        let source = inbox.join("phone-note.md");
        fs::write(&source, "# Inbox note\n\nFrom phone").unwrap();

        let imported = import_inbox_markdown(&dir, &mut index).unwrap();
        assert_eq!(imported.len(), 1);
        assert!(!source.exists());

        let meta = &imported[0];
        let imported_file = Path::new(&dir).join(&meta.path);
        assert!(imported_file.exists());

        let raw = fs::read_to_string(imported_file).unwrap();
        let (fm, body) = parse_frontmatter(&raw);
        assert!(fm.is_some());
        assert!(body.contains("From phone"));

        fs::remove_dir_all(&dir).ok();
    }
}
