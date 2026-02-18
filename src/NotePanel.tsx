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
  listInputDevices,
} from "./api";
import type { NoteMetadata, SortBy, RecordingState, InputDeviceInfo } from "./api";

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
  recording?: RecordingState;
  recordingProgress?: string | null;
  onStartRecording?: () => void;
  onStopRecording?: () => void;
  recordingDevice?: string | null;
  onDeviceChange?: (device: string | null) => void;
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
      recordingProgress,
      onStartRecording,
      onStopRecording,
      recordingDevice,
      onDeviceChange,
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
    const [meetingView, setMeetingView] = useState<"summary" | "transcript">("summary");
    const [userModified, setUserModified] = useState(independent ?? false);
    const [highlightIndex, setHighlightIndex] = useState(-1);
    const [starred, setStarred] = useState(false);
    const [devicePickerOpen, setDevicePickerOpen] = useState(false);
    const [devices, setDevices] = useState<InputDeviceInfo[]>([]);
    const devicePickerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<{ focus: () => void; blur: () => void; clear: () => void } | null>(
      null,
    );
    const tagInputRef = useRef<TagInputHandle>(null);
    const initialLoadDone = useRef(false);
    const historyRef = useRef<(string | null)[]>([]);
    const loadedNoteIdRef = useRef<string | null>(null);
    const savedTagsRef = useRef<string[]>([]);

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

    const handleDevicePickerToggle = useCallback(async () => {
      if (devicePickerOpen) {
        setDevicePickerOpen(false);
        return;
      }
      try {
        const devs = await listInputDevices();
        setDevices(devs);
      } catch {
        setDevices([]);
      }
      setDevicePickerOpen(true);
    }, [devicePickerOpen]);

    // Close device picker on click outside
    useEffect(() => {
      if (!devicePickerOpen) return;
      const handler = (e: MouseEvent) => {
        if (devicePickerRef.current && !devicePickerRef.current.contains(e.target as Node)) {
          setDevicePickerOpen(false);
        }
      };
      document.addEventListener("mousedown", handler);
      return () => document.removeEventListener("mousedown", handler);
    }, [devicePickerOpen]);

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
          {recording?.active ? (
            <button className="record-btn recording" onClick={onStopRecording}>
              <span className="rec-dot" />
              {String(Math.floor(recording.elapsed_seconds / 60)).padStart(1, "0")}:{String(recording.elapsed_seconds % 60).padStart(2, "0")}
              <span className="level-bars">
                <span className="level-bar mic" style={{ height: `${Math.min(100, (recording.mic_level ?? 0) * 300)}%` }} title="Mic" />
                <span className="level-bar system" style={{ height: `${Math.min(100, (recording.system_level ?? 0) * 300)}%` }} title="System" />
              </span>
              {" "}Stop
            </button>
          ) : recordingProgress ? (
            <span className="recording-progress">{recordingProgress}</span>
          ) : (
            <>
              <div className="device-picker" ref={devicePickerRef}>
                <button
                  className="device-picker-btn"
                  onClick={handleDevicePickerToggle}
                  title={recordingDevice ?? "Auto-detect microphone"}
                >
                  {recordingDevice
                    ? recordingDevice.length > 20
                      ? recordingDevice.slice(0, 18) + "..."
                      : recordingDevice
                    : "Mic: Auto"}
                </button>
                {devicePickerOpen && (
                  <div className="device-picker-dropdown">
                    <button
                      className={`device-item ${!recordingDevice ? "active" : ""}`}
                      onClick={() => {
                        onDeviceChange?.(null);
                        setDevicePickerOpen(false);
                      }}
                    >
                      Auto-detect
                    </button>
                    {devices.map((d) => (
                      <button
                        key={d.name}
                        className={`device-item ${recordingDevice === d.name ? "active" : ""}`}
                        onClick={() => {
                          onDeviceChange?.(d.name);
                          setDevicePickerOpen(false);
                        }}
                      >
                        {d.name}
                        {d.is_default && <span className="device-default-badge">default</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button className="record-btn" onClick={onStartRecording}>
                Record
              </button>
            </>
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
            const titleMatch = content.match(/^(# .+\n)/);
            const titlePart = titleMatch ? titleMatch[1] : "";
            const summaryContent = summaryMatch ? summaryMatch[1].trim() : "";
            const transcriptContent = transcriptMatch ? transcriptMatch[1].trim() : "";
            const viewContent = meetingView === "summary"
              ? `${titlePart}\n${summaryContent}`
              : `${titlePart}\n${transcriptContent}`;
            return (
              <>
                <div className="meeting-view-toggle">
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
