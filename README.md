# Lore

A zero-friction personal knowledge base and note capture app. Keep notes lightweight, searchable, and easy to revisit.

## Philosophy

Capture first, organize lightly. Most documents are notes; a small set can be promoted into pinned notes. Structure emerges from tags, links, full-text search, and pinning. Automatic organization keeps the knowledge base usable without manual upkeep. The app is designed to be a trusted source of truth for both users and AI agents, with user-authored content and read-first AI access.

## Features

- Capture notes quickly with a clean, distraction-light writing flow.
- Keep everyday notes and long-term reference notes clearly separated.
- Find what you need fast with search, links, and related-note suggestions.
- Stay organized automatically in the background with minimal manual upkeep.
- Keep your knowledge base as trusted ground truth under your control.
- Make your notes easy for AI agents to read and use when needed.
- Work across multiple side-by-side note panels for better focus.
- Record meetings and get structured summaries and transcripts.
- Automatic sync with reliable history and backup.
- Personalize your workspace with themes.
- Running locally on your machine for maximum privacy and control.

## Personal KB + AI Access Model

Lore is designed to be low-maintenance for humans and easy to consume for AI:

- You write notes directly as markdown.
- The app keeps organization lightweight with `notes/` and `pinned/` collections.
- QMD background work automatically tags notes and refreshes related-note metadata to keep the knowledge base organized with minimal upkeep.

AI access is intentionally read-first:

- AI agents can search and retrieve knowledge via QMD.
- This repo includes a QMD access skill in `SKILL.md` for consistent agent behavior.
- Source notes are treated as ground truth, so AI should not silently auto-edit them.
- New or changed knowledge should be user-authored, or at minimum explicitly reviewed and validated by the user.

## Getting Started

### For Users

If you just want to install and use Lore:

```bash
npm run install-app
```

`install-app` automatically detects your OS (macOS/Linux) and runs the correct installer.

If you also want recording + AI helper features, run the one-time setup for your OS, then install:

```bash
npm run setup-macos
# or
npm run setup-ubuntu
npm run install-app
```

### For Developers

Use this path if you want to work on the codebase.

Prerequisites:

