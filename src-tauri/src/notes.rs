use chrono::{Local, DateTime};
use serde::{Deserialize, Serialize};
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

/// Build frontmatter string
fn build_frontmatter(id: &str, created: &str, modified: &str, tags: &[String], starred: bool) -> String {
    let mut fm = format!("---\nid: {}\ncreated: {}\nmodified: {}\n", id, created, modified);
    if !tags.is_empty() {
        fm.push_str("tags: [");
        fm.push_str(
            &tags
                .iter()
                .map(|t| t.as_str())
                .collect::<Vec<&str>>()
                .join(", "),
        );
        fm.push_str("]\n");
    }
    if starred {
        fm.push_str("starred: true\n");
    }
    fm.push_str("---\n");
    fm
}

/// Save a note. If id is Some, update existing; otherwise create new.
pub fn save_note(
    notes_dir: &str,
    id: Option<String>,
    content: &str,
    tags: &[String],
    index: &mut NoteIndex,
) -> io::Result<NoteMetadata> {
    let now: DateTime<Local> = Local::now();
    let note_id: String;
    let created: String;
    let starred: bool;
    let file_path: PathBuf;

    let title = extract_title(content);

    if let Some(existing_id) = id {
        // Update existing note
        note_id = existing_id.clone();
        // Find existing metadata to preserve created date and starred
        if let Some(existing) = index.notes.get(&existing_id) {
            created = existing.created.clone();
            starred = existing.starred;
            file_path = Path::new(notes_dir).join(&existing.path);
        } else {
            created = now.to_rfc3339();
            starred = false;
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
        let timestamp = now.format("%Y%m%d%H%M%S").to_string();
        let slug = slugify(&title);
        let filename = format!("{}-{}.md", timestamp, slug);
        file_path = Path::new(notes_dir).join(&filename);
    }

    let modified = now.to_rfc3339();
    let frontmatter = build_frontmatter(&note_id, &created, &modified, tags, starred);
    let full_content = format!("{}\n{}", frontmatter, content);

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

/// Toggle the starred state of a note
pub fn toggle_star(
    notes_dir: &str,
    id: &str,
    index: &mut NoteIndex,
) -> io::Result<NoteMetadata> {
    let meta = index
        .notes
        .get(id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Note not found"))?
        .clone();

    let new_starred = !meta.starred;

    // Read the file and rewrite frontmatter
    let file_path = Path::new(notes_dir).join(&meta.path);
    let raw = fs::read_to_string(&file_path)?;
    let (_fm, body) = parse_frontmatter(&raw);

    let frontmatter = build_frontmatter(&meta.id, &meta.created, &meta.modified, &meta.tags, new_starred);
    let full_content = format!("{}\n{}", frontmatter, body);
    fs::write(&file_path, &full_content)?;

    let updated = NoteMetadata {
        starred: new_starred,
        ..meta
    };

    index.notes.insert(id.to_string(), updated.clone());
    save_index(notes_dir, index)?;

    Ok(updated)
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

/// List recent notes sorted by created date descending
pub fn list_recent_notes(index: &NoteIndex, limit: usize) -> Vec<NoteMetadata> {
    let mut notes: Vec<&NoteMetadata> = index.notes.values().collect();
    notes.sort_by(|a, b| b.created.cmp(&a.created));
    notes.into_iter().take(limit).cloned().collect()
}

/// Search notes by simple text matching (fallback when qmd is not available)
pub fn search_notes(
    notes_dir: &str,
    query: &str,
    index: &NoteIndex,
) -> io::Result<Vec<NoteMetadata>> {
    // First try qmd
    if let Ok(results) = search_with_qmd(notes_dir, query, index) {
        if !results.is_empty() {
            return Ok(results);
        }
    }

    // Fallback: simple text search
    let query_lower = query.to_lowercase();
    let terms: Vec<&str> = query_lower.split_whitespace().collect();

    if terms.is_empty() {
        return Ok(vec![]);
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
    Ok(results.into_iter().take(20).collect())
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
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "qmd search failed",
        ));
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

    let pattern = format!("{}/*.md", notes_dir);
    if let Ok(entries) = glob::glob(&pattern) {
        for entry in entries.flatten() {
            if let Ok(content) = fs::read_to_string(&entry) {
                let (fm, body) = parse_frontmatter(&content);
                if let Some(fm) = fm {
                    if let Some(id) = fm.id {
                        let title = extract_title(&body);
                        let filename = entry
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_string();
                        let created = fm.created.unwrap_or_default();
                        let modified = fm.modified.unwrap_or_else(|| created.clone());
                        let meta = NoteMetadata {
                            id: id.clone(),
                            path: filename,
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

    save_index(notes_dir, &index)?;
    Ok(index)
}

/// Save the index to .dump-index.json
fn save_index(notes_dir: &str, index: &NoteIndex) -> io::Result<()> {
    let index_path = Path::new(notes_dir).join(".dump-index.json");
    let json = serde_json::to_string_pretty(index)
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
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

        let meta = save_note(&dir, None, "# Test Note\n\nHello world", &["test".to_string()], &mut index).unwrap();
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

        save_note(&dir, None, "# First", &[], &mut index).unwrap();
        save_note(&dir, None, "# Second", &[], &mut index).unwrap();
        save_note(&dir, None, "# Third", &[], &mut index).unwrap();

        let recent = list_recent_notes(&index, 2);
        assert_eq!(recent.len(), 2);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_rebuild_index() {
        let dir = setup_test_dir();
        let mut index = NoteIndex::default();

        save_note(&dir, None, "# Indexed Note", &["tag1".to_string()], &mut index).unwrap();

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

        save_note(&dir, None, "# A", &["alpha".to_string(), "beta".to_string()], &mut index).unwrap();
        save_note(&dir, None, "# B", &["beta".to_string(), "gamma".to_string()], &mut index).unwrap();

        let tags = get_all_tags(&index);
        assert_eq!(tags, vec!["alpha", "beta", "gamma"]);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_search_notes_fallback() {
        let dir = setup_test_dir();
        let mut index = NoteIndex::default();

        save_note(&dir, None, "# Apple pie recipe\n\nDelicious apple pie", &[], &mut index).unwrap();
        save_note(&dir, None, "# Banana bread\n\nYummy banana bread", &[], &mut index).unwrap();

        let results = search_notes(&dir, "apple", &index).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Apple pie recipe");

        fs::remove_dir_all(&dir).ok();
    }
}
