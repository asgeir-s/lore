# Dump

A zero-friction personal note capture app. No folders. No organization overhead. Just write.

## Philosophy

Capture first, organize never. Notes live as flat markdown files. Structure emerges from tags, links and full-text search.

## Tech Stack

- **Runtime:** Tauri v2 (Rust backend, web frontend)
- **Frontend:** React 19
- **Editor:** CodeMirror 6 with markdown WYSIWYG rendering
- **Search:** qmd (child process) with fallback text search
- **Language:** TypeScript (strict mode)

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- [Node.js](https://nodejs.org/) >= 20
- [Git](https://git-scm.com/) (for automatic note version history)
- System dependencies for Tauri v2 (see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/))

### Ubuntu setup (first time only)

Install Linux system packages required by Tauri:

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

Notes are stored as flat files in `~/dump/` (configurable).

## Keyboard Shortcuts

| Shortcut    | Action                          |
| ----------- | ------------------------------- |
| `Cmd/Ctrl+Enter` | Save note                  |
| `Escape`    | Clear textarea, discard content |
| `Cmd/Ctrl+T` | Toggle tag input               |
| `Cmd/Ctrl+Click` | Open note in new panel      |
| `Cmd/Ctrl+/` | Show shortcut list             |

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