- [Rust](https://rustup.rs/) (latest stable)
- [Node.js](https://nodejs.org/) >= 22
- [Git](https://git-scm.com/) (for automatic note version history)
- System dependencies for Tauri v2 (see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/))

Install dependencies:

```bash
npm install
```

Run in development:

```bash
cargo tauri dev
```

Build/install local app bundle:

```bash
npm run install-app
```

Your settings (theme, zoom, git remote) are preserved between installs/updates.

Each macOS install automatically gets a new build number (`CFBundleVersion`), even when reinstalling the same release. The installer checks that release versions agree across npm, Rust, and Tauri before building. Build counters stay in the ignored `src-tauri/target/` directory and also take the currently installed build number into account. Release versions such as `0.1.1` are updated deliberately; see [AGENTS.md](AGENTS.md) for the release and installation rules.

On macOS, builds sign the complete app bundle and the installer verifies the signature before replacing the installed app. Local builds use ad-hoc signing by default. For permissions to persist across rebuilt versions, install an Apple signing certificate and set `APPLE_SIGNING_IDENTITY` to its identity when building (see [Tauri's signing guide](https://v2.tauri.app/distribute/sign/macos/)). Changing the version number alone does not preserve privacy permissions; [macOS uses the signing identity](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements).

Meeting recording needs access in System Settings → Privacy & Security → **Microphone**, and in **Screen & System Audio Recording → System Audio Recording Only**. Core Audio requests system audio access when recording starts; Lore does not request screen capture permission. After updating an ad-hoc build, you may need to re-enable access for `/Applications/Lore.app` and quit and reopen it.

Lore checks recording permissions when it opens and when you return to its window. A notice shows microphone and system audio status, with **Allow access**, **Open Settings**, and **Check again** actions. The check does not open an audio stream or save audio. Known missing access stops recording before a job or timer starts. The notice can be dismissed once both permissions are allowed; if access is later revoked, it returns. This checks permissions, not microphone hardware, device routing, or audio levels.

Microphone checks use AVFoundation. System audio has no public preflight API, so the macOS bridge resolves TCC's status/request functions at runtime, following the approach used by [AudioCap](https://github.com/insidegui/AudioCap/blob/main/AudioCap/ProcessTap/AudioRecordingPermission.swift). If those functions are unavailable, Lore shows **Couldn’t verify access** and offers System Settings instead of claiming recording is ready. It never substitutes screen-recording permission or reads the TCC database.

## Tech Stack

- **Runtime:** Tauri v2 (Rust backend, web frontend)
- **Frontend:** React 19
- **Editor:** CodeMirror 6 with markdown WYSIWYG rendering
- **Search:** qmd (child process) with fallback text search
- **Language:** TypeScript (strict mode)

## Settings

Open Settings to manage **Storage & Sync**:

- Notes folder on disk (editable)
- Git remote URL (editable)

Use **Save** (or press `Enter`) after editing either field.

## Pending Processing (QMD)

Lore can defer some note processing so edits are never blocked by background indexing/tagging.

- Note saves are written immediately.
- QMD work (auto-tags + related notes refresh) can be queued as **pending**.
- Pending QMD work is persisted in `.lore-qmd-pending.json` inside your notes root.
- On next app start, pending items are resumed automatically.

What this means in practice:

- A note may appear saved before its related notes/tags are fully refreshed.
- You may briefly see **Getting tags & related notes** in the background jobs indicator.
- If QMD is unavailable, note saving still works; only QMD-derived features are delayed/unavailable until QMD is back.

Related runtime files in the notes root:

- `.lore-index.json`: metadata index cache
- `.lore-related.json`: related-notes cache
- `.lore-qmd-pending.json`: deferred QMD processing queue

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

Lore stores documents under a configurable root:

```text
~/lore/
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

Record meetings directly in the app, then get an auto-generated note with a summary and linked transcript.

1. Press `Cmd+Shift+R` (or click Record) to start
2. Press again to stop — the app processes the audio automatically:
   - **ffmpeg** mixes system + mic audio into a single WAV
   - **whisper-cpp** transcribes the audio with timestamps
   - **ollama** summarizes the transcript into key points
3. A meeting note appears with a Summary/Transcript toggle view

Meeting notes are regular notes in `notes/`. Audio files are stored in `.recordings/audio/` (git-ignored). Raw transcripts are stored as sidecar files in `transcripts/` and linked from meeting-note frontmatter so QMD indexes the notes and summaries without indexing full transcripts.

You can also drag audio files, including `.m4a` recordings from Apple Voice Memos, directly into Lore. Drop audio on the Meetings target for the Summary/Transcript workflow, or on the Notes target for a plain transcription without timestamps. Before import starts, you can add a title and tags or skip that step to keep the automatic title/tags.

### Language and Norwegian models

Settings → Recording language supports **Auto-detect** (the default), **Norwegian**, and **English**. The choice applies to recordings, audio imports, and retranscription; pending jobs retain their original language and model. Auto-detect runs language detection independently for each section, so mixed-language recordings can change language between sections.

For Norwegian, [NB-Whisper Large by the National Library of Norway](https://huggingface.co/NbAiLab/nb-whisper-large) is available as an optional local model. Download the pinned, checksum-verified weights, then refresh the model list in Settings:

```bash
bash scripts/download-nb-whisper.sh          # full precision, about 3.1 GB
bash scripts/download-nb-whisper.sh q5_0     # optional quantized version, about 1.1 GB
```

**Automatic** uses standard multilingual Whisper for all three language choices. To try NB-Whisper, select **Norwegian** and choose NB-Whisper explicitly. Our meeting-excerpt checks found timestamp and coverage failures with NB-Whisper, so installing it does not change the default. An explicit model choice always takes priority. English-only `.en.bin` models require English. A missing selected model produces an error instead of silently changing models. NB-Whisper is released under Apache-2.0; subtitles generated with it should be attributed to NB-Whisper.

### Recovery and incomplete transcripts

Lore transcribes independent sections of at most one minute, preferring quiet boundaries and retaining two seconds of surrounding audio. Each section resets text context. Timestamped overlap merging keeps recording-relative times and preserves normal repeated speech.

Recognition loops, malformed timestamps, process failures, and detected speech without text trigger retries in sections of at most 30 seconds. Speech detection checks for substantial missing speech at the beginning, middle, and end; it never removes quiet audio from recognition. When installed, Silero runs through `whisper-vad-speech-segments` to avoid treating sustained room noise as missing words. The setup scripts download its small `ggml-silero-v6.2.0.bin` model. If the helper/model is absent or fails, coverage uses WebRTC instead. Detector output and status are saved with each run's diagnostics. Cached sections are revalidated with the current detector before reuse. These checks detect likely omissions, not every wrong or missing word. Unresolved ranges stop completion and summarization, and existing notes/transcripts remain intact. Valid text around coverage gaps is retained in the partial output with the missing ranges marked. A persistent message in the meeting view identifies the failure and offers retry from the Transcript tab. Concurrent transcription attempts for the same audio are rejected; file locks are released automatically on exit.

Audio-adjacent `.transcription/<audio-id>/<configuration>/` directories contain atomic section checkpoints, `partial.md` with incomplete ranges, raw Whisper JSON, stdout/stderr, and per-attempt timing/status metadata. Completed runs also contain `transcript.md`. Successful sections are reused after an interruption or retry; changed audio content, model content, language, engine version, or pipeline version starts a separate cache. Temporary audio slices are removed. Diagnostics stay local alongside the audio and are not automatically expired; they are git-ignored when the audio is in `.recordings/audio/`.

A command-line harness uses the same pipeline without editing a note:

```bash
cargo run --manifest-path src-tauri/Cargo.toml --bin lore-transcribe -- \
  /path/to/recording.wav /path/to/model.bin auto
# The final argument may also be no or en; input must be 16 kHz mono 16-bit PCM WAV.
```

### Comparing models on your recordings

Build `lore-transcribe` with `cargo build --manifest-path src-tauri/Cargo.toml --bin lore-transcribe`. Create a local JSON manifest with representative excerpts:

```json
[
  {"name": "meeting-a", "path": "/path/to/meeting.wav", "start_seconds": 360, "duration_seconds": 120},
  {"name": "meeting-b", "path": "/path/to/other.wav", "start_seconds": 120, "duration_seconds": 90}
]
```

Then run each model on identical excerpts in fresh output directories:

```bash
python3 scripts/benchmark-transcription.py /path/to/manifest.json \
  --model ~/.local/share/whisper-cpp/models/ggml-large-v3.bin \
  --model ~/.local/share/whisper-cpp/models/ggml-nb-whisper-large.bin \
  --language no --output /path/to/new-comparison-directory
```

The script preserves each transcript and diagnostic log and writes `report.json` and `report.csv` with elapsed time, completion checks, retry counts, and word counts. Add an optional `reference` text-file path to each manifest entry to measure word error rate against a human-checked transcript. Without references, accuracy is deliberately not scored. Review names, terminology, and timestamps before choosing a default; passing coverage checks is not proof that every word is correct. Run comparisons without other transcription jobs if comparing speed.

[Checked-in validation results](docs/transcription-validation.json) cover three Norwegian meeting excerpts, English/Auto-detect smoke tests, and the original 6:54 cutoff regression. Large-v3 passed all three Norwegian excerpt checks; NB-Whisper passed two, so it remains an explicit choice rather than the default.

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
