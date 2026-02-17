import { useState, useEffect, useRef, useCallback } from "react";
import { searchNotes } from "./api";
import type { NoteMetadata } from "./api";

interface SearchPaletteProps {
  recentNotes: NoteMetadata[];
  onSelect: (noteId: string, metaKey: boolean) => void;
  onClose: () => void;
}

export function SearchPalette({
  recentNotes,
  onSelect,
  onClose,
}: SearchPaletteProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NoteMetadata[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const displayedNotes = query.trim() ? results : recentNotes.slice(0, 8);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced search
  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);

    if (!query.trim()) {
      setResults([]);
      setActiveIndex(0);
      return;
    }

    searchTimeout.current = setTimeout(async () => {
      try {
        const notes = await searchNotes(query);
        setResults(notes);
        setActiveIndex(0);
      } catch {
        // Ignore search errors
      }
    }, 200);

    return () => {
      if (searchTimeout.current) clearTimeout(searchTimeout.current);
    };
  }, [query]);

  const navigate = useCallback(
    (delta: number) => {
      setActiveIndex((i) => {
        if (displayedNotes.length === 0) return 0;
        return (i + delta + displayedNotes.length) % displayedNotes.length;
      });
    },
    [displayedNotes.length],
  );

  const selectCurrent = useCallback((metaKey: boolean) => {
    if (displayedNotes[activeIndex]) {
      onSelect(displayedNotes[activeIndex].id, metaKey);
    }
  }, [activeIndex, displayedNotes, onSelect]);

  // Capture-phase keyboard handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "ArrowDown" || (e.key === "j" && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        e.stopPropagation();
        navigate(1);
        return;
      }
      if (e.key === "ArrowUp" || (e.key === "k" && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        e.stopPropagation();
        navigate(-1);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        selectCurrent(e.metaKey || e.ctrlKey);
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose, navigate, selectCurrent]);

  return (
    <div className="search-palette-overlay" onMouseDown={onClose}>
      <div
        className="search-palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="search-palette-input"
          type="text"
          placeholder="Search notes..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {displayedNotes.length > 0 && (
          <div className="search-palette-list">
            {displayedNotes.map((note, i) => (
              <button
                key={note.id}
                className={`search-palette-item ${i === activeIndex ? "active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(note.id, e.metaKey || e.ctrlKey);
                }}
                onMouseEnter={() => setActiveIndex(i)}
              >
                <span className="search-palette-title">{note.title}</span>
              </button>
            ))}
          </div>
        )}
        {displayedNotes.length === 0 && query.trim() && (
          <div className="search-palette-empty">No notes found</div>
        )}
      </div>
    </div>
  );
}
