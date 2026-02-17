import {
  useEffect,
  useRef,
  useCallback,
  forwardRef,
  useImperativeHandle,
  useState,
} from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, placeholder, ViewUpdate } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { defaultKeymap } from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { SlashPalette, slashCommands } from "./SlashPalette";
import { themes } from "./themes";
import { openUrl } from "./api";

interface EditorProps {
  content: string;
  onChange: (value: string) => void;
  editing: boolean;
  themeId: string;
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
  "&.cm-focused .cm-selectionBackground, ::selection": {
    background: "var(--accent) !important",
    opacity: "0.2",
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

// MD mode: plain raw markdown, no visual formatting
const rawHighlightStyle = HighlightStyle.define([
  { tag: tags.link, color: "var(--accent)" },
  { tag: tags.url, color: "var(--accent)" },
  { tag: tags.processingInstruction, color: "var(--text-muted)" },
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
  ({ content, onChange, editing, themeId }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    const editingRef = useRef(editing);
    const isSettingContent = useRef(false);
    const highlightCompartment = useRef(new Compartment());
    const themeCompartment = useRef(new Compartment());
    const [hoveredUrl, setHoveredUrl] = useState<string | null>(null);
    const [rawMode, setRawMode] = useState(false);

    editingRef.current = editing;
    const [caretHidden, setCaretHidden] = useState(false);

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
          keymap.of(defaultKeymap),
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

      // Attach native link click handler on the editor DOM
      const handleClick = (event: MouseEvent) => {
        if (editingRef.current && !event.metaKey && !event.ctrlKey) return;

        const url = findLinkUrl(view, event.clientX, event.clientY);
        if (url) {
          event.preventDefault();
          event.stopPropagation();
          openUrl(url);
        }
      };

      const handleMouseMove = (event: MouseEvent) => {
        const url = findLinkUrl(view, event.clientX, event.clientY);
        setHoveredUrl(url);
      };

      const handleMouseLeave = () => {
        setHoveredUrl(null);
      };

      const handleMouseDown = () => {
        setCaretHidden(false);
      };

      view.dom.addEventListener("click", handleClick);
      view.dom.addEventListener("mousedown", handleMouseDown);
      view.dom.addEventListener("mousemove", handleMouseMove);
      view.dom.addEventListener("mouseleave", handleMouseLeave);

      return () => {
        view.dom.removeEventListener("click", handleClick);
        view.dom.removeEventListener("mousedown", handleMouseDown);
        view.dom.removeEventListener("mousemove", handleMouseMove);
        view.dom.removeEventListener("mouseleave", handleMouseLeave);
        view.destroy();
        viewRef.current = null;
      };
      // Only run on mount
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Reconfigure highlight style when raw mode or theme changes
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      let style: HighlightStyle;
      if (rawMode) {
        style = rawHighlightStyle;
      } else if (themeId !== "default" && themes[themeId]) {
        style = structuralHighlightStyle;
      } else {
        style = normalHighlightStyle;
      }
      view.dispatch({
        effects: highlightCompartment.current.reconfigure(syntaxHighlighting(style)),
      });
    }, [rawMode, themeId]);

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

    // Hide caret and blur when entering view mode (note loaded)
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      if (!editing) {
        setCaretHidden(true);
        if (view.hasFocus) {
          view.contentDOM.blur();
        }
      } else {
        setCaretHidden(false);
      }
    }, [editing]);

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
      <div className={`editor-container ${editing ? "" : "viewing"} ${caretHidden ? "caret-hidden" : ""} ${rawMode ? "raw-mode" : ""} ${isThemed ? "themed" : ""}`} ref={containerRef}>
        <button
          className="mode-toggle"
          onClick={() => setRawMode((r) => !r)}
          title={rawMode ? "Switch to normal mode" : "Switch to markdown mode"}
        >
          {rawMode ? "Aa" : "MD"}
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
        {hoveredUrl && (
          <div className="link-preview">{hoveredUrl}</div>
        )}
      </div>
    );
  },
);

Editor.displayName = "Editor";
