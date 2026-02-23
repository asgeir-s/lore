import {
  useEffect,
  useRef,
  useCallback,
  forwardRef,
  useImperativeHandle,
  useState,
} from "react";
import { EditorState, Compartment, Transaction } from "@codemirror/state";
import { EditorView, drawSelection, keymap, placeholder, ViewUpdate } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import { history } from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { vim, Vim } from "@replit/codemirror-vim";
import { readText as tauriReadClipboard, writeText as tauriWriteClipboard } from "@tauri-apps/plugin-clipboard-manager";

Vim.map("fd", "<Esc>", "insert");
Vim.unmap("<Space>", "normal");
Vim.map("<Space>fs", ":w<CR>", "normal");

// System clipboard integration via Tauri clipboard plugin.
// We use the * register (which does NOT trigger navigator.clipboard) and
// back it with Tauri's native clipboard API to avoid the webview permission prompt.
let _clipboardCache = "";
tauriReadClipboard().then((t) => { if (t) _clipboardCache = t; }).catch(() => {});

export async function _syncVimClipboard() {
  try {
    const text = await tauriReadClipboard();
    if (text != null && text !== _clipboardCache) {
      _clipboardCache = text;
      _origStarSetText.call(_starReg, text, false, false);
    }
  } catch { /* clipboard unavailable */ }
}

const _rc = Vim.getRegisterController();
const _starReg = _rc.getRegister("*");
const _origStarSetText = _starReg.setText.bind(_starReg);
_starReg.setText = function (text?: string, linewise?: boolean, blockwise?: boolean) {
  _origStarSetText(text, linewise, blockwise);
  if (text) {
    _clipboardCache = text;
    tauriWriteClipboard(text).catch(() => {});
  }
};
_starReg.toString = function () {
  return _clipboardCache;
};

// Map default yank, delete, and paste to use the * register
Vim.noremap("y", '"*y', "normal");
Vim.noremap("Y", '"*Y', "normal");
Vim.noremap("p", '"*p', "normal");
Vim.noremap("P", '"*P', "normal");
Vim.noremap("d", '"*d', "normal");
Vim.noremap("D", '"*D', "normal");
Vim.noremap("y", '"*y', "visual");
Vim.noremap("d", '"*d', "visual");
Vim.noremap("p", '"*p', "visual");

const saveCallbacks = new WeakMap<EditorView, () => void>();
Vim.defineEx("w", "w", (cm: any) => {
  const view = cm.cm6 as EditorView;
  saveCallbacks.get(view)?.();
});

import { SlashPalette, slashCommands } from "./SlashPalette";
import { NoteLinkPalette } from "./NoteLinkPalette";
import { themes } from "./themes";
import { openUrl } from "./api";
import type { NoteMetadata } from "./api";

interface EditorProps {
  content: string;
  onChange: (value: string) => void;
  onSave: () => void;
  themeId: string;
  vimEnabled: boolean;
  onVimToggle: () => void;
  onNoteNavigate?: (noteId: string, metaKey: boolean) => void;
  recentNotes?: NoteMetadata[];
}

export interface EditorHandle {
  focus: () => void;
  blur: () => void;
  clear: () => void;
}

const editorTheme = EditorView.theme({
  "&": {
    fontSize: "16px",
  },
  ".cm-content": {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    padding: "0",
  },
  ".cm-line": {
    padding: "2px 0",
  },
  ".cm-scroller": {
    overflow: "auto",
  },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: "var(--text)",
  },
  "&.cm-focused .cm-selectionBackground": {
    background: "color-mix(in srgb, var(--accent) 25%, transparent) !important",
  },
  "& ::selection": {
    background: "color-mix(in srgb, var(--accent) 25%, transparent)",
  },
  ".cm-gutters": {
    display: "none",
  },
});

// Normal mode: styled with subtle formatting hints
const normalHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.8em", fontWeight: "700", lineHeight: "1.3" },
  { tag: tags.heading2, fontSize: "1.4em", fontWeight: "600", lineHeight: "1.4" },
  { tag: tags.heading3, fontSize: "1.15em", fontWeight: "600", lineHeight: "1.5" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.monospace, fontFamily: '"SF Mono", "Fira Code", Menlo, monospace', fontSize: "0.9em", backgroundColor: "var(--surface)", borderRadius: "4px", padding: "2px 6px" },
  { tag: tags.link, color: "var(--accent)", textDecoration: "underline", cursor: "pointer" },
  { tag: tags.url, color: "var(--accent)", cursor: "pointer" },
  { tag: tags.quote, color: "var(--text-muted)", fontStyle: "italic" },
  { tag: tags.processingInstruction, color: "var(--text-muted)", fontSize: "0.85em" },
]);

// Structural-only style: heading sizes & bold/italic, but no colors
// Used when an external theme is active so theme colors show through
const structuralHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.8em", fontWeight: "700", lineHeight: "1.3" },
  { tag: tags.heading2, fontSize: "1.4em", fontWeight: "600", lineHeight: "1.4" },
  { tag: tags.heading3, fontSize: "1.15em", fontWeight: "600", lineHeight: "1.5" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
]);

