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
import type { TagInputHandle } from "./TagInput";
import {
  saveNote,
  getNote,
  deleteNote,
  toggleStar,
  getRelatedNotes,
  regenerateTags,
} from "./api";
import type { NoteMetadata, SortBy, RecordingState } from "./api";

export interface PanelHandle {
  loadNote: (noteId: string) => Promise<void>;
  refreshLoadedNote: () => Promise<void>;
  clear: () => void;
  focusEditor: () => void;
  ensureRecordingNote: () => Promise<string>;
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
  appendMeetingData: (summary: string, transcript: string) => Promise<void>;
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
  recording?: RecordingState;
  processingProgress?: string | null;
  processingProgressByNote?: Record<string, string>;
  recordingLocked?: boolean;
  onStartRecording?: () => void;
  onStopRecording?: () => void;
  isRecordingPanel?: boolean;
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
      recording,
      processingProgress,
      processingProgressByNote,
      recordingLocked,
      onStartRecording,
      onStopRecording,
      isRecordingPanel,
    },
    ref,
  ) => {
    const [content, setContent] = useState("");
    const [title, setTitle] = useState("");
    const [loadedNoteId, setLoadedNoteId] = useState<string | null>(null);
    const [tags, setTags] = useState<string[]>([]);
    const [showTagInput, setShowTagInput] = useState(false);
    const [precomputedRelated, setPrecomputedRelated] = useState<NoteMetadata[]>([]);
    const [regeneratingTags, setRegeneratingTags] = useState(false);
    const [relatedLoading, setRelatedLoading] = useState(false);
    const [meetingView, setMeetingView] = useState<"notes" | "summary" | "transcript">("notes");
    const [userModified, setUserModified] = useState(independent ?? false);
    const [highlightIndex, setHighlightIndex] = useState(-1);
    const [starred, setStarred] = useState(false);
    const editorRef = useRef<{ focus: () => void; blur: () => void; clear: () => void } | null>(
      null,
    );
    const contentRef = useRef("");
    const titleRef = useRef("");
    const tagsRef = useRef<string[]>([]);
    const tagInputRef = useRef<TagInputHandle>(null);
    const initialLoadDone = useRef(false);
    const historyRef = useRef<(string | null)[]>([]);
    const loadedNoteIdRef = useRef<string | null>(null);
    const savedTagsRef = useRef<string[]>([]);

    const editing = userModified || !loadedNoteId;
    const isTyping = editing && content.trim().length > 0;
    const effectiveProcessingProgress =
      processingProgress
      ?? (loadedNoteId ? (processingProgressByNote?.[loadedNoteId] ?? null) : null);

    useEffect(() => {
      contentRef.current = content;
    }, [content]);

    useEffect(() => {
      titleRef.current = title;
    }, [title]);

    useEffect(() => {
      tagsRef.current = tags;
    }, [tags]);

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
          setTitle(note.title);
          setLoadedNoteId(note.id);
          loadedNoteIdRef.current = note.id;
          setTags(note.tags);
          savedTagsRef.current = note.tags;
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
      setTitle("");
      setLoadedNoteId(null);
      loadedNoteIdRef.current = null;
      setTags([]);
      savedTagsRef.current = [];
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
        const isNew = !loadedNoteId;
        const tagsChanged = isNew || JSON.stringify(tags) !== JSON.stringify(savedTagsRef.current);
        const meta = await saveNote(loadedNoteId, content, tags, title || null);
        setTitle(meta.title);
        setLoadedNoteId(meta.id);
        loadedNoteIdRef.current = meta.id;
        savedTagsRef.current = tags;
        setUserModified(false);
        if (tagsChanged) {
          setRelatedLoading(true);
        }
        await onSaved();
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      } catch (e) {
        console.error("Failed to save note:", e);
      }
    }, [content, title, loadedNoteId, tags, onSaved]);

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
        ensureRecordingNote: async () => {
          const existing = loadedNoteIdRef.current;
          if (existing) return existing;

          // Recording must be tied to this panel's note, even if it's a new/empty note.
          // Persist once to get a stable note ID, but keep editing mode in this panel.
          const contentNow = contentRef.current;
          const tagsNow = tagsRef.current;
          const titleNow = titleRef.current;
          const shouldStayEditing = true;
          const meta = await saveNote(null, contentNow, tagsNow, titleNow || null);
          setTitle(meta.title);
          setLoadedNoteId(meta.id);
          loadedNoteIdRef.current = meta.id;
          savedTagsRef.current = tagsNow;
          setUserModified(shouldStayEditing);
          await onSaved();
          return meta.id;
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
        getLoadedNoteId: () => loadedNoteIdRef.current,
        canGoBack: () => historyRef.current.length > 0,
        goBack: async () => {
          if (historyRef.current.length === 0) return;
          const prevId = historyRef.current.pop()!;
          if (userModified && content.trim()) {
            try {
              await saveNote(loadedNoteId, content, tags, title || null);
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
        appendMeetingData: async (summary: string, transcript: string) => {
          const contentNow = contentRef.current;
          const tagsNow = tagsRef.current;
          const titleNow = titleRef.current;
          const shouldStayEditing = userModified || !loadedNoteIdRef.current;
          const newContent = contentNow + `\n\n## Summary\n\n${summary}\n\n## Transcript\n\n${transcript}\n`;
          const newTags = tagsNow.includes("meeting") ? tagsNow : [...tagsNow, "meeting"];
          setContent(newContent);
          setTags(newTags);
          try {
            const meta = await saveNote(loadedNoteIdRef.current, newContent, newTags, titleNow || null);
            setTitle(meta.title);
            setLoadedNoteId(meta.id);
            loadedNoteIdRef.current = meta.id;
            savedTagsRef.current = newTags;
            setUserModified(shouldStayEditing);
            await onSaved();
          } catch (e) {
            console.error("Failed to save meeting data:", e);
          }
        },
      }),
      [loadNote, loadNoteInternal, clearPanel, handleSave, userModified, loadedNoteId, content, title, tags, onSaved, displayedNotes, highlightIndex, onNoteClick],
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
      setRelatedLoading(true);
      getRelatedNotes(loadedNoteId).then((results) => {
        if (!cancelled) {
          setPrecomputedRelated(results);
          if (results.length > 0) setRelatedLoading(false);
        }
      }).catch(() => {
        if (!cancelled) {
          setPrecomputedRelated([]);
          setRelatedLoading(false);
        }
      });
      return () => { cancelled = true; };
    }, [loadedNoteId]);

    // Listen for backend QMD events.
    useEffect(() => {
      let cleanups: (() => void)[] = [];
      let cancelled = false;
      import("@tauri-apps/api/event").then(({ listen }) => {
        if (cancelled) return;
        listen<string[]>("qmd-processing", (event) => {
          const currentId = loadedNoteIdRef.current;
          if (currentId && event.payload.includes(currentId)) {
            setRelatedLoading(true);
          }
        }).then((unlisten) => {
          if (cancelled) unlisten(); else cleanups.push(unlisten);
        });
        listen("related-notes-changed", () => {
          const currentId = loadedNoteIdRef.current;
          if (currentId) {
            getRelatedNotes(currentId).then((results) => {
              setPrecomputedRelated(results);
              setRelatedLoading(false);
            }).catch(() => {
              setRelatedLoading(false);
            });
          }
        }).then((unlisten) => {
          if (cancelled) unlisten(); else cleanups.push(unlisten);
        });
      }).catch(() => {});
      return () => {
        cancelled = true;
        cleanups.forEach((fn) => fn());
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

    const handleRegenerateTags = useCallback(async () => {
      if (!loadedNoteId || regeneratingTags) return;
      setRegeneratingTags(true);
      try {
        const updated = await regenerateTags(loadedNoteId);
        setTags(updated.tags);
        await onSaved();
      } catch (e) {
        console.error("Failed to regenerate tags:", e);
      } finally {
        setRegeneratingTags(false);
      }
    }, [loadedNoteId, regeneratingTags, onSaved]);

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
          <div className="metadata-panel" onKeyDown={async (e) => {
            if (e.key === "Enter" && e.metaKey) {
              e.preventDefault();
              const pending = tagInputRef.current?.flush();
              setShowTagInput(false);
              if (pending) {
                // flush() updates React state (async), but handleSave
                // captures the old tags.  Save directly with the
                // updated tag list.
                const updatedTags = tags.includes(pending) ? tags : [...tags, pending];
                setTags(updatedTags);
                if (!content.trim()) return;
                try {
                  const meta = await saveNote(loadedNoteId, content, updatedTags, title || null);
                  setTitle(meta.title);
                  setLoadedNoteId(meta.id);
                  loadedNoteIdRef.current = meta.id;
                  savedTagsRef.current = updatedTags;
                  setUserModified(false);
                  setRelatedLoading(true);
                  await onSaved();
                  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
                } catch (err) {
                  console.error("Failed to save note:", err);
                }
              } else {
                handleSave();
              }
            }
          }}>
            <input
              className="title-input"
              type="text"
              placeholder="Title..."
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setUserModified(true);
              }}
            />
            <div className="tag-row">
              <TagInput ref={tagInputRef} tags={tags} allTags={allTags} onChange={setTags} />
              {loadedNoteId && (
                <button
                  className="regenerate-tags-btn"
                  onClick={handleRegenerateTags}
                  disabled={regeneratingTags}
                  title="Regenerate tags from content"
                >
                  {regeneratingTags ? "..." : "↻"}
                </button>
              )}
            </div>
          </div>
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
          {recording?.active && isRecordingPanel ? (
            <button className="record-btn recording" onClick={onStopRecording} style={{ marginLeft: "auto" }}>
              <span className="rec-dot" />
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{String(Math.floor(recording.elapsed_seconds / 60)).padStart(1, "0")}:{String(recording.elapsed_seconds % 60).padStart(2, "0")}</span>
              <span className="level-bars">
                <span className="level-bar mic" style={{ height: `${Math.min(100, (recording.mic_level ?? 0) * 300)}%` }} />
                <span className="level-bar system" style={{ height: `${Math.min(100, (recording.system_level ?? 0) * 300)}%` }} />
              </span>
            </button>
          ) : effectiveProcessingProgress ? (
            <span className="recording-progress" style={{ marginLeft: "auto" }}>{effectiveProcessingProgress}</span>
          ) : tags.includes("meeting") && loadedNoteId ? null : (
            <button className="record-btn" onClick={onStartRecording} disabled={!!recordingLocked} title="Record" style={{ marginLeft: "auto" }}>
              ●
            </button>
          )}
        </div>
        <div style={{ display: editing ? undefined : 'none' }}>
          <Editor ref={editorRef} content={content} onChange={handleChange} onSave={handleSave} themeId={themeId} vimEnabled={vimEnabled} onVimToggle={onVimToggle} onNoteNavigate={onNoteNavigate} recentNotes={recentNotes} />
        </div>
        {!editing && (() => {
          const hasSummary = content.includes("## Summary") && content.includes("## Transcript");
          if (hasSummary) {
            const summaryMatch = content.match(/## Summary\n+([\s\S]*?)(?=\n## Transcript)/);
            const transcriptMatch = content.match(/## Transcript\n+([\s\S]*?)$/);
            const summaryContent = summaryMatch ? summaryMatch[1].trim() : "";
            const transcriptContent = transcriptMatch ? transcriptMatch[1].trim() : "";
            // Everything before ## Summary is the user's notes
            const notesContent = content.split(/\n## Summary/)[0].trim();
            const hasNotes = notesContent.replace(/^#\s+.*$/m, "").trim().length > 0;
            const viewContent = meetingView === "notes"
              ? notesContent
              : meetingView === "summary"
                ? summaryContent
                : transcriptContent;
            return (
              <>
                <div className="meeting-view-toggle">
                  {hasNotes && (
                    <button
                      className={meetingView === "notes" ? "active" : ""}
                      onClick={() => setMeetingView("notes")}
                    >Notes</button>
                  )}
                  <button
                    className={meetingView === "summary" ? "active" : ""}
                    onClick={() => setMeetingView("summary")}
                  >Summary</button>
                  <button
                    className={meetingView === "transcript" ? "active" : ""}
                    onClick={() => setMeetingView("transcript")}
                  >Transcript</button>
                </div>
                <MarkdownView content={viewContent} onEdit={handleEdit} onNoteNavigate={onNoteNavigate} />
              </>
            );
          }
          return <MarkdownView content={content} onEdit={handleEdit} onNoteNavigate={onNoteNavigate} />;
        })()}
        <div className="save-hint">
          {/Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)
            ? <><kbd>⌃</kbd> <kbd>⌘</kbd> <kbd>+</kbd> shortcuts</>
            : <><kbd>Ctrl</kbd> <kbd>/</kbd> shortcuts</>
          }
        </div>
        <NotesList
          notes={displayedNotes}
          label={listLabel}
          loading={loadedNoteId ? relatedLoading : false}
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
