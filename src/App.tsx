import { useState, useEffect, useCallback, useRef, Fragment } from "react";
import { createPortal } from "react-dom";
import { NotePanel } from "./NotePanel";
import type { PanelHandle } from "./NotePanel";
import { DragSplitter } from "./DragSplitter";
import {
  listRecentNotes,
  listPinnedNotes,
  getAllTags,
  rebuildIndex,
  importMarkdownFile,
  getGitRemote,
  setGitRemote,
  dismissGitSetup,
  getNotesDir,
  setNotesDir,
  checkTools,
  openToolInstaller,
  startRecording,
  stopRecording,
  checkPendingJobs,
  appendMeetingData as appendMeetingDataToNote,
  getModelSettings,
  setModelSettings as setModelSettingsApi,
  listOllamaModels,
  listWhisperModels,
  pullOllamaModel,
} from "./api";
import type { RecordingState } from "./api";
import type {
  ToolStatus,
  ModelSettings,
  OllamaModelInfo,
  WhisperModelInfo,
} from "./api";
import type { NoteMetadata, SortBy } from "./api";
import { loadSavedTheme, saveTheme, applyThemeVars } from "./themes";
import { ThemePicker } from "./ThemePicker";
import { SearchPalette } from "./SearchPalette";
import { SettingsPanel } from "./SettingsPanel";
import type { PullProgress } from "./SettingsPanel";
import { BackgroundJobsIndicator } from "./BackgroundJobs";
import type { BgJob } from "./BackgroundJobs";

interface PanelState {
  id: string;
  initialNoteId?: string;
  independent?: boolean;
}

let nextPanelId = 1;
function genPanelId() {
  return String(nextPanelId++);
}

const firstPanelId = genPanelId();
const NOTES_DIR_PROMPT_KEY = "notes-dir-prompted-v1";

function isMacOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(
    navigator.platform || navigator.userAgent,
  );
}