function findLinkUrl(view: EditorView, clientX: number, clientY: number): string | null {
  const pos = view.posAtCoords({ x: clientX, y: clientY });
  if (pos === null) return null;

  const line = view.state.doc.lineAt(pos);
  const posInLine = pos - line.from;
  const text = line.text;

  // Check markdown links [text](url)
  const mdLinkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  while ((match = mdLinkRegex.exec(text)) !== null) {
    if (posInLine >= match.index && posInLine < match.index + match[0].length) {
      return match[2];
    }
  }

  // Check bare URLs
  const urlRegex = /https?:\/\/[^\s)>\]]+/g;
  while ((match = urlRegex.exec(text)) !== null) {
    if (posInLine >= match.index && posInLine <= match.index + match[0].length) {
      return match[0];
    }
  }

  return null;
}

export const Editor = forwardRef<EditorHandle, EditorProps>(
  ({ content, onChange, onSave, themeId, vimEnabled, onVimToggle, onNoteNavigate, recentNotes }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    const onSaveRef = useRef(onSave);
    const isSettingContent = useRef(false);
    const highlightCompartment = useRef(new Compartment());
    const themeCompartment = useRef(new Compartment());
    const vimCompartment = useRef(new Compartment());

    const [slashState, setSlashState] = useState<{
      visible: boolean;
      x: number;
      y: number;
      filter: string;
      lineStart: number;
    }>({ visible: false, x: 0, y: 0, filter: "", lineStart: 0 });

    const [linkState, setLinkState] = useState<{
      visible: boolean;
      x: number;
      y: number;
      filter: string;
      linkStart: number;
    }>({ visible: false, x: 0, y: 0, filter: "", linkStart: 0 });

    const onNoteNavigateRef = useRef(onNoteNavigate);
    onNoteNavigateRef.current = onNoteNavigate;

    onChangeRef.current = onChange;
    onSaveRef.current = onSave;

    useImperativeHandle(ref, () => ({
      focus: () => viewRef.current?.focus(),
      blur: () => viewRef.current?.contentDOM.blur(),
      clear: () => {
        if (viewRef.current) {
          isSettingContent.current = true;
          viewRef.current.dispatch({
            changes: {
              from: 0,
              to: viewRef.current.state.doc.length,
              insert: "",
            },
            annotations: Transaction.addToHistory.of(false),
          });
          isSettingContent.current = false;
        }
      },
    }));

    const handleSlashSelect = useCallback(
      (insert: string) => {
        const view = viewRef.current;
        if (!view) return;

        // Replace the slash command text with the insert
        const { lineStart } = slashState;
        const cursor = view.state.selection.main.head;
        view.dispatch({
          changes: { from: lineStart, to: cursor, insert },
          selection: { anchor: lineStart + insert.length },
        });
        setSlashState((s) => ({ ...s, visible: false }));
        view.focus();
      },
      [slashState],
    );

    const handleLinkSelect = useCallback(
      (noteId: string, noteTitle: string) => {
        const view = viewRef.current;
        if (!view) return;

        const insert = `[${noteTitle}](note://${noteId})`;
        const { linkStart } = linkState;
        const cursor = view.state.selection.main.head;
        view.dispatch({
          changes: { from: linkStart, to: cursor, insert },
          selection: { anchor: linkStart + insert.length },
        });
        setLinkState((s) => ({ ...s, visible: false }));
        view.focus();
      },
      [linkState],
    );

    useEffect(() => {
      if (!containerRef.current) return;

      const updateListener = EditorView.updateListener.of(
        (update: ViewUpdate) => {
          if (update.docChanged && !isSettingContent.current) {
            const doc = update.state.doc.toString();
            onChangeRef.current(doc);

            // Check for slash commands
            const cursor = update.state.selection.main.head;
            const line = update.state.doc.lineAt(cursor);
            const textBefore = line.text.slice(0, cursor - line.from);

            // Match / at start of line or after space
            const slashMatch = textBefore.match(/(^|\s)(\/\S*)$/);
            if (slashMatch) {
              const filter = slashMatch[2].slice(1); // Remove leading /
              const coords = update.view.coordsAtPos(cursor);
              if (coords) {
                const editorRect =
                  containerRef.current?.getBoundingClientRect();
                if (editorRect) {
                  setSlashState({
                    visible: true,
                    x: coords.left - editorRect.left,
                    y: coords.bottom - editorRect.top + 4,
                    filter,
                    lineStart: line.from + (slashMatch.index ?? 0) + slashMatch[1].length,
                  });
                }
              }
            } else {
              setSlashState((s) =>
                s.visible ? { ...s, visible: false } : s,
              );
            }

            // Check for [[ note link trigger
            const linkMatch = textBefore.match(/\[\[([^\]]*)$/);
            if (linkMatch) {
              const filter = linkMatch[1];
              const coords = update.view.coordsAtPos(cursor);
              if (coords) {
                const editorRect =
                  containerRef.current?.getBoundingClientRect();
                if (editorRect) {
                  setLinkState({
                    visible: true,
                    x: coords.left - editorRect.left,
                    y: coords.bottom - editorRect.top + 4,
                    filter,
                    linkStart: line.from + (linkMatch.index ?? 0),
                  });
                }
              }
            } else {
              setLinkState((s) =>
                s.visible ? { ...s, visible: false } : s,
              );
            }
          }
        },
      );

      const startState = EditorState.create({
        doc: content,
        extensions: [
          vimCompartment.current.of(vimEnabled ? vim() : []),
          drawSelection(),
          history(),
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
          markdown({ base: markdownLanguage }),
          highlightCompartment.current.of(syntaxHighlighting(normalHighlightStyle)),
          themeCompartment.current.of(editorTheme),
          placeholder("Write..."),
          updateListener,
          EditorView.lineWrapping,
        ],
      });

      const view = new EditorView({
        state: startState,
        parent: containerRef.current,
      });

      viewRef.current = view;
      saveCallbacks.set(view, () => onSaveRef.current());

      // Sync system clipboard into vim * register on focus
      const handleEditorFocus = () => { _syncVimClipboard(); };
      view.contentDOM.addEventListener("focus", handleEditorFocus, true);
      const handleVisibilityChange = () => { if (!document.hidden) _syncVimClipboard(); };
      document.addEventListener("visibilitychange", handleVisibilityChange);

      // Cmd+hover to show pointer on links
      const handleMouseMove = (event: MouseEvent) => {
        if (event.metaKey || event.ctrlKey) {
          const url = findLinkUrl(view, event.clientX, event.clientY);
          view.contentDOM.style.cursor = url ? "pointer" : "";
        } else {
          if (view.contentDOM.style.cursor) view.contentDOM.style.cursor = "";
        }
      };

      const handleKeyChange = () => {
        if (view.contentDOM.style.cursor) view.contentDOM.style.cursor = "";
      };

      // Cmd+Click to open links
      const handleClick = (event: MouseEvent) => {
        if (!event.metaKey && !event.ctrlKey) return;

        const url = findLinkUrl(view, event.clientX, event.clientY);
        if (url) {
          event.preventDefault();
          event.stopPropagation();
          if (url.startsWith("note://")) {
            const uuid = url.slice("note://".length);
            onNoteNavigateRef.current?.(uuid, true);
          } else {
            openUrl(url);
          }
        }
      };

      view.dom.addEventListener("click", handleClick);
      view.dom.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("keyup", handleKeyChange);

      return () => {
        view.contentDOM.removeEventListener("focus", handleEditorFocus, true);
        document.removeEventListener("visibilitychange", handleVisibilityChange);
        view.dom.removeEventListener("click", handleClick);
        view.dom.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("keyup", handleKeyChange);
        view.destroy();
        viewRef.current = null;
      };
      // Only run on mount
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Reconfigure highlight style when theme changes
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const style = (themeId !== "default" && themes[themeId])
        ? structuralHighlightStyle
        : normalHighlightStyle;
      view.dispatch({
        effects: highlightCompartment.current.reconfigure(syntaxHighlighting(style)),
      });
    }, [themeId]);

    // Reconfigure CodeMirror theme when themeId changes
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const entry = themes[themeId];
      const ext = entry ? [entry.extension, editorTheme] : editorTheme;
      view.dispatch({
        effects: themeCompartment.current.reconfigure(ext),
      });
    }, [themeId]);

    // Reconfigure vim mode
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: vimCompartment.current.reconfigure(vimEnabled ? vim() : []),
      });
    }, [vimEnabled]);

    // Sync external content changes to editor
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const currentContent = view.state.doc.toString();
      if (currentContent !== content) {
        isSettingContent.current = true;
        view.dispatch({
          changes: { from: 0, to: currentContent.length, insert: content },
          annotations: Transaction.addToHistory.of(false),
        });
        isSettingContent.current = false;
      }
    }, [content]);

    // Filter slash commands
    const filteredCommands = slashState.visible
      ? slashCommands.filter((cmd) =>
          cmd.label.toLowerCase().startsWith(slashState.filter.toLowerCase()),
        )
      : [];

    const isThemed = themeId !== "default" && !!themes[themeId];

    return (
      <div className={`editor-container ${isThemed ? "themed" : ""}`} ref={containerRef}>
        <button
          className={`vim-toggle ${vimEnabled ? "active" : ""}`}
          onClick={onVimToggle}
          title={vimEnabled ? "Disable Vim mode" : "Enable Vim mode"}
        >
          Vim
        </button>
        {slashState.visible && filteredCommands.length > 0 && (
          <SlashPalette
            commands={filteredCommands}
            x={slashState.x}
            y={slashState.y}
            onSelect={handleSlashSelect}
            onClose={() => setSlashState((s) => ({ ...s, visible: false }))}
          />
        )}
        {linkState.visible && (
          <NoteLinkPalette
            x={linkState.x}
            y={linkState.y}
            initialFilter={linkState.filter}
            recentNotes={recentNotes ?? []}
            onSelect={handleLinkSelect}
            onClose={() => setLinkState((s) => ({ ...s, visible: false }))}
          />
        )}
      </div>
    );
  },
);

Editor.displayName = "Editor";
