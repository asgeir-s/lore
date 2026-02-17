import {
  useEffect,
  useRef,
  useCallback,
  forwardRef,
  useImperativeHandle,
  useState,
} from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, drawSelection, keymap, placeholder, ViewUpdate } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import { history } from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { vim, Vim } from "@replit/codemirror-vim";

Vim.map("fd", "<Esc>", "insert");
import { SlashPalette, slashCommands } from "./SlashPalette";
import { themes } from "./themes";
import { openUrl } from "./api";

interface EditorProps {
  content: string;
  onChange: (value: string) => void;
  themeId: string;
  vimEnabled: boolean;
  onVimToggle: () => void;
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
  ({ content, onChange, themeId, vimEnabled, onVimToggle }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
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

    onChangeRef.current = onChange;

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
          }
        },
      );

      const startState = EditorState.create({
        doc: content,
        extensions: [
          vimCompartment.current.of(vimEnabled ? vim() : []),
          drawSelection(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
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

      // Cmd+Click to open links
      const handleClick = (event: MouseEvent) => {
        if (!event.metaKey && !event.ctrlKey) return;

        const url = findLinkUrl(view, event.clientX, event.clientY);
        if (url) {
          event.preventDefault();
          event.stopPropagation();
          openUrl(url);
        }
      };

      view.dom.addEventListener("click", handleClick);

      return () => {
        view.dom.removeEventListener("click", handleClick);
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
      </div>
    );
  },
);

Editor.displayName = "Editor";