export default function App() {
  const [panels, setPanels] = useState<PanelState[]>(() => [
    { id: firstPanelId },
  ]);
  const [panelWidths, setPanelWidths] = useState<number[]>([1]);
  const [activePanelIndex, _setActivePanelIndex] = useState(0);
  const [recentNotes, setRecentNotes] = useState<NoteMetadata[]>([]);
  const [pinnedNotes, setPinnedNotes] = useState<NoteMetadata[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [showHotkeys, setShowHotkeys] = useState(false);
  const [sortBy, setSortBy] = useState<SortBy>("created");
  const [themeId, setThemeId] = useState(() => loadSavedTheme());
  const [vimEnabled, setVimEnabled] = useState(
    () => localStorage.getItem("note-vim") === "1",
  );
  const [zoom, setZoom] = useState(() => {
    const saved = localStorage.getItem("note-zoom");
    return saved ? Number(saved) : 100;
  });
  const [dropZoneVisible, setDropZoneVisible] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [notesDirBanner, setNotesDirBanner] = useState(false);
  const [notesDirPath, setNotesDirPath] = useState("");
  const [currentNotesDir, setCurrentNotesDir] = useState<string | null>(null);
  const [connectedGitRemote, setConnectedGitRemote] = useState<string | null>(
    null,
  );
  const [gitBanner, setGitBanner] = useState(false);
  const [gitRemoteUrl, setGitRemoteUrl] = useState("");
  const [gitError, setGitError] = useState<string | null>(null);
  const [closeWarningIndex, setCloseWarningIndex] = useState<number | null>(
    null,
  );
  const closeWarningTimeout = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [recordingCloseWarningIndex, setRecordingCloseWarningIndex] = useState<
    number | null
  >(null);
  const recordingCloseWarningTimeout = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const [deleteWarning, setDeleteWarning] = useState(false);
  const deleteWarningTimeout = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const gPendingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoomApplyRequest = useRef(0);
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [toolStatus, setToolStatus] = useState<ToolStatus | null>(null);
  const [recording, setRecording] = useState<RecordingState>({
    active: false,
    note_id: null,
    elapsed_seconds: 0,
    mic_level: 0,
    system_level: 0,
  });
  const [recordingStartPending, setRecordingStartPending] = useState(false);
  const recordingStartPendingRef = useRef(false);
  const [processingProgressByPanel, setProcessingProgressByPanel] = useState<
    Record<string, string>
  >({});
  const [processingProgressByNote, setProcessingProgressByNote] = useState<
    Record<string, string>
  >({});
  const [recordingDevice, setRecordingDevice] = useState<string | null>(() =>
    localStorage.getItem("recording-device"),
  );
  const [modelSettings, setModelSettings] = useState<ModelSettings>({
    keyword_model: null,
    summary_model: null,
    whisper_model: null,
  });
  const [ollamaModels, setOllamaModels] = useState<OllamaModelInfo[]>([]);
  const [whisperModels, setWhisperModels] = useState<WhisperModelInfo[]>([]);
  const [pullProgress, setPullProgress] = useState<PullProgress | null>(null);
  const [recordingPanelId, setRecordingPanelId] = useState<string | null>(null);
  const pendingRecordingPanelRef = useRef<string | null>(null);
  const pendingRecordingPanelsByNoteRef = useRef<Map<string, string>>(
    new Map(),
  );
  const recordingNoteToPanelRef = useRef<Map<string, string>>(new Map());
  const [meetingReadyToast, setMeetingReadyToast] = useState<string | null>(
    null,
  );
  const [bgJobs, setBgJobs] = useState<Map<string, BgJob>>(new Map());
  const spacePendingTimeout = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const primaryModifier = isMacOS() ? "⌘" : "Ctrl";

  const panelRefs = useRef<Map<string, PanelHandle>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStartWidths = useRef<number[]>([]);
  const prevActivePanelRef = useRef(0);
  const pendingFocusPanelId = useRef<string | null>(firstPanelId);
  const closeRequestInFlight = useRef(false);

  const setActivePanelIndex = useCallback(
    (next: number | ((prev: number) => number)) => {
      _setActivePanelIndex((current) => {
        const nextVal = typeof next === "function" ? next(current) : next;
        if (nextVal !== current) {
          prevActivePanelRef.current = current;
        }
        return nextVal;
      });
    },
    [],
  );

  const handleThemeChange = useCallback((id: string) => {
    setThemeId(id);
    saveTheme(id);
    applyThemeVars(id);
  }, []);

  const handleDeviceChange = useCallback((device: string | null) => {
    setRecordingDevice(device);
    if (device) {
      localStorage.setItem("recording-device", device);
    } else {
      localStorage.removeItem("recording-device");
    }
  }, []);

  const fetchModelData = useCallback(async () => {
    try {
      const [settings, ollama, whisper] = await Promise.all([
        getModelSettings(),
        listOllamaModels(),
        listWhisperModels(),
      ]);
      setModelSettings(settings);
      setOllamaModels(ollama);
      setWhisperModels(whisper);
    } catch {
      // ignore
    }
  }, []);

  const handleModelSettingsChange = useCallback(
    async (settings: ModelSettings) => {
      setModelSettings(settings);
      try {
        await setModelSettingsApi(settings);
      } catch {
        // ignore
      }
    },
    [],
  );

  const handlePullModel = useCallback(async (name: string) => {
    try {
      await pullOllamaModel(name);
    } finally {
      setPullProgress(null);
    }
    // Refresh model list after install.
    try {
      const ollama = await listOllamaModels();
      setOllamaModels(ollama);
    } catch {
      // ignore
    }
  }, []);

  // Fetch model data when settings panel opens
  useEffect(() => {
    if (showSettings) {
      void fetchModelData();
      void Promise.all([getNotesDir(), getGitRemote()])
        .then(([dir, remote]) => {
          setCurrentNotesDir(dir);
          setConnectedGitRemote(remote);
        })
        .catch(() => {
          // ignore
        });
    }
  }, [showSettings, fetchModelData]);

  // Persist vim mode
  useEffect(() => {
    localStorage.setItem("note-vim", vimEnabled ? "1" : "0");
  }, [vimEnabled]);

  // Apply zoom
  useEffect(() => {
    localStorage.setItem("note-zoom", String(zoom));
    const scaleFactor = zoom / 100;
    const requestId = ++zoomApplyRequest.current;

    const applyZoom = async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        await getCurrentWebview().setZoom(scaleFactor);
        if (zoomApplyRequest.current !== requestId) return;
        // Clear any fallback CSS zoom after native zoom is applied.
        document.documentElement.style.zoom = "";
      } catch {
        if (zoomApplyRequest.current !== requestId) return;
        // Browser fallback when not running in Tauri.
        document.documentElement.style.zoom = `${zoom}%`;
      }
    };

    void applyZoom();
  }, [zoom]);

  const refreshSharedState = useCallback(async () => {
    try {
      const [notes, pinned, tags] = await Promise.all([
        listRecentNotes(20, sortBy),
        listPinnedNotes(sortBy),
        getAllTags(),
      ]);
      setRecentNotes(notes);
      setPinnedNotes(pinned);
      setAllTags(tags);
    } catch {
      // Ignore errors
    }
  }, [sortBy]);

  const handleBgJob = useCallback(
    (key: string, label: string | null, noteId?: string) => {
      setBgJobs((prev) => {
        const next = new Map(prev);
        if (label) {
          next.set(key, { label, noteId });
        } else {
          next.delete(key);
        }
        return next;
      });
    },
    [],
  );

  const checkGitSetup = useCallback(async () => {
    try {
      const remote = await getGitRemote();
      setConnectedGitRemote(remote);
      setGitBanner(remote === null);
    } catch {
      // Not in Tauri or git not available
    }
  }, []);

  // Init
  useEffect(() => {
    applyThemeVars(themeId);
    const init = async () => {
      try {
        await rebuildIndex();
      } catch {
        // Index rebuild may fail in web-only mode
      }
      await refreshSharedState();

      // First-run prompt for notes directory (before git setup).
      try {
        const currentNotesDir = await getNotesDir();
        setCurrentNotesDir(currentNotesDir);
        const promptedNotesDir =
          localStorage.getItem(NOTES_DIR_PROMPT_KEY) === "1";
        if (currentNotesDir && !promptedNotesDir) {
          setNotesDirPath(currentNotesDir);
          setNotesDirBanner(true);
          return;
        }
      } catch {
        // Not in Tauri
      }

      await checkGitSetup();

      // Check external tool availability.
      try {
        const status = await checkTools();
        setToolStatus(status);
      } catch {
        // Not in Tauri
      }
    };
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for backend sync events
  useEffect(() => {
    let cancelled = false;
    let unlistenGitError: (() => void) | undefined;
    let unlistenNotesChanged: (() => void) | undefined;
    let unlistenRecStarted: (() => void) | undefined;
    let unlistenRecTick: (() => void) | undefined;
    let unlistenRecStopped: (() => void) | undefined;
    let unlistenRecProgress: (() => void) | undefined;
    let unlistenRecComplete: (() => void) | undefined;
    let unlistenRecError: (() => void) | undefined;
    let unlistenPullProgress: (() => void) | undefined;
    let unlistenGitSync: (() => void) | undefined;
    let unlistenQmdProcessing: (() => void) | undefined;
    let unlistenRelatedChanged: (() => void) | undefined;

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const register = async (
          event: string,
          handler: (event: { payload: any }) => void,
        ): Promise<(() => void) | undefined> => {
          const unlisten = await listen(event as never, handler as never);
          if (cancelled) {
            unlisten();
            return undefined;
          }
          return unlisten;
        };

        unlistenGitError = await register(
          "git-sync-error",
          (event: { payload: string }) => {
            setGitError(event.payload);
            setTimeout(() => setGitError(null), 5000);
          },
        );
        unlistenNotesChanged = await register("notes-changed", () => {
          void refreshSharedState();
          for (const panel of panelRefs.current.values()) {
            void panel.refreshLoadedNote();
          }
        });
        unlistenRecStarted = await register(
          "recording-started",
          (event: { payload: string }) => {
            const noteId = event.payload;
            const panelId =
              pendingRecordingPanelsByNoteRef.current.get(noteId) ??
              recordingNoteToPanelRef.current.get(noteId) ??
              pendingRecordingPanelRef.current;
            pendingRecordingPanelsByNoteRef.current.delete(noteId);
            pendingRecordingPanelRef.current = null;
            if (panelId) {
              recordingNoteToPanelRef.current.set(noteId, panelId);
              setProcessingProgressByPanel((prev) => {
                if (!prev[panelId]) return prev;
                const next = { ...prev };
                delete next[panelId];
                return next;
              });
            }
            recordingStartPendingRef.current = false;
            setRecordingStartPending(false);
            setProcessingProgressByNote((prev) => {
              if (!prev[noteId]) return prev;
              const next = { ...prev };
              delete next[noteId];
              return next;
            });
            setRecording({
              active: true,
              note_id: noteId,
              elapsed_seconds: 0,
              mic_level: 0,
              system_level: 0,
            });
            setRecordingPanelId(panelId ?? null);
          },
        );
        unlistenRecTick = await register(
          "recording-tick",
          (event: {
            payload: {
              elapsed_seconds: number;
              mic_level: number;
              system_level: number;
            };
          }) => {
            setRecording((prev) => ({
              ...prev,
              elapsed_seconds: event.payload.elapsed_seconds,
              mic_level: event.payload.mic_level,
              system_level: event.payload.system_level,
            }));
          },
        );
        unlistenRecStopped = await register(
          "recording-stopped",
          (event: { payload: string }) => {
            const noteId = event.payload;
            const panelId = recordingNoteToPanelRef.current.get(noteId);
            setRecording((prev) => ({ ...prev, active: false }));
            setRecordingPanelId(null);
            if (recordingCloseWarningTimeout.current) {
              clearTimeout(recordingCloseWarningTimeout.current);
            }
            setRecordingCloseWarningIndex(null);
            setProcessingProgressByNote((prev) => ({
              ...prev,
              [noteId]: "Processing...",
            }));
            if (panelId) {
              setProcessingProgressByPanel((prev) => ({
                ...prev,
                [panelId]: "Processing...",
              }));
            }
          },
        );
        unlistenRecProgress = await register(
          "recording-progress",
          (event: {
            payload: { note_id: string; stage: string; detail: string };
          }) => {
            setProcessingProgressByNote((prev) => ({
              ...prev,
              [event.payload.note_id]: event.payload.detail,
            }));
            const panelId = recordingNoteToPanelRef.current.get(
              event.payload.note_id,
            );
            if (!panelId) return;
            setProcessingProgressByPanel((prev) => ({
              ...prev,
              [panelId]: event.payload.detail,
            }));
          },
        );
        unlistenRecComplete = await register(
          "recording-complete",
          (event: {
            payload: {
              note_id: string;
              summary: string | null;
              transcript: string | null;
            };
          }) => {
            const { note_id, summary, transcript } = event.payload;
            const sourcePanelId = recordingNoteToPanelRef.current.get(note_id);
            if (sourcePanelId) {
              setProcessingProgressByPanel((prev) => {
                if (!prev[sourcePanelId]) return prev;
                const next = { ...prev };
                delete next[sourcePanelId];
                return next;
              });
            }
            recordingNoteToPanelRef.current.delete(note_id);
            pendingRecordingPanelsByNoteRef.current.delete(note_id);
            setProcessingProgressByNote((prev) => {
              if (!prev[note_id]) return prev;
              const next = { ...prev };
              delete next[note_id];
              return next;
            });
            setRecording((prev) => {
              if (prev.active || prev.note_id !== note_id) return prev;
              return {
                active: false,
                note_id: null,
                elapsed_seconds: 0,
                mic_level: 0,
                system_level: 0,
              };
            });
            void refreshSharedState();
            if (summary && transcript) {
              // Existing note — first try the panel where recording started.
              let found = false;
              if (sourcePanelId) {
                const sourcePanel = panelRefs.current.get(sourcePanelId);
                if (sourcePanel && sourcePanel.getLoadedNoteId() === note_id) {
                  void sourcePanel.appendMeetingData(summary, transcript);
                  found = true;
                }
              }
              if (!found) {
                for (const panel of panelRefs.current.values()) {
                  if (panel.getLoadedNoteId() === note_id) {
                    void panel.appendMeetingData(summary, transcript);
                    found = true;
                    break;
                  }
                }
              }
              if (!found) {
                // Panel was closed or note unloaded — persist meeting data to the note
                // so reopening it later still shows summary/transcript.
                void appendMeetingDataToNote(note_id, summary, transcript)
                  .then(() => {
                    void refreshSharedState();
                    setMeetingReadyToast(note_id);
                    setTimeout(() => setMeetingReadyToast(null), 8000);
                  })
                  .catch(() => {
                    setMeetingReadyToast(note_id);
                    setTimeout(() => setMeetingReadyToast(null), 8000);
                  });
              }
            } else {
              // New note created by backend — never replace the source editing panel.
              let loaded = false;
              for (const [panelId, panel] of panelRefs.current.entries()) {
                if (panelId === sourcePanelId) continue;
                if (
                  !panel.getLoadedNoteId() &&
                  !panel.hasContent() &&
                  !panel.isUserModified()
                ) {
                  panel.loadNote(note_id);
                  loaded = true;
                  break;
                }
              }
              if (!loaded) {
                // No truly empty panel available — open meeting output in a new side panel
                // while keeping focus in the current editor.
                setPanels((prev) => [
                  ...prev,
                  {
                    id: genPanelId(),
                    initialNoteId: note_id,
                    independent: true,
                  },
                ]);
                setPanelWidths((w) => [...w, 1]);
              }
            }
          },
        );
        unlistenRecError = await register(
          "recording-error",
          (event: { payload: string }) => {
            setGitError(event.payload); // Reuse the error toast
            setTimeout(() => setGitError(null), 5000);
            recordingStartPendingRef.current = false;
            setRecordingStartPending(false);
            if (recordingCloseWarningTimeout.current) {
              clearTimeout(recordingCloseWarningTimeout.current);
            }
            setRecordingCloseWarningIndex(null);
            pendingRecordingPanelsByNoteRef.current.clear();
            pendingRecordingPanelRef.current = null;
          },
        );

        unlistenPullProgress = await register(
          "ollama-pull-progress",
          (event: {
            payload: {
              model: string;
              status: string;
              completed: number | null;
              total: number | null;
            };
          }) => {
            const { model, status, completed, total } = event.payload;
            const percent =
              completed != null && total != null && total > 0
                ? Math.round((completed / total) * 100)
                : null;
            setPullProgress({ model, status, percent });
          },
        );

        // Resume any pending recording jobs from a previous session.
        void checkPendingJobs();

        unlistenGitSync = await register(
          "git-sync-status",
          (event: { payload: boolean }) => {
            setBgJobs((prev) => {
              const next = new Map(prev);
              if (event.payload) {
                next.set("git-sync", { label: "Syncing with git" });
              } else {
                next.delete("git-sync");
              }
              return next;
            });
          },
        );

        unlistenQmdProcessing = await register(
          "qmd-processing",
          (event: { payload: string[] }) => {
            const noteIds = event.payload;
            setBgJobs((prev) => {
              const next = new Map(prev);
              for (const key of next.keys()) {
                if (key.startsWith("qmd-")) next.delete(key);
              }
              for (const id of noteIds) {
                next.set(`qmd-${id}`, {
                  label: "Getting tags & related notes",
                  noteId: id,
                });
              }
              return next;
            });
          },
        );

        unlistenRelatedChanged = await register("related-notes-changed", () => {
          setBgJobs((prev) => {
            const next = new Map(prev);
            for (const key of next.keys()) {
              if (key.startsWith("qmd-")) next.delete(key);
            }
            return next;
          });
        });
      } catch {
        // Not in Tauri
      }
    })();

    return () => {
      cancelled = true;
      unlistenGitError?.();
      unlistenNotesChanged?.();
      unlistenRecStarted?.();
      unlistenRecTick?.();
      unlistenRecStopped?.();
      unlistenRecProgress?.();
      unlistenRecComplete?.();
      unlistenRecError?.();
      unlistenPullProgress?.();
      unlistenGitSync?.();
      unlistenQmdProcessing?.();
      unlistenRelatedChanged?.();
    };
  }, [refreshSharedState]);

  // Re-fetch when sort order changes
  useEffect(() => {
    refreshSharedState();
  }, [refreshSharedState]);

  const setPanelRef = useCallback(
    (panelId: string) => (handle: PanelHandle | null) => {
      if (handle) {
        panelRefs.current.set(panelId, handle);
        if (pendingFocusPanelId.current === panelId) {
          pendingFocusPanelId.current = null;
          // Delay slightly so the panel fully mounts
          requestAnimationFrame(() => handle.focusEditor());
        }
      } else {
        panelRefs.current.delete(panelId);
      }
    },
    [],
  );

  // Find which panel (by index) already has a note open
  const findPanelWithNote = useCallback(
    (noteId: string): number => {
      for (let i = 0; i < panels.length; i++) {
        const ref = panelRefs.current.get(panels[i].id);
        if (ref && ref.getLoadedNoteId() === noteId) return i;
      }
      return -1;
    },
    [panels],
  );

  const openNoteToRight = useCallback(
    (
      panelIndex: number,
      noteId: string,
      forceNew: boolean,
      keepFocus?: boolean,
    ) => {
      setPanels((prev) => {
        if (forceNew) {
          // Cmd+click: always append to the far right as independent panel
          const newPanel: PanelState = {
            id: genPanelId(),
            initialNoteId: noteId,
            independent: true,
          };
          const next = [...prev, newPanel];
          setPanelWidths((w) => [...w, 1]);
          if (!keepFocus) setActivePanelIndex(next.length - 1);
          return next;
        }

        const rightIndex = panelIndex + 1;

        if (rightIndex < prev.length) {
          const rightPanel = prev[rightIndex];
          const rightRef = panelRefs.current.get(rightPanel.id);
          if (
            rightRef &&
            !rightPanel.independent &&
            !rightRef.isUserModified()
          ) {
            // Right panel is linked and not modified — reuse it
            rightRef.loadNote(noteId);
            if (!keepFocus) setActivePanelIndex(rightIndex);
            return prev;
          }
          // Right panel is independent or modified — insert new panel
          const newPanel: PanelState = {
            id: genPanelId(),
            initialNoteId: noteId,
          };
          const next = [...prev];
          next.splice(rightIndex, 0, newPanel);
          setPanelWidths((w) => {
            const nw = [...w];
            nw.splice(rightIndex, 0, 1);
            return nw;
          });
          if (!keepFocus) setActivePanelIndex(rightIndex);
          return next;
        }

        // No panel to the right — create one
        const newPanel: PanelState = {
          id: genPanelId(),
          initialNoteId: noteId,
        };
        setPanelWidths((w) => [...w, 1]);
        if (!keepFocus) setActivePanelIndex(rightIndex);
        return [...prev, newPanel];
      });
    },
    [],
  );

  const openNewPanelToRight = useCallback(() => {
    const newId = genPanelId();
    pendingFocusPanelId.current = newId;
    setPanels((prev) => {
      const newPanel: PanelState = { id: newId, independent: true };
      const next = [...prev, newPanel];
      setPanelWidths((w) => [...w, 1]);
      setActivePanelIndex(next.length - 1);
      return next;
    });
  }, []);

  const handleNoteClick = useCallback(
    (panelIndex: number, noteId: string, metaKey: boolean) => {
      // If note is already open in any panel, just focus that panel
      const existingIndex = findPanelWithNote(noteId);
      if (existingIndex !== -1) {
        setActivePanelIndex(existingIndex);
        return;
      }

      const panelRef = panelRefs.current.get(panels[panelIndex]?.id);

      if (metaKey) {
        openNoteToRight(panelIndex, noteId, true);
      } else if (panelRef && panelRef.isUserModified()) {
        openNoteToRight(panelIndex, noteId, false);
      } else if (panelRef) {
        panelRef.loadNote(noteId);
      }
    },
    [panels, findPanelWithNote, openNoteToRight],
  );

  const closePanel = useCallback(
    (index: number, focusIndex?: number) => {
      setPanels((prev) => {
        if (prev.length <= 1) return prev;
        const next = prev.filter((_, i) => i !== index);
        setPanelWidths((w) => w.filter((_, i) => i !== index));
        if (focusIndex !== undefined) {
          // Adjust the requested focus index for the removed panel
          let adjusted = focusIndex;
          if (focusIndex > index) adjusted--;
          setActivePanelIndex(Math.min(adjusted, next.length - 1));
        } else {
          setActivePanelIndex((active) => {
            if (active >= next.length) return next.length - 1;
            if (active > index) return active - 1;
            return active;
          });
        }
        return next;
      });
    },
    [setActivePanelIndex],
  );

  const handleRecordingPanelClose = useCallback(
    (index: number): boolean => {
      const panelId = panels[index]?.id;
      const isRecordingPanel =
        !!panelId && recording.active && panelId === recordingPanelId;
      if (!isRecordingPanel) return false;

      if (recordingCloseWarningIndex === index) {
        if (recordingCloseWarningTimeout.current) {
          clearTimeout(recordingCloseWarningTimeout.current);
        }
        setRecordingCloseWarningIndex(null);
        void stopRecording();
        closePanel(index);
        return true;
      }

      if (closeWarningTimeout.current)
        clearTimeout(closeWarningTimeout.current);
      setCloseWarningIndex(null);
      if (recordingCloseWarningTimeout.current) {
        clearTimeout(recordingCloseWarningTimeout.current);
      }
      setRecordingCloseWarningIndex(index);
      recordingCloseWarningTimeout.current = setTimeout(
        () => setRecordingCloseWarningIndex(null),
        3000,
      );
      return true;
    },
    [
      panels,
      recording.active,
      recordingPanelId,
      recordingCloseWarningIndex,
      closePanel,
    ],
  );

  const handleStartRecording = useCallback(
    async (panelIdArg?: string) => {
      if (recording.active || recordingStartPendingRef.current) return;
      const panelId = panelIdArg ?? panels[activePanelIndex]?.id;
      if (!panelId) return;
      const panel = panelRefs.current.get(panelId);
      let noteId: string | undefined;
      if (panel) {
        noteId = panel.getLoadedNoteId() ?? undefined;
        // Ensure recording is always tied to this panel's note, even if brand-new.
        if (!noteId) {
          noteId = await panel.ensureRecordingNote();
        }
      }
      pendingRecordingPanelRef.current = panelId;
      recordingStartPendingRef.current = true;
      setRecordingStartPending(true);
      try {
        const startedNoteId = await startRecording(
          recordingDevice ?? undefined,
          noteId,
        );
        pendingRecordingPanelsByNoteRef.current.set(startedNoteId, panelId);
        recordingNoteToPanelRef.current.set(startedNoteId, panelId);
      } catch (e) {
        recordingStartPendingRef.current = false;
        setRecordingStartPending(false);
        pendingRecordingPanelRef.current = null;
        const msg = e instanceof Error ? e.message : String(e);
        setGitError(msg);
        setTimeout(() => setGitError(null), 5000);
      }
    },
    [panels, activePanelIndex, recordingDevice, recording.active],
  );

  // Keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // When settings panel is open, only allow Cmd+, to close it
      if (showSettings) {
        if (e.key === "," && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          setShowSettings(false);
        }
        return;
      }

      // When search palette is open, only handle Cmd+P to close it
      if (searchPaletteOpen) {
        if (e.key === "p" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          setSearchPaletteOpen(false);
        }
        return;
      }

      // Cmd+, — open settings
      if (e.key === "," && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setShowSettings((v) => !v);
        return;
      }

      const activePanel = panelRefs.current.get(panels[activePanelIndex]?.id);
      if (!activePanel) return;

      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        const editorFocused = !!document.activeElement?.closest(".cm-editor");
        if (editorFocused) {
          activePanel.save(true);
        } else {
          activePanel.openSelectedNote(true);
        }
        return;
      }
      if (e.key === "Escape") {
        const editorFocused = !!document.activeElement?.closest(".cm-editor");
        if (vimEnabled && editorFocused) {
          return; // Let Vim handle Escape
        }
        e.preventDefault();
        if (activePanel.isUserModified() && editorFocused) {
          // Save and close (same as Cmd+Enter)
          activePanel.save();
        } else {
          if (
            activePanelIndex > 0 &&
            handleRecordingPanelClose(activePanelIndex)
          ) {
            return;
          }
          activePanel.clear();
          // If not leftmost and now empty, close it
          if (activePanelIndex > 0) {
            closePanel(activePanelIndex);
          }
        }
        return;
      }
      if (e.key === "t" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        activePanel.toggleTags();
        return;
      }
      if (e.key === "n" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        openNewPanelToRight();
        return;
      }
      if (
        e.key === "Backspace" &&
        (e.metaKey || e.ctrlKey) &&
        activePanel.canGoBack()
      ) {
        e.preventDefault();
        activePanel.goBack();
        return;
      }
      if (e.key === "w" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (panels.length <= 1) return;
        if (handleRecordingPanelClose(activePanelIndex)) return;
        if (activePanel.isUserModified() && activePanel.hasContent()) {
          if (closeWarningIndex === activePanelIndex) {
            // Second press — confirm close, discard unsaved content
            if (closeWarningTimeout.current)
              clearTimeout(closeWarningTimeout.current);
            setCloseWarningIndex(null);
            closePanel(activePanelIndex);
          } else {
            // First press — show warning
            if (closeWarningTimeout.current)
              clearTimeout(closeWarningTimeout.current);
            setCloseWarningIndex(activePanelIndex);
            closeWarningTimeout.current = setTimeout(
              () => setCloseWarningIndex(null),
              3000,
            );
          }
        } else {
          closePanel(activePanelIndex);
        }
        return;
      }
      // Cmd+E — edit current note
      if (e.key === "e" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        activePanel.edit();
        return;
      }
      // Cmd+D — delete current note (with confirmation)
      if (e.key === "d" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (!activePanel.getLoadedNoteId()) return;
        if (deleteWarning) {
          if (deleteWarningTimeout.current)
            clearTimeout(deleteWarningTimeout.current);
          setDeleteWarning(false);
          activePanel.deleteNote().then(() => {
            if (panels.length > 1) {
              if (!handleRecordingPanelClose(activePanelIndex)) {
                closePanel(activePanelIndex);
              }
            }
          });
        } else {
          if (deleteWarningTimeout.current)
            clearTimeout(deleteWarningTimeout.current);
          setDeleteWarning(true);
          deleteWarningTimeout.current = setTimeout(
            () => setDeleteWarning(false),
            3000,
          );
        }
        return;
      }
      // Cmd+H — focus left panel
      if (e.key === "h" && (e.metaKey || e.ctrlKey) && activePanelIndex > 0) {
        e.preventDefault();
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        setActivePanelIndex(activePanelIndex - 1);
        return;
      }
      // Cmd+L — focus right panel
      if (
        e.key === "l" &&
        (e.metaKey || e.ctrlKey) &&
        activePanelIndex < panels.length - 1
      ) {
        e.preventDefault();
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        setActivePanelIndex(activePanelIndex + 1);
        return;
      }
      // Show shortcuts: Ctrl+Cmd++ on Mac, Ctrl+/ on Linux
      if (
        (isMacOS() && e.key === "+" && e.metaKey && e.ctrlKey) ||
        (!isMacOS() && e.key === "/" && e.ctrlKey)
      ) {
        e.preventDefault();
        setShowHotkeys(true);
        return;
      }
      // Cmd/Ctrl + = or + — zoom in
      if ((e.key === "=" || e.key === "+") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setZoom((z) => Math.min(200, z + 10));
        return;
      }
      // Cmd+- — zoom out
      if (e.key === "-" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setZoom((z) => Math.max(50, z - 10));
        return;
      }
      // Cmd+0 — reset zoom
      if (e.key === "0" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setZoom(100);
        return;
      }
      // Cmd+Shift+P — toggle pin on current note
      if (
        e.key.toLowerCase() === "p" &&
        e.shiftKey &&
        (e.metaKey || e.ctrlKey)
      ) {
        e.preventDefault();
        activePanel.togglePin();
        return;
      }
      // Cmd+P — open search palette
      if (e.key.toLowerCase() === "p" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setSearchPaletteOpen(true);
        return;
      }
      // Cmd+Shift+R — toggle recording
      if (e.key === "R" && e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (recording.active) {
          void stopRecording();
        } else {
          void handleStartRecording();
        }
        return;
      }
      const editorFocused = !!document.activeElement?.closest(".cm-editor");
      const inputFocused =
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement;
      // Cmd+J/K — navigate list up/down
      if (
        (e.key === "j" || e.key === "k") &&
        (e.metaKey || e.ctrlKey) &&
        !editorFocused
      ) {
        e.preventDefault();
        activePanel.navigateList(e.key === "j" ? 1 : -1);
        return;
      }
      // J/K — scroll active panel, ArrowDown/ArrowUp — navigate list (only when not editing and editor not focused)
      if (!e.metaKey && !e.ctrlKey && !editorFocused && !inputFocused) {
        if (e.key === "j" || e.key === "k") {
          e.preventDefault();
          const panelEl =
            document.querySelectorAll(".panel-container")[activePanelIndex];
          if (panelEl) {
            panelEl.scrollBy({ top: e.key === "j" ? 100 : -100 });
          }
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          activePanel.navigateList(1);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          activePanel.navigateList(-1);
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          activePanel.openSelectedNote(false);
          return;
        }
        if (e.key === "G" && e.shiftKey) {
          e.preventDefault();
          const panelEl =
            document.querySelectorAll(".panel-container")[activePanelIndex];
          if (panelEl) panelEl.scrollTo({ top: panelEl.scrollHeight });
          if (gPendingTimeout.current) {
            clearTimeout(gPendingTimeout.current);
            gPendingTimeout.current = null;
          }
          return;
        }
        if (e.key === "g" && !e.shiftKey) {
          e.preventDefault();
          if (gPendingTimeout.current) {
            // Second g press — scroll to top
            clearTimeout(gPendingTimeout.current);
            gPendingTimeout.current = null;
            const panelEl =
              document.querySelectorAll(".panel-container")[activePanelIndex];
            if (panelEl) panelEl.scrollTo({ top: 0 });
          } else {
            // First g press — wait for possible second press
            gPendingTimeout.current = setTimeout(() => {
              gPendingTimeout.current = null;
            }, 300);
          }
          return;
        }
        if (e.key === " ") {
          e.preventDefault();
          if (spacePendingTimeout.current) {
            // Double space — open search palette
            clearTimeout(spacePendingTimeout.current);
            spacePendingTimeout.current = null;
            setSearchPaletteOpen(true);
          } else {
            // First space — wait for possible second press
            spacePendingTimeout.current = setTimeout(() => {
              spacePendingTimeout.current = null;
              // Single space — preview highlighted note
              const noteId = activePanel.getHighlightedNoteId();
              if (!noteId) return;
              if (findPanelWithNote(noteId) !== -1) return;
              openNoteToRight(activePanelIndex, noteId, false, true);
            }, 300);
          }
          return;
        }
      }
      // Space Space in Vim normal mode (editor focused but not in insert mode)
      // Don't preventDefault on first Space so Vim can still handle <Space>fs etc.
      if (
        e.key === " " &&
        !e.metaKey &&
        !e.ctrlKey &&
        editorFocused &&
        !inputFocused
      ) {
        const inVimNormal =
          vimEnabled &&
          !!document.activeElement
            ?.closest(".cm-editor")
            ?.querySelector(".cm-vimMode");
        if (inVimNormal) {
          if (spacePendingTimeout.current) {
            // Double space — open search palette
            e.preventDefault();
            clearTimeout(spacePendingTimeout.current);
            spacePendingTimeout.current = null;
            setSearchPaletteOpen(true);
          } else {
            // First space — let Vim handle it, but track for double-tap
            spacePendingTimeout.current = setTimeout(() => {
              spacePendingTimeout.current = null;
            }, 300);
          }
          return;
        }
      }
    },
    [
      panels,
      activePanelIndex,
      closePanel,
      handleRecordingPanelClose,
      openNewPanelToRight,
      findPanelWithNote,
      openNoteToRight,
      vimEnabled,
      closeWarningIndex,
      deleteWarning,
      searchPaletteOpen,
      showSettings,
      recording,
      handleStartRecording,
    ],
  );

  const handleKeyUp = useCallback((e: KeyboardEvent) => {
    // Hide hotkeys when Meta/Ctrl is released
    if (e.key === "Meta" || e.key === "Control") {
      setShowHotkeys(false);
    }
  }, []);

  useEffect(() => {
    // Use capture phase so Backspace is intercepted before CodeMirror
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [handleKeyDown, handleKeyUp]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    const setup = async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const appWindow = getCurrentWindow();
        const fn = await appWindow.onCloseRequested(async (event) => {
          event.preventDefault();
          if (closeRequestInFlight.current) return;
          closeRequestInFlight.current = true;

          try {
            const currentPanels = panels
              .map((panel) => panelRefs.current.get(panel.id))
              .filter((panel): panel is PanelHandle => !!panel);

            for (const panel of currentPanels) {
              await panel.saveIfNeeded(true);
            }

            await appWindow.destroy();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setGitError(msg);
            setTimeout(() => setGitError(null), 5000);
            closeRequestInFlight.current = false;
          }
        });
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      } catch {
        // Not in Tauri environment
      }
    };

    void setup();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [panels]);

  // Drag-and-drop import — use a ref so the listener doesn't need to re-subscribe
  const handleImportRef = useRef<(paths: string[]) => Promise<void>>(null!);
  handleImportRef.current = useCallback(
    async (paths: string[]) => {
      setImportStatus(
        `Importing ${paths.length} file${paths.length > 1 ? "s" : ""}...`,
      );
      let firstMeta: NoteMetadata | null = null;
      let count = 0;

      for (const path of paths) {
        try {
          const meta = await importMarkdownFile(path);
          if (!firstMeta) firstMeta = meta;
          count++;
        } catch (e) {
          console.error("Failed to import", path, e);
        }
      }

      if (count > 0) {
        await refreshSharedState();
        setImportStatus(`Imported ${count} note${count > 1 ? "s" : ""}`);
        // Open the note only when importing a single file
        if (count === 1 && firstMeta) {
          const activePanel = panelRefs.current.get(
            panels[activePanelIndex]?.id,
          );
          if (activePanel) {
            activePanel.loadNote(firstMeta.id);
          }
        }
      } else {
        setImportStatus("No files imported");
      }

      setTimeout(() => setImportStatus(null), 3000);
    },
    [panels, activePanelIndex, refreshSharedState],
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    const setup = async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const webview = getCurrentWebview();
        const fn = await webview.onDragDropEvent((event) => {
          if (cancelled) return;
          if (event.payload.type === "enter") {
            const paths: string[] = (event.payload as any).paths ?? [];
            if (paths.some((p) => p.endsWith(".md"))) {
              setDropZoneVisible(true);
            }
          } else if (event.payload.type === "leave") {
            setDropZoneVisible(false);
          } else if (event.payload.type === "drop") {
            setDropZoneVisible(false);
            const paths: string[] = (event.payload as any).paths ?? [];
            const mdPaths = paths.filter((p: string) => p.endsWith(".md"));
            if (mdPaths.length > 0) {
              handleImportRef.current(mdPaths);
            }
          }
        });
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      } catch {
        // Not in Tauri environment
      }
    };

    setup();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Drag splitter handling
  const handleDrag = useCallback(
    (index: number, deltaX: number) => {
      if (dragStartWidths.current.length === 0) {
        dragStartWidths.current = [...panelWidths];
      }
      const container = containerRef.current;
      if (!container) return;
      const totalWidth = container.clientWidth;
      const startWidths = dragStartWidths.current;
      const totalFlex = startWidths.reduce((a, b) => a + b, 0);
      const deltaFlex = (deltaX / totalWidth) * totalFlex;

      const left = Math.max(0.15, startWidths[index] + deltaFlex);
      const right = Math.max(0.15, startWidths[index + 1] - deltaFlex);

      setPanelWidths((w) => {
        const nw = [...w];
        nw[index] = left;
        nw[index + 1] = right;
        return nw;
      });
    },
    [panelWidths],
  );

  const handleDragEnd = useCallback(() => {
    dragStartWidths.current = [];
  }, []);

  const handleNotesDirConfirm = useCallback(async () => {
    const nextDir = notesDirPath.trim();
    if (!nextDir) return;

    try {
      const currentDir = await getNotesDir();
      if (currentDir && currentDir !== nextDir) {
        await setNotesDir(nextDir);
        await refreshSharedState();
      }
      setCurrentNotesDir(nextDir);

      localStorage.setItem(NOTES_DIR_PROMPT_KEY, "1");
      setNotesDirBanner(false);
      setGitError(null);
      await checkGitSetup();
    } catch (e) {
      console.error("Failed to set notes directory:", e);
      setGitError(e instanceof Error ? e.message : String(e));
      setTimeout(() => setGitError(null), 5000);
    }
  }, [notesDirPath, refreshSharedState, checkGitSetup]);

  const handleNotesDirLater = useCallback(() => {
    localStorage.setItem(NOTES_DIR_PROMPT_KEY, "1");
    setNotesDirBanner(false);
    void checkGitSetup();
  }, [checkGitSetup]);

  const handleGitConnect = useCallback(async () => {
    if (!gitRemoteUrl.trim()) return;
    try {
      await setGitRemote(gitRemoteUrl.trim());
      setConnectedGitRemote(gitRemoteUrl.trim());
      setGitBanner(false);
      setGitRemoteUrl("");
      setGitError(null);
    } catch (e) {
      console.error("Failed to set git remote:", e);
      setGitError(e instanceof Error ? e.message : String(e));
      setTimeout(() => setGitError(null), 5000);
    }
  }, [gitRemoteUrl]);

  const handleGitDismiss = useCallback(async () => {
    try {
      await dismissGitSetup();
    } catch {
      // ignore
    }
    setGitBanner(false);
  }, []);

  return (
    <>
      {notesDirBanner ? (
        <div className="git-banner">
          <span>Choose notes folder</span>
          <input
            className="git-banner-input"
            type="text"
            placeholder="~/lore"
            value={notesDirPath}
            onChange={(e) => setNotesDirPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleNotesDirConfirm();
            }}
          />
          <button
            className="git-banner-btn connect"
            onClick={handleNotesDirConfirm}
          >
            Continue
          </button>
          <button className="git-banner-btn" onClick={handleNotesDirLater}>
            Later
          </button>
        </div>
      ) : (
        gitBanner && (
          <div className="git-banner">
            <span>Set up git sync</span>
            <input
              className="git-banner-input"
              type="text"
              placeholder="Remote URL (e.g. git@github.com:user/notes.git)"
              value={gitRemoteUrl}
              onChange={(e) => setGitRemoteUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleGitConnect();
              }}
            />
            <button
              className="git-banner-btn connect"
              onClick={handleGitConnect}
            >
              Connect
            </button>
            <button className="git-banner-btn" onClick={handleGitDismiss}>
              Later
            </button>
          </div>
        )
      )}
      <div className="app-layout" ref={containerRef}>
        {panels.map((panel, index) => (
          <Fragment key={panel.id}>
            {index > 0 && (
              <DragSplitter
                onDrag={(delta) => handleDrag(index - 1, delta)}
                onDragEnd={handleDragEnd}
              />
            )}
            <div
              className={`panel-container ${activePanelIndex === index ? "focused" : ""}`}
              style={{ flex: panelWidths[index] }}
            >
              <NotePanel
                ref={setPanelRef(panel.id)}
                recentNotes={recentNotes}
                pinnedNotes={pinnedNotes}
                allTags={allTags}
                onNoteClick={(noteId, metaKey) =>
                  handleNoteClick(index, noteId, metaKey)
                }
                onNoteNavigate={(noteId, metaKey) =>
                  handleNoteClick(index, noteId, metaKey)
                }
                onSaved={refreshSharedState}
                onFocus={() => setActivePanelIndex(index)}
                initialNoteId={panel.initialNoteId}
                independent={panel.independent}
                sortBy={sortBy}
                onSortChange={setSortBy}
                themeId={themeId}
                vimEnabled={vimEnabled}
                onVimToggle={() => setVimEnabled((v) => !v)}
                recording={recording}
                processingProgress={processingProgressByPanel[panel.id] ?? null}
                processingProgressByNote={processingProgressByNote}
                recordingLocked={recording.active || recordingStartPending}
                onStartRecording={() => void handleStartRecording(panel.id)}
                onStopRecording={() => void stopRecording()}
                isRecordingPanel={panel.id === recordingPanelId}
                onBgJob={handleBgJob}
              />
            </div>
          </Fragment>
        ))}
      </div>
      {dropZoneVisible &&
        createPortal(
          <div className="drop-zone-overlay">
            <div className="drop-zone-content">Drop .md files to import</div>
          </div>,
          document.body,
        )}
      {importStatus &&
        createPortal(
          <div className="import-toast">{importStatus}</div>,
          document.body,
        )}
      {closeWarningIndex !== null &&
        createPortal(
          <div className="close-warning-toast">
            Unsaved changes — press <kbd>{primaryModifier}</kbd> <kbd>W</kbd>{" "}
            again to close
          </div>,
          document.body,
        )}
      {recordingCloseWarningIndex !== null &&
        createPortal(
          <div className="close-warning-toast">
            Recording in progress — close again to stop recording and close this
            panel
          </div>,
          document.body,
        )}
      {deleteWarning &&
        createPortal(
          <div className="delete-warning-toast">
            Delete note? Press <kbd>{primaryModifier}</kbd> <kbd>D</kbd> again
            to confirm
          </div>,
          document.body,
        )}
      {gitError &&
        createPortal(
          <div className="git-error-toast">{gitError}</div>,
          document.body,
        )}
      {meetingReadyToast &&
        createPortal(
          <div
            className="import-toast"
            style={{ cursor: "pointer" }}
            onClick={() => {
              const activePanel = panelRefs.current.get(
                panels[activePanelIndex]?.id,
              );
              if (activePanel) activePanel.loadNote(meetingReadyToast);
              setMeetingReadyToast(null);
            }}
          >
            Meeting note ready — click to open
          </div>,
          document.body,
        )}
      {searchPaletteOpen &&
        createPortal(
          <SearchPalette
            recentNotes={recentNotes}
            onSelect={(noteId, metaKey) => {
              const activePanel = panelRefs.current.get(
                panels[activePanelIndex]?.id,
              );
              if (!activePanel) return;
              if (metaKey) {
                // Cmd+Enter / Cmd+Click — open to the side, keep palette open
                const existingIndex = findPanelWithNote(noteId);
                if (existingIndex === -1) {
                  openNoteToRight(activePanelIndex, noteId, true, true);
                }
              } else {
                setSearchPaletteOpen(false);
                const existingIndex = findPanelWithNote(noteId);
                if (existingIndex !== -1) {
                  setActivePanelIndex(existingIndex);
                } else if (
                  activePanel.isUserModified() &&
                  activePanel.hasContent()
                ) {
                  openNoteToRight(activePanelIndex, noteId, false);
                } else {
                  activePanel.loadNote(noteId);
                }
              }
            }}
            onClose={() => setSearchPaletteOpen(false)}
          />,
          document.body,
        )}
      {createPortal(
        <div className="indicator-bar">
          <BackgroundJobsIndicator
            jobs={bgJobs}
            recording={recording}
            processingProgressByNote={processingProgressByNote}
            recentNotes={recentNotes}
            pullProgress={pullProgress}
            error={gitError}
          />
          {toolStatus &&
            (() => {
              const missingCount = [
                toolStatus.git,
                toolStatus.qmd,
                toolStatus.ollama,
                toolStatus.ffmpeg,
                toolStatus.whisper,
              ].filter((v) => !v).length;
              if (missingCount === 0) return null;
              return (
                <button
                  className="tool-status-indicator"
                  onClick={() => setShowSettings(true)}
                >
                  <span className="tool-missing">
                    {missingCount} tool{missingCount > 1 ? "s" : ""} missing
                  </span>
                </button>
              );
            })()}
          <ThemePicker themeId={themeId} onThemeChange={handleThemeChange} />
        </div>,
        document.body,
      )}
      {showSettings &&
        toolStatus &&
        createPortal(
          <SettingsPanel
            toolStatus={toolStatus}
            notesDirPath={currentNotesDir}
            gitRemoteUrl={connectedGitRemote}
            onSaveNotesDir={async (path) => {
              const next = path.trim();
              if (!next) return;
              await setNotesDir(next);
              setCurrentNotesDir(next);
              setNotesDirPath(next);
              await refreshSharedState();
            }}
            onSaveGitRemote={async (url) => {
              const next = url.trim();
              if (!next) return;
              await setGitRemote(next);
              setConnectedGitRemote(next);
              setGitRemoteUrl("");
              setGitBanner(false);
            }}
            recordingDevice={recordingDevice}
            onDeviceChange={handleDeviceChange}
            onRefreshTools={async () => {
              try {
                const status = await checkTools();
                setToolStatus(status);
              } catch {
                /* ignore */
              }
            }}
            onInstallTool={async (tool) => {
              try {
                await openToolInstaller(tool);
                setImportStatus("Installer opened in Terminal");
                setTimeout(() => setImportStatus(null), 3000);
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                setGitError(msg);
                setTimeout(() => setGitError(null), 5000);
                throw e;
              }
            }}
            onClose={() => setShowSettings(false)}
            modelSettings={modelSettings}
            ollamaModels={ollamaModels}
            whisperModels={whisperModels}
            onModelSettingsChange={handleModelSettingsChange}
            onPullModel={handlePullModel}
            pullProgress={pullProgress}
          />,
          document.body,
        )}
      {showHotkeys &&
        createPortal(
          <div className="hotkeys-overlay">
            <div className="hotkeys-panel">
              <div className="hotkeys-title">Keyboard Shortcuts</div>
              <div className="hotkeys-list">
                <div className="hotkey-row">
                  <kbd>{primaryModifier}</kbd> <kbd>Enter</kbd>
                  <span>Save note</span>
                </div>
                <div className="hotkey-row">
                  <kbd>{primaryModifier}</kbd> <kbd>P</kbd>
                  <span>Search notes</span>
                </div>
                <div className="hotkey-row">
                  <kbd>{primaryModifier}</kbd> <kbd>⇧</kbd> <kbd>P</kbd>
                  <span>Toggle pin</span>
                </div>
                <div className="hotkey-row">
                  <kbd>{primaryModifier}</kbd> <kbd>N</kbd>
                  <span>New note</span>
                </div>
                <div className="hotkey-row">
                  <kbd>{primaryModifier}</kbd> <kbd>E</kbd>
                  <span>Edit note</span>
                </div>
                <div className="hotkey-row">
                  <kbd>{primaryModifier}</kbd> <kbd>D</kbd>
                  <span>Delete note</span>
                </div>
                <div className="hotkey-row">
                  <kbd>{primaryModifier}</kbd> <kbd>T</kbd>
                  <span>Toggle tags</span>
                </div>
                <div className="hotkey-row">
                  <kbd>{primaryModifier}</kbd> <kbd>⌫</kbd>
                  <span>Go back</span>
                </div>
                <div className="hotkey-row">
                  <kbd>{primaryModifier}</kbd> <kbd>H</kbd>
                  <span>Focus left panel</span>
                </div>
                <div className="hotkey-row">
                  <kbd>{primaryModifier}</kbd> <kbd>L</kbd>
                  <span>Focus right panel</span>
                </div>
                <div className="hotkey-row">
                  <kbd>{primaryModifier}</kbd> <kbd>W</kbd>
                  <span>Close rightmost panel</span>
                </div>
                <div className="hotkey-row">
                  <kbd>{primaryModifier}</kbd> <kbd>Click</kbd>
                  <span>Open in new panel</span>
                </div>
                <div className="hotkey-row">
                  <kbd>{primaryModifier}</kbd> <kbd>⇧</kbd> <kbd>R</kbd>
                  <span>Toggle recording</span>
                </div>
                <div className="hotkey-row">
                  <kbd>{primaryModifier}</kbd> <kbd>J</kbd>
                  <span>Select next note</span>
                </div>
                <div className="hotkey-row">
                  <kbd>{primaryModifier}</kbd> <kbd>K</kbd>
                  <span>Select previous note</span>
                </div>
                <div className="hotkey-row">
                  <kbd>J</kbd> / <kbd>K</kbd>
                  <span>Scroll down / up</span>
                </div>
                <div className="hotkey-row">
                  <kbd>Space</kbd> <kbd>Space</kbd>
                  <span>Search notes</span>
                </div>
                <div className="hotkey-row">
                  <kbd>Esc</kbd>
                  <span>Discard edits / close panel</span>
                </div>
                <div className="hotkey-row">
                  <kbd>Tab</kbd>
                  <span>Exit editor to list</span>
                </div>
                <div className="hotkey-row">
                  <kbd>{primaryModifier}</kbd> <kbd>+</kbd>
                  <span>Zoom in</span>
                </div>
                <div className="hotkey-row">
                  <kbd>{primaryModifier}</kbd> <kbd>-</kbd>
                  <span>Zoom out</span>
                </div>
                <div className="hotkey-row">
                  <kbd>{primaryModifier}</kbd> <kbd>0</kbd>
                  <span>Reset zoom</span>
                </div>
                <div className="hotkey-row">
                  <kbd>{primaryModifier}</kbd> <kbd>,</kbd>
                  <span>Settings</span>
                </div>
                {isMacOS() ? (
                  <div className="hotkey-row">
                    <kbd>⌃</kbd> <kbd>⌘</kbd> <kbd>+</kbd>
                    <span>Show shortcuts</span>
                  </div>
                ) : (
                  <div className="hotkey-row">
                    <kbd>Ctrl</kbd> <kbd>/</kbd>
                    <span>Show shortcuts</span>
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
