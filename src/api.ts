import { invoke } from "@tauri-apps/api/core";

export interface NoteMetadata {
  id: string;
  path: string;
  title: string;
  created: string;
  modified: string;
  tags: string[];
  starred: boolean;
}

export interface NoteContent {
  id: string;
  title: string;
  content: string;
  tags: string[];
  created: string;
  modified: string;
  starred: boolean;
}

/** Check if we're running inside Tauri */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// In-memory store for web-only mode (dev without Tauri)
let memoryNotes: Map<string, { meta: NoteMetadata; content: string }> =
  new Map();

function generateId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export async function saveNote(
  id: string | null,
  content: string,
  tags: string[],
): Promise<NoteMetadata> {
  if (isTauri()) {
    return invoke<NoteMetadata>("save_note", { id, content, tags });
  }
  // Fallback for web dev
  const noteId = id ?? generateId();
  const title = extractTitle(content);
  const now = new Date().toISOString();
  const existing = memoryNotes.get(noteId);
  const meta: NoteMetadata = {
    id: noteId,
    path: `${noteId}.md`,
    title,
    created: existing?.meta.created ?? now,
    modified: now,
    tags,
    starred: existing?.meta.starred ?? false,
  };
  memoryNotes.set(noteId, { meta, content });
  return meta;
}

export async function getNote(id: string): Promise<NoteContent> {
  if (isTauri()) {
    return invoke<NoteContent>("get_note", { id });
  }
  const note = memoryNotes.get(id);
  if (!note) throw new Error("Note not found");
  return {
    id,
    title: note.meta.title,
    content: note.content,
    tags: note.meta.tags,
    created: note.meta.created,
    modified: note.meta.modified,
    starred: note.meta.starred,
  };
}

export type SortBy = "created" | "modified";

export async function listRecentNotes(
  limit: number = 20,
  sortBy: SortBy = "created",
): Promise<NoteMetadata[]> {
  if (isTauri()) {
    return invoke<NoteMetadata[]>("list_recent_notes", { limit, sortBy });
  }
  const notes = Array.from(memoryNotes.values())
    .map((n) => n.meta)
    .sort((a, b) => {
      // Starred notes first
      if (a.starred !== b.starred) return a.starred ? -1 : 1;
      return sortBy === "modified"
        ? b.modified.localeCompare(a.modified)
        : b.created.localeCompare(a.created);
    });
  return notes.slice(0, limit);
}

export async function searchNotes(query: string): Promise<NoteMetadata[]> {
  if (isTauri()) {
    return invoke<NoteMetadata[]>("search_notes", { query });
  }
  const q = query.toLowerCase();
  const results: NoteMetadata[] = [];
  for (const [, note] of memoryNotes) {
    if (
      note.content.toLowerCase().includes(q) ||
      note.meta.title.toLowerCase().includes(q)
    ) {
      results.push(note.meta);
    }
  }
  return results;
}

export async function getAllTags(): Promise<string[]> {
  if (isTauri()) {
    return invoke<string[]>("get_all_tags");
  }
  const tags = new Set<string>();
  for (const [, note] of memoryNotes) {
    for (const tag of note.meta.tags) {
      tags.add(tag);
    }
  }
  return Array.from(tags).sort();
}

export async function toggleStar(id: string): Promise<NoteMetadata> {
  if (isTauri()) {
    return invoke<NoteMetadata>("toggle_star", { id });
  }
  const note = memoryNotes.get(id);
  if (!note) throw new Error("Note not found");
  note.meta.starred = !note.meta.starred;
  return note.meta;
}

export async function importMarkdownFile(
  sourcePath: string,
): Promise<NoteMetadata> {
  if (isTauri()) {
    return invoke<NoteMetadata>("import_markdown_file", { sourcePath });
  }
  throw new Error("Import is only available in the desktop app");
}

export async function rebuildIndex(): Promise<void> {
  if (isTauri()) {
    return invoke<void>("rebuild_index");
  }
}

export async function openUrl(url: string): Promise<void> {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  } else {
    window.open(url, "_blank");
  }
}

export async function getGitRemote(): Promise<string | null> {
  if (isTauri()) {
    return invoke<string | null>("get_git_remote");
  }
  return null;
}

export async function getNotesDir(): Promise<string | null> {
  if (isTauri()) {
    return invoke<string>("get_notes_dir");
  }
  return null;
}

export async function setNotesDir(path: string): Promise<void> {
  if (isTauri()) {
    return invoke<void>("set_notes_dir", { path });
  }
}

export async function setGitRemote(url: string): Promise<void> {
  if (isTauri()) {
    return invoke<void>("set_git_remote", { url });
  }
}

export async function dismissGitSetup(): Promise<void> {
  if (isTauri()) {
    return invoke<void>("dismiss_git_setup");
  }
}

function extractTitle(content: string): string {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("# ")) return trimmed.slice(2).trim();
    return trimmed;
  }
  return "Untitled";
}
