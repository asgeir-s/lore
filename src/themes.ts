import type { Extension } from "@codemirror/state";
import {
  abcdef,
  abyss,
  androidStudio,
  andromeda,
  basicDark,
  basicLight,
  catppuccinMocha,
  cobalt2,
  forest,
  githubDark,
  githubLight,
  gruvboxDark,
  gruvboxLight,
  highContrastDark,
  highContrastLight,
  materialDark,
  materialLight,
  monokai,
  nord,
  palenight,
  solarizedDark,
  solarizedLight,
  synthwave84,
  tokyoNightDay,
  tokyoNightStorm,
  volcano,
  vsCodeDark,
  vsCodeLight,
} from "@fsegurai/codemirror-theme-bundle";

interface ThemeVars {
  bg: string;
  text: string;
  textMuted: string;
  border: string;
  surface: string;
  accent: string;
}

export interface ThemeEntry {
  label: string;
  group: "light" | "dark" | "specialty";
  extension: Extension;
  vars: ThemeVars;
}

export const themes: Record<string, ThemeEntry> = {
  // Light themes
  basicLight: {
    label: "Basic Light",
    group: "light",
    extension: basicLight,
    vars: { bg: "#ffffff", text: "#2e3440", textMuted: "#8a919c", border: "#dde1e6", surface: "#f2f4f8", accent: "#4078f2" },
  },
  githubLight: {
    label: "GitHub Light",
    group: "light",
    extension: githubLight,
    vars: { bg: "#ffffff", text: "#24292e", textMuted: "#6a737d", border: "#e1e4e8", surface: "#f6f8fa", accent: "#0366d6" },
  },
  gruvboxLight: {
    label: "Gruvbox Light",
    group: "light",
    extension: gruvboxLight,
    vars: { bg: "#fbf1c7", text: "#3c3836", textMuted: "#7c6f64", border: "#d5c4a1", surface: "#ebdbb2", accent: "#af3a03" },
  },
  highContrastLight: {
    label: "High Contrast Light",
    group: "light",
    extension: highContrastLight,
    vars: { bg: "#ffffff", text: "#000000", textMuted: "#555555", border: "#cccccc", surface: "#f0f0f0", accent: "#0000cc" },
  },
  materialLight: {
    label: "Material Light",
    group: "light",
    extension: materialLight,
    vars: { bg: "#fafafa", text: "#90a4ae", textMuted: "#b0bec5", border: "#e0e0e0", surface: "#f5f5f5", accent: "#6182b8" },
  },
  solarizedLight: {
    label: "Solarized Light",
    group: "light",
    extension: solarizedLight,
    vars: { bg: "#fdf6e3", text: "#657b83", textMuted: "#93a1a1", border: "#eee8d5", surface: "#eee8d5", accent: "#268bd2" },
  },
  tokyoNightDay: {
    label: "Tokyo Night Day",
    group: "light",
    extension: tokyoNightDay,
    vars: { bg: "#e1e2e7", text: "#3760bf", textMuted: "#8990b3", border: "#c4c8da", surface: "#d0d5e3", accent: "#2e7de9" },
  },
  vsCodeLight: {
    label: "VS Code Light",
    group: "light",
    extension: vsCodeLight,
    vars: { bg: "#ffffff", text: "#333333", textMuted: "#858585", border: "#e0e0e0", surface: "#f3f3f3", accent: "#007acc" },
  },

  // Dark themes
  basicDark: {
    label: "Basic Dark",
    group: "dark",
    extension: basicDark,
    vars: { bg: "#2b2b2b", text: "#e0e0e0", textMuted: "#808080", border: "#3c3c3c", surface: "#353535", accent: "#6cb6ff" },
  },
  githubDark: {
    label: "GitHub Dark",
    group: "dark",
    extension: githubDark,
    vars: { bg: "#0d1117", text: "#c9d1d9", textMuted: "#8b949e", border: "#30363d", surface: "#161b22", accent: "#58a6ff" },
  },
  gruvboxDark: {
    label: "Gruvbox Dark",
    group: "dark",
    extension: gruvboxDark,
    vars: { bg: "#282828", text: "#ebdbb2", textMuted: "#928374", border: "#3c3836", surface: "#3c3836", accent: "#d79921" },
  },
  highContrastDark: {
    label: "High Contrast Dark",
    group: "dark",
    extension: highContrastDark,
    vars: { bg: "#000000", text: "#ffffff", textMuted: "#aaaaaa", border: "#444444", surface: "#1a1a1a", accent: "#6699ff" },
  },
  materialDark: {
    label: "Material Dark",
    group: "dark",
    extension: materialDark,
    vars: { bg: "#263238", text: "#eeffff", textMuted: "#546e7a", border: "#37474f", surface: "#2c3940", accent: "#82aaff" },
  },
  nord: {
    label: "Nord",
    group: "dark",
    extension: nord,
    vars: { bg: "#2e3440", text: "#d8dee9", textMuted: "#4c566a", border: "#3b4252", surface: "#3b4252", accent: "#88c0d0" },
  },
  solarizedDark: {
    label: "Solarized Dark",
    group: "dark",
    extension: solarizedDark,
    vars: { bg: "#002b36", text: "#839496", textMuted: "#586e75", border: "#073642", surface: "#073642", accent: "#268bd2" },
  },
  vsCodeDark: {
    label: "VS Code Dark",
    group: "dark",
    extension: vsCodeDark,
    vars: { bg: "#1e1e1e", text: "#d4d4d4", textMuted: "#808080", border: "#333333", surface: "#252526", accent: "#569cd6" },
  },

  // Specialty themes
  abcdef: {
    label: "ABCDEF",
    group: "specialty",
    extension: abcdef,
    vars: { bg: "#0f0f23", text: "#defdef", textMuted: "#7a8a7a", border: "#1a2a1a", surface: "#18261e", accent: "#fedcba" },
  },
  abyss: {
    label: "Abyss",
    group: "specialty",
    extension: abyss,
    vars: { bg: "#000c18", text: "#6688cc", textMuted: "#384887", border: "#11264f", surface: "#082050", accent: "#ffd500" },
  },
  androidStudio: {
    label: "Android Studio",
    group: "specialty",
    extension: androidStudio,
    vars: { bg: "#282b2e", text: "#a9b7c6", textMuted: "#808080", border: "#393b40", surface: "#313335", accent: "#cc7832" },
  },
  andromeda: {
    label: "Andromeda",
    group: "specialty",
    extension: andromeda,
    vars: { bg: "#23262e", text: "#d5ced9", textMuted: "#7e7a86", border: "#2b303b", surface: "#292d38", accent: "#00e8c6" },
  },
  catppuccinMocha: {
    label: "Catppuccin Mocha",
    group: "specialty",
    extension: catppuccinMocha,
    vars: { bg: "#1e1e2e", text: "#cdd6f4", textMuted: "#6c7086", border: "#313244", surface: "#313244", accent: "#89b4fa" },
  },
  cobalt2: {
    label: "Cobalt2",
    group: "specialty",
    extension: cobalt2,
    vars: { bg: "#193549", text: "#e1efff", textMuted: "#607080", border: "#1f4662", surface: "#1f4662", accent: "#ffc600" },
  },
  forest: {
    label: "Forest",
    group: "specialty",
    extension: forest,
    vars: { bg: "#1b2a1b", text: "#d1e7c9", textMuted: "#6b8a5e", border: "#2a3d2a", surface: "#243524", accent: "#7cc36e" },
  },
  monokai: {
    label: "Monokai",
    group: "specialty",
    extension: monokai,
    vars: { bg: "#272822", text: "#f8f8f2", textMuted: "#75715e", border: "#3e3d32", surface: "#3e3d32", accent: "#a6e22e" },
  },
  palenight: {
    label: "Palenight",
    group: "specialty",
    extension: palenight,
    vars: { bg: "#292d3e", text: "#a6accd", textMuted: "#676e95", border: "#3c435c", surface: "#343b51", accent: "#82aaff" },
  },
  synthwave84: {
    label: "Synthwave '84",
    group: "specialty",
    extension: synthwave84,
    vars: { bg: "#262335", text: "#f0e3ff", textMuted: "#848bbd", border: "#34294f", surface: "#2e2346", accent: "#ff7edb" },
  },
  tokyoNightStorm: {
    label: "Tokyo Night Storm",
    group: "specialty",
    extension: tokyoNightStorm,
    vars: { bg: "#24283b", text: "#a9b1d6", textMuted: "#565f89", border: "#3b4261", surface: "#1f2335", accent: "#7aa2f7" },
  },
  volcano: {
    label: "Volcano",
    group: "specialty",
    extension: volcano,
    vars: { bg: "#1b1015", text: "#e8c4b8", textMuted: "#8a6558", border: "#2d1a1f", surface: "#261419", accent: "#f5734d" },
  },
};

const STORAGE_KEY = "note-theme";

export function loadSavedTheme(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || "default";
  } catch {
    return "default";
  }
}

export function saveTheme(themeId: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, themeId);
  } catch {
    // Ignore storage errors
  }
}

export function applyThemeVars(themeId: string): void {
  const el = document.documentElement;
  if (themeId === "default" || !themes[themeId]) {
    // Remove inline overrides so :root / @media rules take effect
    el.style.removeProperty("--bg");
    el.style.removeProperty("--text");
    el.style.removeProperty("--text-muted");
    el.style.removeProperty("--border");
    el.style.removeProperty("--surface");
    el.style.removeProperty("--accent");
    return;
  }
  const { vars } = themes[themeId];
  el.style.setProperty("--bg", vars.bg);
  el.style.setProperty("--text", vars.text);
  el.style.setProperty("--text-muted", vars.textMuted);
  el.style.setProperty("--border", vars.border);
  el.style.setProperty("--surface", vars.surface);
  el.style.setProperty("--accent", vars.accent);
}
