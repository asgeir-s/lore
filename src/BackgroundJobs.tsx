import type { NoteMetadata, RecordingState } from "./api";

export interface BgJob {
  label: string;
  noteId?: string;
  isError?: boolean;
}

interface Props {
  jobs: Map<string, BgJob>;
  recording: RecordingState;
  processingProgressByNote: Record<string, string>;
  recentNotes: NoteMetadata[];
  error: string | null;
}

export function BackgroundJobsIndicator({
  jobs,
  recording,
  processingProgressByNote,
  recentNotes,
  error,
}: Props) {
  const findTitle = (id: string) => recentNotes.find((n) => n.id === id)?.title;

  const entries: Array<{
    key: string;
    label: string;
    noteTitle?: string;
    isError?: boolean;
  }> = [];

  for (const [key, job] of jobs) {
    entries.push({
      key,
      label: job.label,
      noteTitle: job.noteId ? findTitle(job.noteId) : undefined,
      isError: job.isError,
    });
  }

  if (recording.active && recording.note_id) {
    entries.push({
      key: "recording-active",
      label: "Recording",
      noteTitle: findTitle(recording.note_id),
    });
  }

  for (const [noteId, progress] of Object.entries(processingProgressByNote)) {
    entries.push({
      key: `proc-${noteId}`,
      label: progress.replace(/\.+$/, ""),
      noteTitle: findTitle(noteId),
    });
  }

  if (error) {
    entries.push({ key: "error", label: error, isError: true });
  }

  if (entries.length === 0) return null;

  const hasActive = entries.some((e) => !e.isError);
  const hasError = entries.some((e) => e.isError);

  return (
    <div className="bg-jobs-indicator">
      <button className="bg-jobs-btn" aria-label="Background tasks">
        {hasActive && <span className="bg-jobs-spinner" />}
        {hasError && <span className="bg-jobs-error-dot">!</span>}
      </button>
      <div className="bg-jobs-popover">
        {entries.map((entry) => (
          <div
            key={entry.key}
            className={`bg-jobs-entry${entry.isError ? " bg-jobs-entry-error" : ""}`}
          >
            <span className="bg-jobs-entry-label">{entry.label}</span>
            {entry.noteTitle && (
              <span className="bg-jobs-entry-note">{entry.noteTitle}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
