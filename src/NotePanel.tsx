import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  forwardRef,
  useImperativeHandle,
} from "react";
import { Editor } from "./Editor";
import { MarkdownView } from "./MarkdownView";
import { NotesList } from "./NotesList";
import { TagInput } from "./TagInput";
import {
  saveNote,
  getNote,
  deleteNote,
  toggleStar,
  getRelatedNotes,
} from "./api";
import type { NoteMetadata, SortBy } from "./api";

export interface PanelHandle {
  loadNote: (noteId: string) => Promise<void>;
  refreshLoadedNote: () => Promise<void>;
  clear: () => void;
  focusEditor: () => void;
  isUserModified: () => boolean;
  hasContent: () => boolean;
  getLoadedNoteId: () => string | null;
  canGoBack: () => boolean;
  goBack: () => void;
  save: () => Promise<void>;
  toggleTags: () => void;
  edit: () => void;
  discardEdits: () => void;
  navigateList: (delta: number) => void;
  openSelectedNote: (metaKey: boolean) => void;
  getHighlightedNoteId: () => string | null;
  toggleStar: () => Promise<void>;
  deleteNote: () => Promise<void>;
}

interface NotePanelProps {
  recentNotes: NoteMetadata[];
  allTags: string[];
  onNoteClick: (noteId: string, metaKey: boolean) => void;
  onNoteNavigate?: (noteId: string, metaKey: boolean) => void;
  onSaved: () => Promise<void>;
  onFocus: () => void;
  initialNoteId?: string;
  independent?: boolean;
  sortBy: SortBy;
  onSortChange: (sortBy: SortBy) => void;
  themeId: string;
  vimEnabled: boolean;
  onVimToggle: () => void;
}

