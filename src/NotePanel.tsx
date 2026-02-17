import {
  useState,
  useEffect,
  useCallback,
  useRef,
  forwardRef,
  useImperativeHandle,
} from "react";
import { Editor } from "./Editor";
import { NotesList } from "./NotesList";
import { TagInput } from "./TagInput";
import {
  saveNote,
  getNote,
  searchNotes,
  toggleStar,
} from "./api";
import type { NoteMetadata } from "./api";

export interface PanelHandle {
  loadNote: (noteId: string) => Promise<void>;
  clear: () => void;
  focusEditor: () => void;
  isUserModified: () => boolean;
  getLoadedNoteId: () => string | null;
  canGoBack: () => boolean;
  goBack: () => void;
  save: () => Promise<void>;
  toggleTags: () => void;
  edit: () => void;
  discardEdits: () => void;
  navigateList: (delta: number) => void;
  openSelectedNote: (metaKey: boolean) => void;
  toggleStar: () => Promise<void>;
}

interface NotePanelProps {
  recentNotes: NoteMetadata[];
  allTags: string[];
  onNoteClick: (noteId: string, metaKey: boolean) => void;
  onSaved: () => Promise<void>;
  onFocus: () => void;
  isFocused: boolean;
  initialNoteId?: string;
  independent?: boolean;
}

