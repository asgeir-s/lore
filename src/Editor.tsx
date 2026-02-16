import {
  useEffect,
  useRef,
  useCallback,
  forwardRef,
  useImperativeHandle,
  useState,
} from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder, ViewUpdate } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { defaultKeymap } from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { SlashPalette, slashCommands } from "./SlashPalette";

interface EditorProps {
  content: string;
  onChange: (value: string) => void;
}

export interface EditorHandle {
  focus: () => void;
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

const highlightStyle = HighlightStyle.define([
  {
    tag: tags.heading1,
    fontSize: "1.8em",
    fontWeight: "700",
    lineHeight: "1.3",
  },
  {
    tag: tags.heading2,
    fontSize: "1.4em",
    fontWeight: "600",
    lineHeight: "1.4",
  },
  {
    tag: tags.heading3,
    fontSize: "1.15em",
    fontWeight: "600",
    lineHeight: "1.5",
  },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  {
    tag: tags.monospace,
    fontFamily: '"SF Mono", "Fira Code", Menlo, monospace',
    fontSize: "0.9em",
    backgroundColor: "var(--surface)",
    borderRadius: "4px",
    padding: "2px 6px",
  },
  { tag: tags.link, color: "var(--accent)", textDecoration: "underline" },
  { tag: tags.url, color: "var(--accent)" },
  { tag: tags.quote, color: "var(--text-muted)", fontStyle: "italic" },
  {
    tag: tags.processingInstruction,
    color: "var(--text-muted)",
    fontSize: "0.85em",
  },
]);

export const Editor = forwardRef<EditorHandle, EditorProps>(
  ({ content, onChange }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    const isSettingContent = useRef(false);
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
          syntaxHighlighting(highlightStyle),
          editorTheme,
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

      return () => {
        view.destroy();
        viewRef.current = null;
      };
      // Only run on mount
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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

    return (
      <div className="editor-container" ref={containerRef}>
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
