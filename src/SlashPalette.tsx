import { useState, useEffect, useRef } from "react";

export interface SlashCommand {
  label: string;
  insert: string;
  preview: string;
}

export const slashCommands: SlashCommand[] = [
  { label: "h1", insert: "# ", preview: "Heading 1" },
  { label: "h2", insert: "## ", preview: "Heading 2" },
  { label: "h3", insert: "### ", preview: "Heading 3" },
  { label: "quote", insert: "> ", preview: "Blockquote" },
  { label: "list", insert: "- ", preview: "Bullet list" },
  { label: "ol", insert: "1. ", preview: "Numbered list" },
  { label: "code", insert: "```\n\n```", preview: "Code block" },
  { label: "link", insert: "[text](url)", preview: "Link" },
  { label: "note", insert: "[[note:]]", preview: "Note link" },
  { label: "divider", insert: "---", preview: "Divider" },
];

interface SlashPaletteProps {
  commands: SlashCommand[];
  x: number;
  y: number;
  onSelect: (insert: string) => void;
  onClose: () => void;
}

export function SlashPalette({
  commands,
  x,
  y,
  onSelect,
  onClose,
}: SlashPaletteProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const paletteRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setActiveIndex(0);
  }, [commands.length]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % commands.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + commands.length) % commands.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (commands[activeIndex]) {
          onSelect(commands[activeIndex].insert);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [activeIndex, commands, onSelect, onClose]);

  return (
    <div
      ref={paletteRef}
      className="slash-palette"
      style={{ left: x, top: y }}
    >
      {commands.map((cmd, i) => (
        <button
          key={cmd.label}
          className={`slash-item ${i === activeIndex ? "active" : ""}`}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(cmd.insert);
          }}
          onMouseEnter={() => setActiveIndex(i)}
        >
          <span className="slash-item-label">/{cmd.label}</span>
          <span className="slash-item-preview">{cmd.preview}</span>
        </button>
      ))}
    </div>
  );
}
