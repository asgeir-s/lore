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
  title?: string | null,
): Promise<NoteMetadata> {
  if (isTauri()) {
    return invoke<NoteMetadata>("save_note", { id, content, tags, title: title ?? null });
  }
  // Fallback for web dev
  const noteId = id ?? generateId();
  const resolvedTitle = title ?? extractTitle(content);
  const now = new Date().toISOString();
  const existing = memoryNotes.get(noteId);
  const meta: NoteMetadata = {
    id: noteId,
    path: `${noteId}.md`,
    title: resolvedTitle,
    created: existing?.meta.created ?? now,
    modified: now,
    tags,
    starred: existing?.meta.starred ?? false,
  };
  memoryNotes.set(noteId, { meta, content });
  return meta;
}

export async function deleteNote(id: string): Promise<void> {
  if (isTauri()) {
    return invoke<void>("delete_note", { id });
  }
  memoryNotes.delete(id);
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

/** Fuzzy-match query against target by walking query chars in order.
 *  Returns null if not all chars found, otherwise a score (higher = better).
 *  +1 per match, +2 for word-boundary, +3 for consecutive. */
function fuzzyScore(query: string, target: string): number | null {
  const qLower = query.toLowerCase();
  const tLower = target.toLowerCase();
  if (!qLower.length) return null;

  let score = 0;
  let qi = 0;
  let lastMatch: number | null = null;

  for (let ti = 0; ti < tLower.length && qi < qLower.length; ti++) {
    if (tLower[ti] === qLower[qi]) {
      score += 1;
      if (ti === 0 || " _-".includes(tLower[ti - 1])) {
        score += 2;
      }
      if (lastMatch === ti - 1) {
        score += 3;
      }
      lastMatch = ti;
      qi++;
    }
  }

  return qi === qLower.length ? score : null;
}

export async function searchNotes(query: string): Promise<NoteMetadata[]> {
  if (isTauri()) {
    return invoke<NoteMetadata[]>("search_notes", { query });
  }
  if (!query.trim()) return [];

  const seen = new Set<string>();
  const merged: NoteMetadata[] = [];

  // 1. Fuzzy title matches
  const fuzzyHits: { score: number; meta: NoteMetadata }[] = [];
  for (const [, note] of memoryNotes) {
    const s = fuzzyScore(query, note.meta.title);
    if (s !== null) fuzzyHits.push({ score: s, meta: note.meta });
  }
  fuzzyHits.sort((a, b) => b.score - a.score);
  for (const hit of fuzzyHits) {
    if (!seen.has(hit.meta.id)) {
      seen.add(hit.meta.id);
      merged.push(hit.meta);
    }
  }

  // 2. Content substring matches
  const q = query.toLowerCase();
  for (const [, note] of memoryNotes) {
    if (!seen.has(note.meta.id) && note.content.toLowerCase().includes(q)) {
      seen.add(note.meta.id);
      merged.push(note.meta);
    }
  }

  return merged.slice(0, 20);
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

export interface ToolStatus {
  git: boolean;
  qmd: boolean;
  ollama: boolean;
  ffmpeg: boolean;
  whisper: boolean;
}

export async function checkTools(): Promise<ToolStatus> {
  if (isTauri()) {
    return invoke<ToolStatus>("check_tools");
  }
  return { git: false, qmd: false, ollama: false, ffmpeg: false, whisper: false };
}

// ── Recording API ──────────────────────────────────────────────────

export interface RecordingState {
  active: boolean;
  note_id: string | null;
  elapsed_seconds: number;
  mic_level: number;
  system_level: number;
}

export interface InputDeviceInfo {
  name: string;
  is_default: boolean;
}

export async function listInputDevices(): Promise<InputDeviceInfo[]> {
  if (isTauri()) {
    return invoke<InputDeviceInfo[]>("list_input_devices");
  }
  return [];
}

export async function startRecording(device?: string): Promise<string> {
  if (isTauri()) {
    return invoke<string>("start_recording", { device: device ?? null });
  }
  throw new Error("Recording is only available in the desktop app");
}

export async function stopRecording(): Promise<void> {
  if (isTauri()) {
    return invoke<void>("stop_recording");
  }
}

export async function getRecordingState(): Promise<RecordingState> {
  if (isTauri()) {
    return invoke<RecordingState>("get_recording_state");
  }
  return { active: false, note_id: null, elapsed_seconds: 0, mic_level: 0, system_level: 0 };
}

export async function regenerateTags(id: string): Promise<NoteMetadata> {
  if (isTauri()) {
    return invoke<NoteMetadata>("regenerate_tags", { id });
  }
  throw new Error("Regenerate tags is only available in the desktop app");
}

export async function getRelatedNotes(id: string): Promise<NoteMetadata[]> {
  if (isTauri()) {
    return invoke<NoteMetadata[]>("get_related_notes", { id });
  }
  return [];
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
