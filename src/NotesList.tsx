import type { NoteMetadata } from "./api";

interface NotesListProps {
  notes: NoteMetadata[];
  label: string;
  onOpenNote: (id: string) => void;
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

export function NotesList({ notes, label, onOpenNote }: NotesListProps) {
  if (notes.length === 0) return null;

  return (
    <div className="notes-list">
      <div className="notes-list-header">{label}</div>
      {notes.map((note) => (
        <button
          key={note.id}
          className="note-item"
          onClick={() => onOpenNote(note.id)}
        >
          <span className="note-item-title">{note.title}</span>
          <span className="note-item-time">{relativeTime(note.created)}</span>
        </button>
      ))}
    </div>
  );
}