export const NotePanel = forwardRef<PanelHandle, NotePanelProps>(
  (
    {
      recentNotes,
      allTags,
      onNoteClick,
      onSaved,
      onFocus,
      isFocused,
      initialNoteId,
      independent,
    },
    ref,
  ) => {
    const [content, setContent] = useState("");
    const [loadedNoteId, setLoadedNoteId] = useState<string | null>(null);
    const [tags, setTags] = useState<string[]>([]);
    const [showTagInput, setShowTagInput] = useState(false);
    const [relatedNotes, setRelatedNotes] = useState<NoteMetadata[]>([]);
    const [userModified, setUserModified] = useState(independent ?? false);
    const [highlightIndex, setHighlightIndex] = useState(-1);
    const [starred, setStarred] = useState(false);
    const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
    const editorRef = useRef<{ focus: () => void; clear: () => void } | null>(
      null,
    );
    const initialLoadDone = useRef(false);
    const historyRef = useRef<(string | null)[]>([]);
    const loadedNoteIdRef = useRef<string | null>(null);

    const isTyping = content.trim().length > 0;

    const loadNoteInternal = useCallback(
      async (noteId: string, pushHistory: boolean) => {
        try {
          if (pushHistory) {
            historyRef.current.push(loadedNoteIdRef.current);
          }
          const note = await getNote(noteId);
          setContent(note.content);
          setLoadedNoteId(note.id);
          loadedNoteIdRef.current = note.id;
          setTags(note.tags);
          setStarred(note.starred);
          setRelatedNotes([]);
          setUserModified(false);
        } catch (e) {
          console.error("Failed to load note:", e);
        }
      },
      [],
    );

    const loadNote = useCallback(
      async (noteId: string) => {
        await loadNoteInternal(noteId, true);
      },
      [loadNoteInternal],
    );

    const clearPanel = useCallback(() => {
      setContent("");
      setLoadedNoteId(null);
      loadedNoteIdRef.current = null;
      setTags([]);
      setStarred(false);
      setRelatedNotes([]);
      setShowTagInput(false);
      setUserModified(false);
      historyRef.current = [];
      editorRef.current?.clear();
    }, []);

    const handleSave = useCallback(async () => {
      if (!content.trim()) return;
      try {
        const meta = await saveNote(loadedNoteId, content, tags);
        setLoadedNoteId(meta.id);
        loadedNoteIdRef.current = meta.id;
        setUserModified(false);
        await onSaved();
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      } catch (e) {
        console.error("Failed to save note:", e);
      }
    }, [content, loadedNoteId, tags, onSaved]);

    useImperativeHandle(
      ref,
      () => ({
        loadNote,
        clear: clearPanel,
        focusEditor: () => editorRef.current?.focus(),
        edit: () => {
          setUserModified(true);
          editorRef.current?.focus();
        },
        discardEdits: () => {
          if (loadedNoteId) {
            // Reload the note, discarding changes
            loadNoteInternal(loadedNoteId, false);
          } else {
            // Was a new note — just clear
            clearPanel();
          }
          if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
          }
        },
        isUserModified: () => userModified,
        getLoadedNoteId: () => loadedNoteId,
        canGoBack: () => historyRef.current.length > 0,
        goBack: async () => {
          if (historyRef.current.length === 0) return;
          const prevId = historyRef.current.pop()!;
          if (userModified && content.trim()) {
            try {
              await saveNote(loadedNoteId, content, tags);
              await onSaved();
            } catch (e) {
              console.error("Failed to save note:", e);
            }
          }
          if (prevId === null) {
            clearPanel();
          } else {
            await loadNoteInternal(prevId, false);
          }
          if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
          }
        },
        save: handleSave,
        toggleTags: () => setShowTagInput((prev) => !prev),
        navigateList: (delta: number) => {
          const notes = isTyping ? relatedNotes : recentNotes;
          if (notes.length === 0) return;
          setHighlightIndex((prev) => {
            if (prev === -1) return delta > 0 ? 0 : notes.length - 1;
            const next = prev + delta;
            if (next < 0) return 0;
            if (next >= notes.length) return notes.length - 1;
            return next;
          });
        },
        openSelectedNote: (metaKey: boolean) => {
          const notes = isTyping ? relatedNotes : recentNotes;
          if (highlightIndex >= 0 && highlightIndex < notes.length) {
            onNoteClick(notes[highlightIndex].id, metaKey);
            setHighlightIndex(-1);
          }
        },
        toggleStar: async () => {
          if (!loadedNoteId) return;
          try {
            const updated = await toggleStar(loadedNoteId);
            setStarred(updated.starred);
            await onSaved();
          } catch (e) {
            console.error("Failed to toggle star:", e);
          }
        },
      }),
      [loadNote, loadNoteInternal, clearPanel, handleSave, userModified, loadedNoteId, content, tags, onSaved, isTyping, relatedNotes, recentNotes, highlightIndex, onNoteClick],
    );

    // Load initial note on mount
    useEffect(() => {
      if (initialNoteId && !initialLoadDone.current) {
        initialLoadDone.current = true;
        loadNote(initialNoteId);
      }
    }, [initialNoteId, loadNote]);

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
          const lines = content.split("\n").filter((l) => l.trim());
          const searchText =
            lines.length > 0 ? lines[lines.length - 1].trim() : "";
          if (searchText.length < 2) return;

          const results = await searchNotes(searchText);
          const filtered = loadedNoteId
            ? results.filter((n) => n.id !== loadedNoteId)
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
    }, [content, loadedNoteId, isTyping]);

    const handleChange = useCallback((value: string) => {
      setContent(value);
      setUserModified(true);
    }, []);

    const handleNoteClick = useCallback(
      (noteId: string, metaKey: boolean) => {
        onNoteClick(noteId, metaKey);
      },
      [onNoteClick],
    );

    const displayedNotes = isTyping ? relatedNotes : recentNotes;
    const listLabel = isTyping ? "Related" : "Recent";

    // Reset highlight when notes list changes
    useEffect(() => {
      setHighlightIndex(-1);
    }, [displayedNotes]);

    return (
      <div
        className={`note-panel ${isFocused ? "focused" : ""}`}
        onPointerDown={onFocus}
      >
        {showTagInput && (
          <TagInput tags={tags} allTags={allTags} onChange={setTags} />
        )}
        <div className="panel-indicators">
          <div
            className={`editing-indicator ${userModified ? "visible" : ""}`}
            role="status"
            aria-live="polite"
          >
            Editing
          </div>
          {starred && loadedNoteId && (
            <div className="star-indicator" role="status">
              Starred
            </div>
          )}
        </div>
        <Editor ref={editorRef} content={content} onChange={handleChange} />
        {userModified && isTyping && (
          <div className="save-hint">
            <kbd>⌘</kbd> + <kbd>Enter</kbd> to save &nbsp; <kbd>Esc</kbd> to
            discard
          </div>
        )}
        <NotesList
          notes={displayedNotes}
          label={listLabel}
          onOpenNote={handleNoteClick}
          highlightIndex={highlightIndex}
        />
      </div>
    );
  },
);

NotePanel.displayName = "NotePanel";