export const NotePanel = forwardRef<PanelHandle, NotePanelProps>(
  (
    {
      recentNotes,
      allTags,
      onNoteClick,
      onNoteNavigate,
      onSaved,
      onFocus,
      initialNoteId,
      independent,
      sortBy,
      onSortChange,
      themeId,
      vimEnabled,
      onVimToggle,
    },
    ref,
  ) => {
    const [content, setContent] = useState("");
    const [loadedNoteId, setLoadedNoteId] = useState<string | null>(null);
    const [tags, setTags] = useState<string[]>([]);
    const [showTagInput, setShowTagInput] = useState(false);
    const [precomputedRelated, setPrecomputedRelated] = useState<NoteMetadata[]>([]);
    const [userModified, setUserModified] = useState(independent ?? false);
    const [highlightIndex, setHighlightIndex] = useState(-1);
    const [starred, setStarred] = useState(false);
    const editorRef = useRef<{ focus: () => void; blur: () => void; clear: () => void } | null>(
      null,
    );
    const initialLoadDone = useRef(false);
    const historyRef = useRef<(string | null)[]>([]);
    const loadedNoteIdRef = useRef<string | null>(null);

    const editing = userModified || !loadedNoteId;
    const isTyping = editing && content.trim().length > 0;

    const loadNoteInternal = useCallback(
      async (noteId: string, pushHistory: boolean) => {
        try {
          if (pushHistory) {
            historyRef.current.push(loadedNoteIdRef.current);
          }
          if (noteId !== loadedNoteIdRef.current) {
            setPrecomputedRelated([]);
          }
          const note = await getNote(noteId);
          setContent(note.content);
          setLoadedNoteId(note.id);
          loadedNoteIdRef.current = note.id;
          setTags(note.tags);
          setStarred(note.starred);
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
      setPrecomputedRelated([]);
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

    const displayedNotes = useMemo(() => {
      // Existing note (viewing or editing) — show precomputed related
      if (loadedNoteId) return precomputedRelated;
      // New panel with no note loaded — show recent notes
      if (!isTyping) return recentNotes;
      // Typing in a new note — show nothing
      return [];
    }, [isTyping, loadedNoteId, precomputedRelated, recentNotes]);

    useImperativeHandle(
      ref,
      () => ({
        loadNote,
        refreshLoadedNote: async () => {
          const current = loadedNoteIdRef.current;
          if (!current || userModified) return;
          await loadNoteInternal(current, false);
        },
        clear: clearPanel,
        focusEditor: () => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => editorRef.current?.focus()),
          );
        },
        edit: () => {
          setUserModified(true);
          requestAnimationFrame(() =>
            requestAnimationFrame(() => editorRef.current?.focus()),
          );
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
        hasContent: () => content.trim().length > 0,
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
          const notes = displayedNotes;
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
          const notes = displayedNotes;
          if (highlightIndex >= 0 && highlightIndex < notes.length) {
            onNoteClick(notes[highlightIndex].id, metaKey);
            setHighlightIndex(-1);
          }
        },
        getHighlightedNoteId: () => {
          const notes = displayedNotes;
          if (highlightIndex >= 0 && highlightIndex < notes.length) {
            return notes[highlightIndex].id;
          }
          return null;
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
        deleteNote: async () => {
          if (!loadedNoteId) return;
          try {
            await deleteNote(loadedNoteId);
            clearPanel();
            await onSaved();
          } catch (e) {
            console.error("Failed to delete note:", e);
          }
        },
      }),
      [loadNote, loadNoteInternal, clearPanel, handleSave, userModified, loadedNoteId, content, tags, onSaved, displayedNotes, highlightIndex, onNoteClick],
    );

    // Load initial note on mount
    useEffect(() => {
      if (initialNoteId && !initialLoadDone.current) {
        initialLoadDone.current = true;
        loadNote(initialNoteId);
      }
    }, [initialNoteId, loadNote]);

    // Fetch precomputed related notes when a saved note is loaded.
    // Don't re-fetch or clear when entering edit mode — keep showing them.
    useEffect(() => {
      if (!loadedNoteId) {
        setPrecomputedRelated([]);
        return;
      }
      let cancelled = false;
      getRelatedNotes(loadedNoteId).then((results) => {
        if (!cancelled) setPrecomputedRelated(results);
      }).catch(() => {
        if (!cancelled) setPrecomputedRelated([]);
      });
      return () => { cancelled = true; };
    }, [loadedNoteId]);

    // Listen for backend related-notes-changed event.
    useEffect(() => {
      let cleanup: (() => void) | undefined;
      let cancelled = false;
      import("@tauri-apps/api/event").then(({ listen }) => {
        if (cancelled) return;
        listen("related-notes-changed", () => {
          const currentId = loadedNoteIdRef.current;
          if (currentId) {
            getRelatedNotes(currentId).then((results) => {
              setPrecomputedRelated(results);
            }).catch(() => {});
          }
        }).then((unlisten) => {
          if (cancelled) {
            unlisten();
          } else {
            cleanup = unlisten;
          }
        });
      }).catch(() => {});
      return () => {
        cancelled = true;
        cleanup?.();
      };
    }, []);

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

    const handleEdit = useCallback(() => {
      setUserModified(true);
      requestAnimationFrame(() => editorRef.current?.focus());
    }, []);

    const listLabel = loadedNoteId ? "Related" : "Recent";

    // Reset highlight when notes list changes
    useEffect(() => {
      setHighlightIndex(-1);
    }, [displayedNotes]);

    return (
      <div
        className="note-panel"
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
        <div style={{ display: editing ? undefined : 'none' }}>
          <Editor ref={editorRef} content={content} onChange={handleChange} onSave={handleSave} themeId={themeId} vimEnabled={vimEnabled} onVimToggle={onVimToggle} onNoteNavigate={onNoteNavigate} recentNotes={recentNotes} />
        </div>
        {!editing && <MarkdownView content={content} onEdit={handleEdit} onNoteNavigate={onNoteNavigate} />}
        <div className="save-hint">
          {/Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)
            ? <><kbd>⌃</kbd> <kbd>⌘</kbd> <kbd>+</kbd> shortcuts</>
            : <><kbd>Ctrl</kbd> <kbd>/</kbd> shortcuts</>
          }
        </div>
        <NotesList
          notes={displayedNotes}
          label={listLabel}
          onOpenNote={handleNoteClick}
          highlightIndex={highlightIndex}
          sortBy={sortBy}
          onSortChange={onSortChange}
        />
      </div>
    );
  },
);

NotePanel.displayName = "NotePanel";
