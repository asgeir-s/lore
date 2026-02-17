import { useState, useEffect, useCallback, useRef, Fragment } from "react";
import { createPortal } from "react-dom";
import { NotePanel } from "./NotePanel";
import type { PanelHandle } from "./NotePanel";
import { DragSplitter } from "./DragSplitter";
import { listRecentNotes, getAllTags, rebuildIndex, importMarkdownFile, getGitRemote, setGitRemote, dismissGitSetup, getNotesDir, setNotesDir } from "./api";
import type { NoteMetadata, SortBy } from "./api";
import { loadSavedTheme, saveTheme, applyThemeVars } from "./themes";
import { ThemePicker } from "./ThemePicker";

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
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}

export default function App() {
  const [panels, setPanels] = useState<PanelState[]>(() => [
    { id: firstPanelId },
  ]);
  const [panelWidths, setPanelWidths] = useState<number[]>([1]);
  const [activePanelIndex, _setActivePanelIndex] = useState(0);
  const [recentNotes, setRecentNotes] = useState<NoteMetadata[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [showHotkeys, setShowHotkeys] = useState(false);
  const [sortBy, setSortBy] = useState<SortBy>("created");
  const [themeId, setThemeId] = useState(() => loadSavedTheme());
  const [vimEnabled, setVimEnabled] = useState(() => localStorage.getItem("note-vim") === "1");
  const [zoom, setZoom] = useState(() => {
    const saved = localStorage.getItem("note-zoom");
    return saved ? Number(saved) : 100;
  });
  const [dropZoneVisible, setDropZoneVisible] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [notesDirBanner, setNotesDirBanner] = useState(false);
  const [notesDirPath, setNotesDirPath] = useState("");
  const [gitBanner, setGitBanner] = useState(false);
  const [gitRemoteUrl, setGitRemoteUrl] = useState("");
  const [gitError, setGitError] = useState<string | null>(null);
  const [closeWarningIndex, setCloseWarningIndex] = useState<number | null>(null);
  const closeWarningTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const primaryModifier = isMacOS() ? "⌘" : "Ctrl";

  const panelRefs = useRef<Map<string, PanelHandle>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStartWidths = useRef<number[]>([]);
  const prevActivePanelRef = useRef(0);
  const pendingFocusPanelId = useRef<string | null>(firstPanelId);

  const setActivePanelIndex = useCallback((next: number | ((prev: number) => number)) => {
    _setActivePanelIndex((current) => {
      const nextVal = typeof next === "function" ? next(current) : next;
      if (nextVal !== current) {
        prevActivePanelRef.current = current;
      }
      return nextVal;
    });
  }, []);

  const handleThemeChange = useCallback((id: string) => {
    setThemeId(id);
    saveTheme(id);
    applyThemeVars(id);
  }, []);

  // Persist vim mode
  useEffect(() => {
    localStorage.setItem("note-vim", vimEnabled ? "1" : "0");
  }, [vimEnabled]);

  // Apply zoom
  useEffect(() => {
    document.documentElement.style.zoom = `${zoom}%`;
    localStorage.setItem("note-zoom", String(zoom));
  }, [zoom]);

  const refreshSharedState = useCallback(async () => {
    try {
      const [notes, tags] = await Promise.all([
        listRecentNotes(20, sortBy),
        getAllTags(),
      ]);
      setRecentNotes(notes);
      setAllTags(tags);
    } catch {
      // Ignore errors
    }
  }, [sortBy]);

  const checkGitSetup = useCallback(async () => {
    try {
      const remote = await getGitRemote();
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
        const promptedNotesDir = localStorage.getItem(NOTES_DIR_PROMPT_KEY) === "1";
        if (currentNotesDir && !promptedNotesDir) {
          setNotesDirPath(currentNotesDir);
          setNotesDirBanner(true);
          return;
        }
      } catch {
        // Not in Tauri
      }

      await checkGitSetup();
    };
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for backend sync events
  useEffect(() => {
    let unlistenGitError: (() => void) | undefined;
    let unlistenNotesChanged: (() => void) | undefined;

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlistenGitError = await listen<string>("git-sync-error", (event) => {
          setGitError(event.payload);
          setTimeout(() => setGitError(null), 5000);
        });
        unlistenNotesChanged = await listen("notes-changed", () => {
          void refreshSharedState();
          for (const panel of panelRefs.current.values()) {
            void panel.refreshLoadedNote();
          }
        });
      } catch {
        // Not in Tauri
      }
    })();

    return () => {
      unlistenGitError?.();
      unlistenNotesChanged?.();
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
    (panelIndex: number, noteId: string, forceNew: boolean, keepFocus?: boolean) => {
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

  const closePanel = useCallback((index: number, focusIndex?: number) => {
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
  }, [setActivePanelIndex]);

  // Keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const activePanel = panelRefs.current.get(
        panels[activePanelIndex]?.id,
      );
      if (!activePanel) return;

      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        const editorFocused = !!document.activeElement?.closest(".cm-editor");
        if (activePanel.isUserModified() && editorFocused) {
          activePanel.save();
        } else {
          activePanel.openSelectedNote(true);
        }
        return;
      }
      if (e.key === "Escape") {
        const editorFocused = !!document.activeElement?.closest(".cm-editor");
        if (vimEnabled && editorFocused) {
          return; // Let Vim handle Escape; Tab out of editor first to discard
        }
        e.preventDefault();
        if (activePanel.isUserModified()) {
          // Discard edits but keep panel open
          activePanel.discardEdits();
        } else {
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
        if (activePanel.isUserModified() && activePanel.hasContent()) {
          if (closeWarningIndex === activePanelIndex) {
            // Second press — confirm close, discard unsaved content
            if (closeWarningTimeout.current) clearTimeout(closeWarningTimeout.current);
            setCloseWarningIndex(null);
            closePanel(activePanelIndex);
          } else {
            // First press — show warning
            if (closeWarningTimeout.current) clearTimeout(closeWarningTimeout.current);
            setCloseWarningIndex(activePanelIndex);
            closeWarningTimeout.current = setTimeout(() => setCloseWarningIndex(null), 3000);
          }
        } else {
          closePanel(activePanelIndex);
        }
        return;
      }
      // Cmd+S — toggle star on current note
      if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        activePanel.toggleStar();
        return;
      }
      // Cmd+E — edit current note
      if (e.key === "e" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        activePanel.edit();
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
      if (e.key === "l" && (e.metaKey || e.ctrlKey) && activePanelIndex < panels.length - 1) {
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
      // Tab to leave the editor and enter list navigation mode
      const editorFocused = !!document.activeElement?.closest(".cm-editor");
      if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && editorFocused) {
        e.preventDefault();
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        activePanel.navigateList(1);
        return;
      }
      // Cmd+J/K — navigate list up/down
      if ((e.key === "j" || e.key === "k") && (e.metaKey || e.ctrlKey) && !editorFocused) {
        e.preventDefault();
        activePanel.navigateList(e.key === "j" ? 1 : -1);
        return;
      }
      // J/K — scroll active panel, ArrowDown/ArrowUp — navigate list (only when not editing and editor not focused)
      if (!e.metaKey && !e.ctrlKey && !editorFocused) {
        if (e.key === "j" || e.key === "k") {
          e.preventDefault();
          const panelEl = document.querySelectorAll(".panel-container")[activePanelIndex];
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
        if (e.key === " ") {
          e.preventDefault();
          const noteId = activePanel.getHighlightedNoteId();
          if (!noteId) return;
          // If note is already open in another panel, do nothing (it's already visible)
          if (findPanelWithNote(noteId) !== -1) return;
          // Always preview to the right without moving focus
          openNoteToRight(activePanelIndex, noteId, false, true);
          return;
        }
      }
    },
    [panels, activePanelIndex, closePanel, openNewPanelToRight, findPanelWithNote, openNoteToRight, vimEnabled, closeWarningIndex],
  );

  const handleKeyUp = useCallback(
    (e: KeyboardEvent) => {
      // Hide hotkeys when Meta/Ctrl is released
      if (e.key === "Meta" || e.key === "Control") {
        setShowHotkeys(false);
      }
    },
    [],
  );

  useEffect(() => {
    // Use capture phase so Backspace is intercepted before CodeMirror
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [handleKeyDown, handleKeyUp]);

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
        const { getCurrentWebview } = await import(
          "@tauri-apps/api/webview"
        );
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
          placeholder="~/notes"
          value={notesDirPath}
          onChange={(e) => setNotesDirPath(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleNotesDirConfirm(); }}
        />
        <button className="git-banner-btn connect" onClick={handleNotesDirConfirm}>Continue</button>
        <button className="git-banner-btn" onClick={handleNotesDirLater}>Later</button>
      </div>
    ) : gitBanner && (
      <div className="git-banner">
        <span>Set up git sync</span>
        <input
          className="git-banner-input"
          type="text"
          placeholder="Remote URL (e.g. git@github.com:user/notes.git)"
          value={gitRemoteUrl}
          onChange={(e) => setGitRemoteUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleGitConnect(); }}
        />
        <button className="git-banner-btn connect" onClick={handleGitConnect}>Connect</button>
        <button className="git-banner-btn" onClick={handleGitDismiss}>Later</button>
      </div>
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
              allTags={allTags}
              onNoteClick={(noteId, metaKey) =>
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
            />
          </div>
        </Fragment>
      ))}
    </div>
    <ThemePicker themeId={themeId} onThemeChange={handleThemeChange} />
      {dropZoneVisible && createPortal(
        <div className="drop-zone-overlay">
          <div className="drop-zone-content">Drop .md files to import</div>
        </div>,
        document.body,
      )}
      {importStatus && createPortal(
        <div className="import-toast">{importStatus}</div>,
        document.body,
      )}
      {closeWarningIndex !== null && createPortal(
        <div className="close-warning-toast">Unsaved changes — press <kbd>{primaryModifier}</kbd> <kbd>W</kbd> again to close</div>,
        document.body,
      )}
      {gitError && createPortal(
        <div className="git-error-toast">{gitError}</div>,
        document.body,
      )}
      {showHotkeys && createPortal(
        <div className="hotkeys-overlay">
          <div className="hotkeys-panel">
            <div className="hotkeys-title">Keyboard Shortcuts</div>
            <div className="hotkeys-list">
              <div className="hotkey-row"><kbd>{primaryModifier}</kbd> <kbd>Enter</kbd><span>Save note</span></div>
              <div className="hotkey-row"><kbd>{primaryModifier}</kbd> <kbd>N</kbd><span>New note</span></div>
              <div className="hotkey-row"><kbd>{primaryModifier}</kbd> <kbd>E</kbd><span>Edit note</span></div>
              <div className="hotkey-row"><kbd>{primaryModifier}</kbd> <kbd>S</kbd><span>Star note</span></div>
              <div className="hotkey-row"><kbd>{primaryModifier}</kbd> <kbd>T</kbd><span>Toggle tags</span></div>
              <div className="hotkey-row"><kbd>{primaryModifier}</kbd> <kbd>⌫</kbd><span>Go back</span></div>
              <div className="hotkey-row"><kbd>{primaryModifier}</kbd> <kbd>H</kbd><span>Focus left panel</span></div>
              <div className="hotkey-row"><kbd>{primaryModifier}</kbd> <kbd>L</kbd><span>Focus right panel</span></div>
              <div className="hotkey-row"><kbd>{primaryModifier}</kbd> <kbd>W</kbd><span>Close rightmost panel</span></div>
              <div className="hotkey-row"><kbd>{primaryModifier}</kbd> <kbd>Click</kbd><span>Open in new panel</span></div>
              <div className="hotkey-row"><kbd>{primaryModifier}</kbd> <kbd>J</kbd><span>Select next note</span></div>
              <div className="hotkey-row"><kbd>{primaryModifier}</kbd> <kbd>K</kbd><span>Select previous note</span></div>
              <div className="hotkey-row"><kbd>J</kbd> / <kbd>K</kbd><span>Scroll down / up</span></div>
              <div className="hotkey-row"><kbd>Esc</kbd><span>Discard edits / close panel</span></div>
              <div className="hotkey-row"><kbd>Tab</kbd><span>Exit editor to list</span></div>
              <div className="hotkey-row"><kbd>{primaryModifier}</kbd> <kbd>+</kbd><span>Zoom in</span></div>
              <div className="hotkey-row"><kbd>{primaryModifier}</kbd> <kbd>-</kbd><span>Zoom out</span></div>
              <div className="hotkey-row"><kbd>{primaryModifier}</kbd> <kbd>0</kbd><span>Reset zoom</span></div>
              {isMacOS()
                ? <div className="hotkey-row"><kbd>⌃</kbd> <kbd>⌘</kbd> <kbd>+</kbd><span>Show shortcuts</span></div>
                : <div className="hotkey-row"><kbd>Ctrl</kbd> <kbd>/</kbd><span>Show shortcuts</span></div>
              }
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
