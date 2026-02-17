import { useEffect, useRef } from "react";
import type { NoteMetadata, SortBy } from "./api";

interface NotesListProps {
  notes: NoteMetadata[];
  label: string;
  onOpenNote: (id: string, metaKey: boolean) => void;
  highlightIndex?: number;
  sortBy: SortBy;
  onSortChange: (sortBy: SortBy) => void;
}

function relativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffHour < 24) return `${diffHour} hour${diffHour > 1 ? "s" : ""} ago`;
  if (diffDay === 1) return "yesterday";
  if (diffDay < 7) return `${diffDay} days ago`;
  return date.toLocaleDateString();
}

export function NotesList({ notes, label, onOpenNote, highlightIndex = -1, sortBy, onSortChange }: NotesListProps) {
  const highlightRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    highlightRef.current?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  if (notes.length === 0) return null;

  const isRecent = label === "Recent";

  return (
    <div className="notes-list">
      <div className="notes-list-header">
        <span>{label}</span>
        {isRecent && (
          <button
            className="sort-toggle"
            onClick={() => onSortChange(sortBy === "created" ? "modified" : "created")}
          >
            {sortBy === "created" ? "Created" : "Updated"}
          </button>
        )}
      </div>
      {notes.map((note, i) => {
        const showDivider = i > 0 && notes[i - 1].starred && !note.starred;
        return (
          <div key={note.id}>
            {showDivider && <div className="starred-divider" />}
            <button
              ref={i === highlightIndex ? highlightRef : undefined}
              className={`note-item ${i === highlightIndex ? "highlighted" : ""}`}
              onClick={(e) => onOpenNote(note.id, e.metaKey || e.ctrlKey)}
            >
              <span className="note-item-title">{note.starred && <span className="note-item-star">{"\u2605"}</span>}{note.title}</span>
              <span className="note-item-time">{relativeTime(sortBy === "modified" ? note.modified : note.created)}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
