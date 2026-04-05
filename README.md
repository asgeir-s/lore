# Dump

A zero-friction personal note capture app. Keep notes lightweight, searchable, and easy to revisit.

## Philosophy

Capture first, organize lightly. Most documents are notes; a small set can be promoted into pinned notes. Structure emerges from tags, links, full-text search, and a minimal `notes/` vs `pinned/` split.

## Tech Stack

- **Runtime:** Tauri v2 (Rust backend, web frontend)
- **Frontend:** React 19
- **Editor:** CodeMirror 6 with markdown WYSIWYG rendering
- **Search:** qmd (child process) with fallback text search
- **Language:** TypeScript (strict mode)

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- [Node.js](https://nodejs.org/) >= 22
- [Git](https://git-scm.com/) (for automatic note version history)
- System dependencies for Tauri v2 (see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/))

### macOS setup (recommended)

Install runtime tools for installed app features:

```bash
npm run setup-macos
```

This installs Homebrew Node.js, qmd, ffmpeg, whisper-cpp, ollama, and downloads a whisper model.

### Ubuntu setup (recommended)

Install Linux system/runtime packages for Tauri + app features:

```bash
npm run setup-ubuntu
```

### Install dependencies

```bash
npm install
```

### Development

```bash
cargo tauri dev
```

### Build and install

Build and install for your current OS:

```bash
npm run install-app
```

Explicit commands:

```bash
npm run install-app:macos
npm run install-app:ubuntu
```

Your settings (theme, zoom, git remote) are preserved between builds.

To update after making changes, just run the two commands above again.

## Settings

Open Settings to manage **Storage & Sync**:

- Notes folder on disk (editable)
- Git remote URL (editable)

Use **Save** (or press `Enter`) after editing either field.

## Pending Processing (QMD)

Dump can defer some note processing so edits are never blocked by background indexing/tagging.

- Note saves are written immediately.
- QMD work (auto-tags + related notes refresh) can be queued as **pending**.
- Pending QMD work is persisted in `.dump-qmd-pending.json` inside your notes root.
- On next app start, pending items are resumed automatically.

What this means in practice:

- A note may appear saved before its related notes/tags are fully refreshed.
- You may briefly see **Getting tags & related notes** in the background jobs indicator.
- If QMD is unavailable, note saving still works; only QMD-derived features are delayed/unavailable until QMD is back.

Related runtime files in the notes root:

- `.dump-index.json`: metadata index cache
- `.dump-related.json`: related-notes cache
- `.dump-qmd-pending.json`: deferred QMD processing queue

## Document Format

Every note is a markdown file with YAML frontmatter:

```markdown
---
id: a1b2c3d4-5678-90ab-cdef-1234567890ab
created: 2026-02-16T14:32:00+01:00
tags: [strategy, fundraising]
---

# My note title

Content goes here. Link to [[note:e5f6a7b8-1234-5678-90ab-cdef12345678]] another note.
```

Dump stores documents under a configurable root:

```text
~/dump/
  notes/
  pinned/
```

## Pinning Notes

Pinning promotes a note from the regular collection into the pinned collection.

- Use the pin button in the note header, or press `Cmd/Ctrl+Shift+P`.
- Pinned notes are moved from `notes/` to `pinned/` on disk.
- Unpinning moves the same note back to `notes/`.
- The note ID and content stay the same; only the collection path changes.

Why this exists:

- `notes/` is for ongoing capture and quick iteration.
- `pinned/` is for durable reference notes (principles, decisions, checklists, core docs).
- The app keeps pinned and recent lists separate so high-signal notes are easy to find.

## Keyboard Shortcuts

| Shortcut         | Action                          |
| ---------------- | ------------------------------- |
| `Cmd/Ctrl+Enter` | Save note                       |
| `Escape`         | Clear textarea, discard content |
| `Cmd/Ctrl+T`     | Toggle tag input                |
| `Cmd/Ctrl+Shift+P` | Toggle pin state             |
| `Cmd/Ctrl+Click` | Open note in new panel          |
| `Cmd/Ctrl+Shift+R` | Toggle meeting recording      |
| `Ctrl+Cmd++`     | Show shortcut list              |

## Meeting Recording

Record meetings directly in the app, then get an auto-generated note with a summary and full transcript.

1. Press `Cmd+Shift+R` (or click Record) to start
2. Press again to stop — the app processes the audio automatically:
   - **ffmpeg** mixes system + mic audio into a single WAV
   - **whisper-cpp** transcribes the audio with timestamps
   - **ollama** summarizes the transcript into key points
3. A meeting note appears with a Summary/Transcript toggle view

Meeting notes live in `notes/meetings/`. Audio files are in `notes/meetings/.audio/` (git-ignored).

**Required:** `ffmpeg`, `whisper-cpp` (install via setup script)
**Optional:** `ollama` with a model (for AI summaries — without it you still get the transcript)

## Slash Commands

Type `/` to open the command palette:

| Command    | Inserts                 |
| ---------- | ----------------------- |
| `/h1`      | `# ` (Heading 1)        |
| `/h2`      | `## ` (Heading 2)       |
| `/h3`      | `### ` (Heading 3)      |
| `/quote`   | `> ` (Blockquote)       |
| `/list`    | `- ` (Bullet list)      |
| `/ol`      | `1. ` (Numbered list)   |
| `/code`    | Code block              |
| `/link`    | Link template           |
| `/note`    | `[[note:]]` link        |
| `/divider` | `---` (Horizontal rule) |

## Themes

Light and dark themes sync automatically with OS preference via `prefers-color-scheme`.

## License

MIT
