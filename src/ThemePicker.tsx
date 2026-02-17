import { useState, useEffect, useRef } from "react";
import { themes } from "./themes";

interface ThemePickerProps {
  themeId: string;
  onThemeChange: (themeId: string) => void;
}

const groups = [
  { key: "default", label: "Default" },
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
  { key: "specialty", label: "Specialty" },
] as const;

export function ThemePicker({ themeId, onThemeChange }: ThemePickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const themeEntries = Object.entries(themes);

  return (
    <div className="theme-picker" ref={ref}>
      <button
        className="theme-picker-btn"
        onClick={() => setOpen((o) => !o)}
        title="Change theme"
      >
        {themeId === "default" ? "Theme" : themes[themeId]?.label ?? themeId}
      </button>
      {open && (
        <div className="theme-dropdown">
          {groups.map((group) => {
            const items =
              group.key === "default"
                ? [["default", null] as const]
                : themeEntries.filter(([, t]) => t.group === group.key);
            if (items.length === 0) return null;
            return (
              <div key={group.key} className="theme-group">
                <div className="theme-group-label">{group.label}</div>
                {items.map(([id, entry]) => (
                  <button
                    key={id}
                    className={`theme-item ${themeId === id ? "active" : ""}`}
                    onClick={() => {
                      onThemeChange(id);
                      setOpen(false);
                    }}
                  >
                    {entry ? entry.label : "System Default"}
                    {themeId === id && <span className="theme-check">✓</span>}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
