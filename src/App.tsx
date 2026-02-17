import { useState, useEffect, useCallback, useRef, Fragment } from "react";
import { createPortal } from "react-dom";
import { NotePanel } from "./NotePanel";
import type { PanelHandle } from "./NotePanel";
import { DragSplitter } from "./DragSplitter";
import { listRecentNotes, getAllTags, rebuildIndex } from "./api";
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
  const [zoom, setZoom] = useState(() => {
    const saved = localStorage.getItem("note-zoom");
    return saved ? Number(saved) : 100;
  });

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

  // Apply zoom
  useEffect(() => {
    document.documentElement.style.zoom = `${zoom}%`;
    localStorage.setItem("note-zoom", String(zoom));
  }, [zoom]);

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
    };
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch when sort order changes
  useEffect(() => {
    refreshSharedState();
  }, [sortBy]);

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
        if (!activePanel.isUserModified()) {
          activePanel.openSelectedNote(true);
        } else {
          activePanel.save();
        }
        return;
      }
      if (e.key === "Escape") {
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
        if (activePanel.isUserModified()) {
          openNewPanelToRight();
        } else {
          activePanel.clear();
          activePanel.focusEditor();
        }
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
        const lastIndex = panels.length - 1;
        const lastPanel = panelRefs.current.get(panels[lastIndex].id);
        const restoreTo = prevActivePanelRef.current;
        if (lastPanel) {
          if (lastPanel.isUserModified()) {
            lastPanel.save().then(() => closePanel(lastIndex, restoreTo));
          } else {
            closePanel(lastIndex, restoreTo);
          }
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
      // Cmd+Ctrl++
      if (e.key === "+" && e.metaKey && e.ctrlKey) {
        e.preventDefault();
        setShowHotkeys(true);
        return;
      }
      // Cmd+= or Cmd++ — zoom in
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
      // J/K/ArrowDown/ArrowUp and Enter for list navigation (only when not editing and editor not focused)
      if (!e.metaKey && !e.ctrlKey && !editorFocused) {
        if (e.key === "j" || e.key === "ArrowDown") {
          e.preventDefault();
          activePanel.navigateList(1);
          return;
        }
        if (e.key === "k" || e.key === "ArrowUp") {
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
    [panels, activePanelIndex, closePanel, openNewPanelToRight, findPanelWithNote, openNoteToRight],
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

  return (
    <>
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
            className="panel-container"
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
              isFocused={activePanelIndex === index}
              initialNoteId={panel.initialNoteId}
              independent={panel.independent}
              sortBy={sortBy}
              onSortChange={setSortBy}
              themeId={themeId}
            />
          </div>
        </Fragment>
      ))}
    </div>
    <ThemePicker themeId={themeId} onThemeChange={handleThemeChange} />
      {showHotkeys && createPortal(
        <div className="hotkeys-overlay">
          <div className="hotkeys-panel">
            <div className="hotkeys-title">Keyboard Shortcuts</div>
            <div className="hotkeys-list">
              <div className="hotkey-row"><kbd>⌘</kbd> <kbd>Enter</kbd><span>Save note</span></div>
              <div className="hotkey-row"><kbd>⌘</kbd> <kbd>N</kbd><span>New note</span></div>
              <div className="hotkey-row"><kbd>⌘</kbd> <kbd>E</kbd><span>Edit note</span></div>
              <div className="hotkey-row"><kbd>⌘</kbd> <kbd>S</kbd><span>Star note</span></div>
              <div className="hotkey-row"><kbd>⌘</kbd> <kbd>T</kbd><span>Toggle tags</span></div>
              <div className="hotkey-row"><kbd>⌘</kbd> <kbd>⌫</kbd><span>Go back</span></div>
              <div className="hotkey-row"><kbd>⌘</kbd> <kbd>H</kbd><span>Focus left panel</span></div>
              <div className="hotkey-row"><kbd>⌘</kbd> <kbd>L</kbd><span>Focus right panel</span></div>
              <div className="hotkey-row"><kbd>⌘</kbd> <kbd>W</kbd><span>Close rightmost panel</span></div>
              <div className="hotkey-row"><kbd>⌘</kbd> <kbd>Click</kbd><span>Open in new panel</span></div>
              <div className="hotkey-row"><kbd>Esc</kbd><span>Discard edits / close panel</span></div>
              <div className="hotkey-row"><kbd>Tab</kbd><span>Exit editor to list</span></div>
              <div className="hotkey-row"><kbd>⌘</kbd> <kbd>+</kbd><span>Zoom in</span></div>
              <div className="hotkey-row"><kbd>⌘</kbd> <kbd>-</kbd><span>Zoom out</span></div>
              <div className="hotkey-row"><kbd>⌘</kbd> <kbd>0</kbd><span>Reset zoom</span></div>
              <div className="hotkey-row"><kbd>⌘</kbd> <kbd>⌃</kbd> <kbd>+</kbd><span>Show shortcuts</span></div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
