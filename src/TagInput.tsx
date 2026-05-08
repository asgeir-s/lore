import {
  useState,
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
} from "react";

export interface TagInputHandle {
  /** Commit any in-progress text as a tag. Returns the new tag, or null. */
  flush: () => string | null;
}

interface TagInputProps {
  tags: string[];
  allTags: string[];
  onChange: (tags: string[]) => void;
  autoFocus?: boolean;
}

export const TagInput = forwardRef<TagInputHandle, TagInputProps>(
  function TagInput({ tags, allTags, onChange, autoFocus = true }, ref) {
    const [input, setInput] = useState("");
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [activeIndex, setActiveIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
      if (autoFocus) {
        inputRef.current?.focus();
      }
    }, [autoFocus]);

    const suggestions = input
      ? allTags.filter(
          (t) =>
            t.toLowerCase().startsWith(input.toLowerCase()) &&
            !tags.includes(t),
        )
      : [];

    const addTag = (tag: string) => {
      const trimmed = tag.trim().toLowerCase();
      if (trimmed && !tags.includes(trimmed)) {
        onChange([...tags, trimmed]);
      }
      setInput("");
      setShowSuggestions(false);
      setActiveIndex(0);
    };

    // Returns the pending tag text (if any) so the caller can include it
    // before saving — React state updates from addTag are async.
    useImperativeHandle(ref, () => ({
      flush: (): string | null => {
        const trimmed = input.trim().toLowerCase();
        if (trimmed && !tags.includes(trimmed)) {
          addTag(input);
          return trimmed;
        }
        return null;
      },
    }));

    const removeTag = (tag: string) => {
      onChange(tags.filter((t) => t !== tag));
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (showSuggestions && suggestions[activeIndex]) {
          addTag(suggestions[activeIndex]);
        } else if (input.trim()) {
          addTag(input);
        }
      } else if (e.key === "ArrowDown" && showSuggestions) {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % suggestions.length);
      } else if (e.key === "ArrowUp" && showSuggestions) {
        e.preventDefault();
        setActiveIndex(
          (i) => (i - 1 + suggestions.length) % suggestions.length,
        );
      } else if (e.key === "Backspace" && !input && tags.length > 0) {
        removeTag(tags[tags.length - 1]);
      } else if (e.key === "Escape") {
        setShowSuggestions(false);
      }
    };

    return (
      <div className="tag-input-container">
        {tags.map((tag) => (
          <span key={tag} className="tag-badge">
            {tag}
            <button onClick={() => removeTag(tag)} aria-label={`Remove ${tag}`}>
              ×
            </button>
          </span>
        ))}
        <div style={{ position: "relative", flex: 1 }}>
          <input
            ref={inputRef}
            className="tag-input"
            type="text"
            placeholder="Add tag..."
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setShowSuggestions(e.target.value.length > 0);
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
            onFocus={() => input && setShowSuggestions(true)}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
          />
          {showSuggestions && suggestions.length > 0 && (
            <div className="tag-suggestions">
              {suggestions.map((tag, i) => (
                <button
                  key={tag}
                  className={`tag-suggestion-item ${i === activeIndex ? "active" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    addTag(tag);
                  }}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  },
);
