import { useState, useEffect, useCallback, useRef } from "react";
import { Editor } from "./Editor";
import { NotesList } from "./NotesList";
import type { NoteMetadata, NoteContent } from "./api";
import { getNote, saveNote, searchNotes } from "./api";

interface SidePanelProps {
  noteId: string;
  parentNoteId: string | null;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}

export function SidePanel({ noteId, parentNoteId, onClose, onRefresh }: SidePanelProps) {
  const [note, setNote] = useState<NoteContent | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [content, setContent] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [relatedNotes, setRelatedNotes] = useState<NoteMetadata[]>([]);
  const [currentNoteId, setCurrentNoteId] = useState(noteId);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<{ focus: () => void; clear: () => void } | null>(
    null,
  );

  const loadNote = useCallback(async (id: string) => {
    try {
      const loaded = await getNote(id);
      setNote(loaded);
      setContent(loaded.content);
      setTags(loaded.tags);
      setCurrentNoteId(loaded.id);
    } catch (e) {
      console.error("Failed to load note in side panel:", e);
    }
  }, []);

  useEffect(() => {
    loadNote(noteId);
    setIsEditing(false);
    setRelatedNotes([]);
  }, [noteId, loadNote]);

  // Debounced search when editing
  useEffect(() => {
    if (searchTimeout.current) {
      clearTimeout(searchTimeout.current);
    }

    if (!isEditing || !content.trim()) {
      setRelatedNotes([]);
      return;
    }

    searchTimeout.current = setTimeout(async () => {
      try {
        const lines = content.split("\n").filter((l) => l.trim());
        const searchText =
          lines.length > 0 ? lines[lines.length - 1].trim() : "";
        if (searchText.length < 2) return;

        const results = await searchNotes(searchText);
        const filtered = results.filter(
          (n) => n.id !== currentNoteId && n.id !== parentNoteId,
        );
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
  }, [content, currentNoteId, isEditing]);

  const handleSave = useCallback(async () => {
    if (!content.trim()) return;
    try {
      await saveNote(currentNoteId, content, tags);
      setIsEditing(false);
      await loadNote(currentNoteId);
      await onRefresh();
    } catch (e) {
      console.error("Failed to save note:", e);
    }
  }, [content, currentNoteId, tags, loadNote, onRefresh]);

  const handleOpenNote = useCallback(
    async (id: string) => {
      if (isEditing) {
        // If editing, auto-save first, then open in the same side panel
        if (content.trim()) {
          try {
            await saveNote(currentNoteId, content, tags);
            await onRefresh();
          } catch (e) {
            console.error("Failed to auto-save note:", e);
            return;
          }
        }
      }
      // Whether viewing or editing, open the new note in this same side panel
      setIsEditing(false);
      setRelatedNotes([]);
      await loadNote(id);
    },
    [isEditing, content, currentNoteId, tags, loadNote, onRefresh],
  );

  const handleStartEditing = useCallback(() => {
    setIsEditing(true);
    editorRef.current?.focus();
  }, []);

  const handleCancelEditing = useCallback(() => {
    if (note) {
      setContent(note.content);
      setTags(note.tags);
    }
    setIsEditing(false);
    setRelatedNotes([]);
  }, [note]);

  if (!note) return null;

  return (
    <div className="side-panel">
      <div className="side-panel-header">
        <div className="side-panel-title">{note.title}</div>
        <div className="side-panel-actions">
          {isEditing ? (
            <>
              <span className="editing-indicator side-panel-indicator">
                Editing
              </span>
              <button
                className="side-panel-btn"
                onClick={handleSave}
                title="Save (⌘+Enter)"
              >
                Save
              </button>
              <button
                className="side-panel-btn secondary"
                onClick={handleCancelEditing}
              >
                Cancel
              </button>
            </>
          ) : (
            <button className="side-panel-btn" onClick={handleStartEditing}>
              Edit
            </button>
          )}
          <button
            className="side-panel-btn secondary"
            onClick={onClose}
            aria-label="Close side panel"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="side-panel-content">
        {isEditing ? (
          <Editor ref={editorRef} content={content} onChange={setContent} />
        ) : (
          <div className="side-panel-view">
            <pre className="side-panel-markdown">{note.content}</pre>
          </div>
        )}
        {isEditing && relatedNotes.length > 0 && (
          <NotesList
            notes={relatedNotes}
            label="Related"
            onOpenNote={handleOpenNote}
          />
        )}
      </div>
    </div>
  );
}
