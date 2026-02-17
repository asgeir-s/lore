import { useState, useEffect, useCallback, useRef } from "react";
import { Editor } from "./Editor";
import { NotesList } from "./NotesList";
import { TagInput } from "./TagInput";
import { SidePanel } from "./SidePanel";
import {
  saveNote,
  getNote,
  listRecentNotes,
  searchNotes,
  getAllTags,
  rebuildIndex,
} from "./api";
import type { NoteMetadata } from "./api";

export default function App() {
  const [content, setContent] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [showTagInput, setShowTagInput] = useState(false);
  const [recentNotes, setRecentNotes] = useState<NoteMetadata[]>([]);
  const [relatedNotes, setRelatedNotes] = useState<NoteMetadata[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [sidePanelNoteId, setSidePanelNoteId] = useState<string | null>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<{ focus: () => void; clear: () => void } | null>(
    null,
  );

  const isTyping = content.trim().length > 0;

  // Load recent notes and rebuild index on launch
  useEffect(() => {
    const init = async () => {
      try {
        await rebuildIndex();
      } catch {
        // Index rebuild may fail in web-only mode
      }
      await refreshRecentNotes();
      await refreshTags();
    };
    init();
  }, []);

  const refreshRecentNotes = async () => {
    try {
      const notes = await listRecentNotes(20);
      setRecentNotes(notes);
    } catch {
      // Ignore errors
    }
  };

  const refreshTags = async () => {
    try {
      const t = await getAllTags();
      setAllTags(t);
    } catch {
      // Ignore errors
    }
  };

  // Debounced search when typing
  useEffect(() => {
    if (searchTimeout.current) {
      clearTimeout(searchTimeout.current);
    }

    if (!isTyping) {
      setRelatedNotes([]);
      return;
    }

    searchTimeout.current = setTimeout(async () => {
      try {
        // Extract search terms from content
        const lines = content.split("\n").filter((l) => l.trim());
        const searchText =
          lines.length > 0 ? lines[lines.length - 1].trim() : "";
        if (searchText.length < 2) return;

        const results = await searchNotes(searchText);
        // Filter out the currently editing note
        const filtered = editingId
          ? results.filter((n) => n.id !== editingId)
          : results;
        setRelatedNotes(filtered);
      } catch {
        // Ignore search errors
      }
    }, 500);

    return () => {
      if (searchTimeout.current) {
        clearTimeout(searchTimeout.current);
      }
    };
  }, [content, editingId, isTyping]);

  const handleSave = useCallback(async () => {
    if (!content.trim()) return;

    try {
      await saveNote(editingId, content, tags);
      setContent("");
      setEditingId(null);
      setTags([]);
      setRelatedNotes([]);
      setShowTagInput(false);
      setSidePanelNoteId(null);
      editorRef.current?.clear();
      await refreshRecentNotes();
      await refreshTags();
    } catch (e) {
      console.error("Failed to save note:", e);
    }
  }, [content, editingId, tags]);

  const handleOpenNote = useCallback(
    async (noteId: string) => {
      try {
        // If editing an existing note, open the linked note in the side panel
        if (editingId) {
          setSidePanelNoteId(noteId);
          return;
        }

        // If currently typing new content, auto-save it first
        if (content.trim() && !editingId) {
          await saveNote(null, content, tags);
        }

        const note = await getNote(noteId);
        setContent(note.content);
        setEditingId(note.id);
        setTags(note.tags);
        setRelatedNotes([]);
        editorRef.current?.focus();
      } catch (e) {
        console.error("Failed to open note:", e);
      }
    },
    [content, editingId, tags],
  );

  const handleClear = useCallback(() => {
    setContent("");
    setEditingId(null);
    setTags([]);
    setRelatedNotes([]);
    setShowTagInput(false);
    setSidePanelNoteId(null);
    editorRef.current?.clear();
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Cmd+Enter or Ctrl+Enter to save
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSave();
        return;
      }
      // Escape to clear
      if (e.key === "Escape") {
        e.preventDefault();
        handleClear();
        return;
      }
      // Cmd+T or Ctrl+T for tags
      if (e.key === "t" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setShowTagInput((prev) => !prev);
        return;
      }
    },
    [handleSave, handleClear],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const displayedNotes = isTyping ? relatedNotes : recentNotes;
  const listLabel = isTyping ? "Related" : "Recent";

  const handleCloseSidePanel = useCallback(() => {
    setSidePanelNoteId(null);
  }, []);

  const handleSidePanelRefresh = useCallback(async () => {
    await refreshRecentNotes();
    await refreshTags();
  }, []);

  return (
    <div className={`app-layout ${sidePanelNoteId ? "with-side-panel" : ""}`}>
      <div className="app">
        {showTagInput && (
          <TagInput
            tags={tags}
            allTags={allTags}
            onChange={setTags}
          />
        )}
        {editingId && (
          <div className="editing-indicator" role="status" aria-live="polite">Editing</div>
        )}
        <Editor
          ref={editorRef}
          content={content}
          onChange={setContent}
        />
        {isTyping && (
          <div className="save-hint">
            <kbd>⌘</kbd> + <kbd>Enter</kbd> to save &nbsp; <kbd>Esc</kbd> to
            discard
          </div>
        )}
        <NotesList
          notes={displayedNotes}
          label={listLabel}
          onOpenNote={handleOpenNote}
        />
      </div>
      {sidePanelNoteId && (
        <SidePanel
          noteId={sidePanelNoteId}
          parentNoteId={editingId}
          onClose={handleCloseSidePanel}
          onRefresh={handleSidePanelRefresh}
        />
      )}
    </div>
  );
}
