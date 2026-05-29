import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  forwardRef,
  useImperativeHandle,
} from "react";
import { Editor } from "./Editor";
import { MarkdownView } from "./MarkdownView";
import { NotesList } from "./NotesList";
import { TagInput } from "./TagInput";
import type { TagInputHandle } from "./TagInput";
import {
  saveNote,
  getNote,
  deleteNote,
  togglePin as togglePinApi,
  getRelatedNotes,
  regenerateTags,
  retranscribeNote,
  resummarizeNote,
  appendMeetingData as appendMeetingDataApi,
  isPinnedNotePath,
} from "./api";
import type { NoteMetadata, SortBy, RecordingState } from "./api";

export interface PanelHandle {
  loadNote: (noteId: string) => Promise<void>;
  refreshLoadedNote: () => Promise<void>;
  clear: () => void;
  focusEditor: () => void;
  ensureRecordingNote: () => Promise<string>;
  saveIfNeeded: (deferProcessing?: boolean) => Promise<boolean>;
  isUserModified: () => boolean;
  hasUnsavedChanges: () => boolean;
  hasContent: () => boolean;
  getLoadedNoteId: () => string | null;
  canGoBack: () => boolean;
  goBack: () => void;
  save: (force?: boolean) => Promise<void>;
  toggleTags: () => void;
  edit: () => void;
  discardEdits: () => void;
  navigateList: (delta: number) => void;
  openSelectedNote: (metaKey: boolean) => void;
  getHighlightedNoteId: () => string | null;
  togglePin: () => Promise<void>;
  deleteNote: () => Promise<void>;
  appendMeetingData: (summary: string, transcript: string) => Promise<void>;
}

interface NotePanelProps {
  draftStorageKey: string;
  allowGlobalDraftRestore?: boolean;
  recentNotes: NoteMetadata[];
  pinnedNotes: NoteMetadata[];
  allTags: string[];
  onNoteClick: (noteId: string, metaKey: boolean) => void;
  onNoteNavigate?: (noteId: string, metaKey: boolean) => void;
  onSaved: () => Promise<void>;
  onFocus: () => void;
  initialNoteId?: string;
  independent?: boolean;
  sortBy: SortBy;
  onSortChange: (sortBy: SortBy) => void;
  themeId: string;
  vimEnabled: boolean;
  onVimToggle: () => void;
  recording?: RecordingState;
  processingProgress?: string | null;
  processingProgressByNote?: Record<string, string>;
  recordingLocked?: boolean;
  onStartRecording?: () => void;
  onStopRecording?: () => void;
  isRecordingPanel?: boolean;
  onBgJob?: (key: string, label: string | null, noteId?: string) => void;
}

interface NoteViewTab {
  id: string;
  label: string;
  normalizedLabel: string;
  content: string;
}

function normalizeTabLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

function tabIdFromLabel(label: string, used: Set<string>): string {
  const normalized = normalizeTabLabel(label);
  const base =
    normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
    "section";
  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(id);
  return id;
}

function fenceMarker(line: string): string | null {
  const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
  return match?.[1] ?? null;
}

function parseTopLevelHeadingTabs(content: string): NoteViewTab[] {
  const lines = content.split("\n");
  const headings: Array<{ lineIndex: number; label: string }> = [];
  let activeFence: { char: string; length: number } | null = null;

  lines.forEach((line, lineIndex) => {
    const marker = fenceMarker(line);
    if (activeFence) {
      if (
        marker &&
        marker[0] === activeFence.char &&
        marker.length >= activeFence.length
      ) {
        activeFence = null;
      }
      return;
    }

    if (marker) {
      activeFence = {
        char: marker[0],
        length: marker.length,
      };
      return;
    }

    const headingMatch = line.match(/^[ \t]{0,3}#[ \t]+(.+)$/);
    if (!headingMatch) return;
    const label = headingMatch[1].replace(/[ \t]+#+[ \t]*$/, "").trim();
    if (label) {
      headings.push({ lineIndex, label });
    }
  });

  if (headings.length === 0) return [];

  const usedIds = new Set<string>();
  const tabs: NoteViewTab[] = [];
  const leadingContent = lines.slice(0, headings[0].lineIndex).join("\n").trim();
  if (leadingContent.length > 0) {
    usedIds.add("notes");
    tabs.push({
      id: "notes",
      label: "Notes",
      normalizedLabel: "notes",
      content: leadingContent,
    });
  }

  headings.forEach((heading, index) => {
    const nextHeading = headings[index + 1];
    const contentStart = heading.lineIndex + 1;
    const contentEnd = nextHeading?.lineIndex ?? lines.length;
    tabs.push({
      id: tabIdFromLabel(heading.label, usedIds),
      label: heading.label,
      normalizedLabel: normalizeTabLabel(heading.label),
      content: lines.slice(contentStart, contentEnd).join("\n").trim(),
    });
  });

  return tabs;
}

interface LocalDraft {
  version: 1;
  sourceKey: string;
  noteId: string | null;
  title: string;
  content: string;
  tags: string[];
  updatedAt: number;
}

const DRAFT_STORAGE_PREFIX = "lore-draft-v1:";
const DRAFT_LATEST_KEY = "lore-draft-latest-v1";
const DRAFT_AUTOSAVE_DELAY_MS = 350;
const DRAFT_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 14;

function readDraft(key: string): LocalDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LocalDraft> | null;
    if (!parsed || parsed.version !== 1) return null;
    if (typeof parsed.sourceKey !== "string") return null;
    if (parsed.noteId !== null && typeof parsed.noteId !== "string")
      return null;
    if (typeof parsed.title !== "string") return null;
    if (typeof parsed.content !== "string") return null;
    if (!Array.isArray(parsed.tags)) return null;
    if (
      typeof parsed.updatedAt !== "number" ||
      !Number.isFinite(parsed.updatedAt)
    ) {
      return null;
    }
    const tags = parsed.tags.filter((t): t is string => typeof t === "string");
    return {
      version: 1,
      sourceKey: parsed.sourceKey,
      noteId: parsed.noteId,
      title: parsed.title,
      content: parsed.content,
      tags,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

function writeDraft(key: string, draft: LocalDraft): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Ignore storage quota/availability errors.
  }
}

function removeDraft(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage errors.
  }
}

function removeDraftForSource(sourceKey: string): void {
  removeDraft(`${DRAFT_STORAGE_PREFIX}${sourceKey}`);
  const latest = readDraft(DRAFT_LATEST_KEY);
  if (latest?.sourceKey === sourceKey) {
    removeDraft(DRAFT_LATEST_KEY);
  }
}

function isDraftMeaningful(
  draft: Pick<LocalDraft, "title" | "content" | "tags">,
): boolean {
  return (
    draft.content.trim().length > 0 ||
    draft.title.trim().length > 0 ||
    draft.tags.length > 0
  );
}

function isDraftFresh(draft: LocalDraft): boolean {
  return Date.now() - draft.updatedAt <= DRAFT_MAX_AGE_MS;
}

function draftMatchesSavedNote(
  draft: LocalDraft,
  note: Pick<NoteMetadata, "title" | "tags"> & { content: string },
): boolean {
  return (
    draft.content === note.content &&
    draft.title === note.title &&
    JSON.stringify(draft.tags) === JSON.stringify(note.tags)
  );
}

export const NotePanel = forwardRef<PanelHandle, NotePanelProps>(
  (
    {
      draftStorageKey,
      allowGlobalDraftRestore = false,
      recentNotes,
      pinnedNotes,
      allTags,
      onNoteClick,
      onNoteNavigate,
      onSaved,
      onFocus,
      initialNoteId,
      independent,
      sortBy,
      onSortChange,
      themeId,
      vimEnabled,
      onVimToggle,
      recording,
      processingProgress,
      processingProgressByNote,
      recordingLocked,
      onStartRecording,
      onStopRecording,
      isRecordingPanel,
      onBgJob,
    },
    ref,
  ) => {
    const [content, setContent] = useState("");
    const [meetingTranscript, setMeetingTranscript] = useState<string | null>(
      null,
    );
    const [meetingHasAudio, setMeetingHasAudio] = useState(false);
    const [title, setTitle] = useState("");
    const [loadedNoteId, setLoadedNoteId] = useState<string | null>(null);
    const [tags, setTags] = useState<string[]>([]);
    const [showTagInput, setShowTagInput] = useState(false);
    const [precomputedRelated, setPrecomputedRelated] = useState<
      NoteMetadata[]
    >([]);
    const [regeneratingTags, setRegeneratingTags] = useState(false);
    const [retranscribingNote, setRetranscribingNote] = useState(false);
    const [resummarizingNote, setResummarizingNote] = useState(false);
    const [relatedLoading, setRelatedLoading] = useState(false);
    const [selectedTabId, setSelectedTabId] = useState("notes");
    const [userModified, setUserModified] = useState(independent ?? false);
    const [highlightIndex, setHighlightIndex] = useState(-1);
    const [pinned, setPinned] = useState(false);
    const [showPinnedList, setShowPinnedList] = useState(false);
    const editorRef = useRef<{
      focus: () => void;
      blur: () => void;
      clear: () => void;
    } | null>(null);
    const contentRef = useRef("");
    const titleRef = useRef("");
    const tagsRef = useRef<string[]>([]);
    const tagInputRef = useRef<TagInputHandle>(null);
    const initialLoadDone = useRef(false);
    const historyRef = useRef<(string | null)[]>([]);
    const loadedNoteIdRef = useRef<string | null>(null);
    const savedContentRef = useRef("");
    const savedTitleRef = useRef("");
    const savedTagsRef = useRef<string[]>([]);
    const titleManuallyEditedRef = useRef(false);
    const autoTagAttemptedRef = useRef<Set<string>>(new Set());
    const draftRestoreCheckedRef = useRef(false);

    const panelDraftKey = `${DRAFT_STORAGE_PREFIX}${draftStorageKey}`;

    const editing = userModified || !loadedNoteId;
    const isTyping = editing && content.trim().length > 0;
    const effectiveProcessingProgress =
      processingProgress ??
      (loadedNoteId
        ? (processingProgressByNote?.[loadedNoteId] ?? null)
        : null);

    useEffect(() => {
      contentRef.current = content;
    }, [content]);

    useEffect(() => {
      titleRef.current = title;
    }, [title]);

    useEffect(() => {
      tagsRef.current = tags;
    }, [tags]);

    const resolveCurrentTags = useCallback((flushPending: boolean) => {
      let nextTags = tagsRef.current;
      if (flushPending) {
        const pendingTag = tagInputRef.current?.flush();
        if (pendingTag && !nextTags.includes(pendingTag)) {
          nextTags = [...nextTags, pendingTag];
          tagsRef.current = nextTags;
          setTags(nextTags);
        }
      }
      return nextTags;
    }, []);

    const hasUnsavedChanges = useCallback(
      (flushPendingTags: boolean) => {
        const currentTags = resolveCurrentTags(flushPendingTags);
        const currentContent = contentRef.current;
        const currentTitle = titleRef.current;

        if (!loadedNoteIdRef.current) {
          return (
            currentContent.trim().length > 0 ||
            currentTitle.trim().length > 0 ||
            currentTags.length > 0
          );
        }

        return (
          currentContent !== savedContentRef.current ||
          currentTitle !== savedTitleRef.current ||
          JSON.stringify(currentTags) !== JSON.stringify(savedTagsRef.current)
        );
      },
      [resolveCurrentTags],
    );

    const clearLocalDraft = useCallback(() => {
      removeDraftForSource(draftStorageKey);
    }, [draftStorageKey]);

    const persistLocalDraft = useCallback(() => {
      const draft: LocalDraft = {
        version: 1,
        sourceKey: draftStorageKey,
        noteId: loadedNoteIdRef.current,
        title: titleRef.current,
        content: contentRef.current,
        tags: tagsRef.current,
        updatedAt: Date.now(),
      };
      writeDraft(panelDraftKey, draft);
      writeDraft(DRAFT_LATEST_KEY, draft);
    }, [draftStorageKey, panelDraftKey]);

    const isAutoMeetingTitle = useCallback((value: string) => {
      return value === "Meeting about" || value.startsWith("Meeting about ");
    }, []);

    const loadNoteInternal = useCallback(
      async (noteId: string, pushHistory: boolean) => {
        try {
          if (pushHistory) {
            historyRef.current.push(loadedNoteIdRef.current);
          }
          if (noteId !== loadedNoteIdRef.current) {
            setPrecomputedRelated([]);
          }
          const note = await getNote(noteId);
          setContent(note.content);
          setMeetingTranscript(note.transcript ?? null);
          setMeetingHasAudio(note.has_audio ?? false);
          contentRef.current = note.content;
          setTitle(note.title);
          titleRef.current = note.title;
          titleManuallyEditedRef.current = false;
          setLoadedNoteId(note.id);
          loadedNoteIdRef.current = note.id;
          setTags(note.tags);
          tagsRef.current = note.tags;
          savedContentRef.current = note.content;
          savedTitleRef.current = note.title;
          savedTagsRef.current = note.tags;
          setPinned(isPinnedNotePath(note.path));
          setShowPinnedList(false);
          setUserModified(false);
        } catch (e) {
          console.error("Failed to load note:", e);
        }
      },
      [],
    );

    const loadNote = useCallback(
      async (noteId: string) => {
        await loadNoteInternal(noteId, true);
      },
      [loadNoteInternal],
    );

    const clearPanel = useCallback(() => {
      clearLocalDraft();
      setContent("");
      setMeetingTranscript(null);
      setMeetingHasAudio(false);
      contentRef.current = "";
      setTitle("");
      titleRef.current = "";
      titleManuallyEditedRef.current = false;
      setLoadedNoteId(null);
      loadedNoteIdRef.current = null;
      setTags([]);
      tagsRef.current = [];
      savedContentRef.current = "";
      savedTitleRef.current = "";
      savedTagsRef.current = [];
      setPinned(false);
      setShowPinnedList(false);
      setPrecomputedRelated([]);
      setShowTagInput(false);
      setUserModified(false);
      historyRef.current = [];
      autoTagAttemptedRef.current.clear();
      editorRef.current?.clear();
    }, [clearLocalDraft]);

    const persistNote = useCallback(
      async ({
        keepEditing = false,
        allowEmpty = false,
        deferProcessing = false,
      }: {
        keepEditing?: boolean;
        allowEmpty?: boolean;
        deferProcessing?: boolean;
      } = {}) => {
        const contentNow = contentRef.current;
        const titleNow = titleRef.current;
        const tagsNow = resolveCurrentTags(true);
        const noteIdNow = loadedNoteIdRef.current;
        const canSave =
          allowEmpty ||
          !!noteIdNow ||
          contentNow.trim().length > 0 ||
          titleNow.trim().length > 0 ||
          tagsNow.length > 0;

        if (!canSave) return null;

        const isNew = !noteIdNow;
        const tagsChanged =
          isNew ||
          JSON.stringify(tagsNow) !== JSON.stringify(savedTagsRef.current);
        const meta = await saveNote(
          noteIdNow,
          contentNow,
          tagsNow,
          titleNow || null,
          {
            deferProcessing,
          },
        );
        setTitle(meta.title);
        titleRef.current = meta.title;
        titleManuallyEditedRef.current = false;
        setLoadedNoteId(meta.id);
        loadedNoteIdRef.current = meta.id;
        tagsRef.current = tagsNow;
        savedContentRef.current = contentNow;
        savedTitleRef.current = meta.title;
        savedTagsRef.current = tagsNow;
        setPinned(isPinnedNotePath(meta.path));
        setUserModified(keepEditing);
        if (tagsChanged) {
          setRelatedLoading(true);
        }
        clearLocalDraft();
        await onSaved();
        return meta;
      },
      [clearLocalDraft, onSaved, resolveCurrentTags],
    );

    const saveIfNeeded = useCallback(
      async (deferProcessing: boolean = false) => {
        if (!hasUnsavedChanges(true)) return false;
        await persistNote({ deferProcessing });
        return true;
      },
      [hasUnsavedChanges, persistNote],
    );

    const handleSave = useCallback(
      async (force: boolean = false) => {
        try {
          let saved = false;
          if (force && loadedNoteIdRef.current) {
            saved = !!(await persistNote({ allowEmpty: true }));
          } else {
            saved = await saveIfNeeded(false);
          }
          if (saved && document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
          }
        } catch (e) {
          console.error("Failed to save note:", e);
        }
      },
      [persistNote, saveIfNeeded],
    );

    const handleTogglePin = useCallback(async () => {
      const noteId = loadedNoteIdRef.current;
      if (!noteId) return;
      try {
        if (hasUnsavedChanges(true)) {
          await persistNote({
            keepEditing: userModified,
            allowEmpty: true,
          });
        }
        const updated = await togglePinApi(noteId);
        setPinned(isPinnedNotePath(updated.path));
        await onSaved();
      } catch (e) {
        console.error("Failed to toggle pin:", e);
      }
    }, [hasUnsavedChanges, onSaved, persistNote, userModified]);

    const displayedNotes = useMemo(() => {
      // Existing note (viewing or editing) — show precomputed related
      if (loadedNoteId) return precomputedRelated;
      // New panel with no note loaded — show recent notes or pinned docs
      if (!isTyping) return showPinnedList ? pinnedNotes : recentNotes;
      // Typing in a new note — show nothing
      return [];
    }, [
      isTyping,
      loadedNoteId,
      precomputedRelated,
      recentNotes,
      pinnedNotes,
      showPinnedList,
    ]);

    useImperativeHandle(
      ref,
      () => ({
        loadNote,
        refreshLoadedNote: async () => {
          const current = loadedNoteIdRef.current;
          if (!current) return;
          if (userModified) {
            // While editing, keep local content intact and merge backend tags/title updates.
            try {
              const note = await getNote(current);
              const merged = [...tagsRef.current];
              let changed = false;
              for (const tag of note.tags) {
                if (!merged.includes(tag)) {
                  merged.push(tag);
                  changed = true;
                }
              }
              if (changed) {
                setTags(merged);
                tagsRef.current = merged;
                savedTagsRef.current = merged;
              }
              setPinned(isPinnedNotePath(note.path));
              if (
                !titleManuallyEditedRef.current &&
                isAutoMeetingTitle(titleRef.current) &&
                isAutoMeetingTitle(note.title) &&
                note.title !== titleRef.current
              ) {
                setTitle(note.title);
                titleRef.current = note.title;
                savedTitleRef.current = note.title;
              }
            } catch (e) {
              console.error("Failed to refresh note tags:", e);
            }
            return;
          }
          await loadNoteInternal(current, false);
        },
        clear: clearPanel,
        focusEditor: () => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => editorRef.current?.focus()),
          );
        },
        ensureRecordingNote: async () => {
          const existing = loadedNoteIdRef.current;
          if (existing) return existing;

          // Recording must be tied to this panel's note, even if it's a new/empty note.
          // Persist once to get a stable note ID, but keep editing mode in this panel.
          const meta = await persistNote({
            keepEditing: true,
            allowEmpty: true,
          });
          if (!meta) {
            throw new Error("Failed to persist note for recording");
          }
          return meta.id;
        },
        saveIfNeeded,
        edit: () => {
          setUserModified(true);
          requestAnimationFrame(() =>
            requestAnimationFrame(() => editorRef.current?.focus()),
          );
        },
        discardEdits: () => {
          clearLocalDraft();
          if (loadedNoteId) {
            // Reload the note, discarding changes
            loadNoteInternal(loadedNoteId, false);
          } else {
            // Was a new note — just clear
            clearPanel();
          }
          if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
          }
        },
        isUserModified: () => userModified,
        hasUnsavedChanges: () => hasUnsavedChanges(true),
        hasContent: () => content.trim().length > 0,
        getLoadedNoteId: () => loadedNoteIdRef.current,
        canGoBack: () => historyRef.current.length > 0,
        goBack: async () => {
          if (historyRef.current.length === 0) return;
          const prevId = historyRef.current.pop()!;
          if (hasUnsavedChanges(true)) {
            try {
              await persistNote();
            } catch (e) {
              console.error("Failed to save note:", e);
            }
          }
          if (prevId === null) {
            clearPanel();
          } else {
            await loadNoteInternal(prevId, false);
          }
          if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
          }
        },
        save: handleSave,
        toggleTags: () => setShowTagInput((prev) => !prev),
        navigateList: (delta: number) => {
          const notes = displayedNotes;
          if (notes.length === 0) return;
          setHighlightIndex((prev) => {
            if (prev === -1) return delta > 0 ? 0 : notes.length - 1;
            const next = prev + delta;
            if (next < 0) return 0;
            if (next >= notes.length) return notes.length - 1;
            return next;
          });
        },
        openSelectedNote: (metaKey: boolean) => {
          const notes = displayedNotes;
          if (highlightIndex >= 0 && highlightIndex < notes.length) {
            onNoteClick(notes[highlightIndex].id, metaKey);
            setHighlightIndex(-1);
          }
        },
        getHighlightedNoteId: () => {
          const notes = displayedNotes;
          if (highlightIndex >= 0 && highlightIndex < notes.length) {
            return notes[highlightIndex].id;
          }
          return null;
        },
        togglePin: handleTogglePin,
        deleteNote: async () => {
          if (!loadedNoteId) return;
          try {
            await deleteNote(loadedNoteId);
            clearPanel();
            await onSaved();
          } catch (e) {
            console.error("Failed to delete note:", e);
          }
        },
        appendMeetingData: async (summary: string, transcript: string) => {
          const noteIdNow = loadedNoteIdRef.current;
          if (!noteIdNow) return;
          const hadLocalEdits = userModified;
          const shouldStayEditing = hadLocalEdits;
          try {
            // If the user edited title/tags/content while processing, persist those edits first.
            // The backend append then merges meeting data on top of the user's latest state.
            if (hadLocalEdits) {
              await saveNote(
                noteIdNow,
                contentRef.current,
                tagsRef.current,
                titleRef.current || null,
              );
            }
            // Delegate to the backend command so it reads from disk (preserving any
            // QMD-generated tags) and generates a proper title.
            const meta = await appendMeetingDataApi(
              noteIdNow,
              summary,
              transcript,
            );
            const note = await getNote(noteIdNow);
            setContent(note.content);
            setMeetingTranscript(note.transcript ?? null);
            setMeetingHasAudio(note.has_audio ?? false);
            contentRef.current = note.content;
            setTitle(meta.title);
            titleRef.current = meta.title;
            titleManuallyEditedRef.current = false;
            setTags(meta.tags);
            tagsRef.current = meta.tags;
            savedContentRef.current = note.content;
            savedTitleRef.current = meta.title;
            savedTagsRef.current = meta.tags;
            setUserModified(shouldStayEditing);
            await onSaved();
          } catch (e) {
            console.error("Failed to save meeting data:", e);
          }
        },
      }),
      [
        loadNote,
        loadNoteInternal,
        clearPanel,
        clearLocalDraft,
        handleSave,
        handleTogglePin,
        saveIfNeeded,
        userModified,
        loadedNoteId,
        displayedNotes,
        highlightIndex,
        onNoteClick,
        isAutoMeetingTitle,
        hasUnsavedChanges,
        persistNote,
      ],
    );

    // Load initial note on mount
    useEffect(() => {
      let cancelled = false;

      const restoreDraft = async () => {
        try {
          if (initialLoadDone.current || initialNoteId) {
            return;
          }

          const hasLocalInput = () =>
            contentRef.current.trim().length > 0 ||
            titleRef.current.trim().length > 0 ||
            tagsRef.current.length > 0;

          if (hasLocalInput()) {
            return;
          }

          if (!allowGlobalDraftRestore) {
            return;
          }

          const own = readDraft(panelDraftKey);
          const latest = readDraft(DRAFT_LATEST_KEY);
          const candidates = [own, latest]
            .filter((draft): draft is LocalDraft => !!draft)
            .filter(isDraftFresh)
            .filter(isDraftMeaningful)
            .sort((a, b) => b.updatedAt - a.updatedAt);

          for (const draft of candidates) {
            if (cancelled) return;

            if (draft.noteId) {
              let note: Awaited<ReturnType<typeof getNote>>;
              try {
                note = await getNote(draft.noteId);
              } catch {
                removeDraftForSource(draft.sourceKey);
                continue;
              }

              if (draftMatchesSavedNote(draft, note)) {
                removeDraftForSource(draft.sourceKey);
                continue;
              }

              if (cancelled || hasLocalInput()) {
                return;
              }

              setLoadedNoteId(note.id);
              loadedNoteIdRef.current = note.id;
              savedContentRef.current = note.content;
              savedTitleRef.current = note.title;
              savedTagsRef.current = note.tags;
              setMeetingTranscript(note.transcript ?? null);
              setMeetingHasAudio(note.has_audio ?? false);
              setPinned(isPinnedNotePath(note.path));
            } else {
              setLoadedNoteId(null);
              loadedNoteIdRef.current = null;
              savedContentRef.current = "";
              savedTitleRef.current = "";
              savedTagsRef.current = [];
              setMeetingTranscript(null);
              setMeetingHasAudio(false);
              setPinned(false);
            }

            if (cancelled || hasLocalInput()) {
              return;
            }

            if (draft.sourceKey !== draftStorageKey) {
              removeDraftForSource(draft.sourceKey);
            }

            setContent(draft.content);
            contentRef.current = draft.content;
            setTitle(draft.title);
            titleRef.current = draft.title;
            titleManuallyEditedRef.current = draft.title.trim().length > 0;
            setTags(draft.tags);
            tagsRef.current = draft.tags;
            setShowPinnedList(false);
            setUserModified(true);
            initialLoadDone.current = true;
            return;
          }
        } finally {
          if (!cancelled) {
            draftRestoreCheckedRef.current = true;
          }
        }
      };

      void restoreDraft();

      return () => {
        cancelled = true;
      };
    }, [allowGlobalDraftRestore, initialNoteId, panelDraftKey]);

    useEffect(() => {
      if (!draftRestoreCheckedRef.current) return;

      const draftSnapshot = {
        title: titleRef.current,
        content: contentRef.current,
        tags: tagsRef.current,
      };
      const hasUnsaved = hasUnsavedChanges(false);

      if (!hasUnsaved || !isDraftMeaningful(draftSnapshot)) {
        clearLocalDraft();
        return;
      }

      const timer = window.setTimeout(() => {
        persistLocalDraft();
      }, DRAFT_AUTOSAVE_DELAY_MS);

      return () => {
        window.clearTimeout(timer);
      };
    }, [
      clearLocalDraft,
      content,
      hasUnsavedChanges,
      loadedNoteId,
      persistLocalDraft,
      tags,
      title,
      userModified,
    ]);

    useEffect(() => {
      if (initialNoteId && !initialLoadDone.current) {
        initialLoadDone.current = true;
        loadNote(initialNoteId);
      }
    }, [initialNoteId, loadNote]);

    // Fetch precomputed related notes when a saved note is loaded.
    // Don't re-fetch or clear when entering edit mode — keep showing them.
    useEffect(() => {
      if (!loadedNoteId) {
        setPrecomputedRelated([]);
        setRelatedLoading(false);
        return;
      }
      let cancelled = false;
      setRelatedLoading(true);
      getRelatedNotes(loadedNoteId)
        .then((results) => {
          if (!cancelled) {
            setPrecomputedRelated(results);
            setRelatedLoading(false);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setPrecomputedRelated([]);
            setRelatedLoading(false);
          }
        });
      return () => {
        cancelled = true;
      };
    }, [loadedNoteId]);

    // Listen for backend QMD events.
    useEffect(() => {
      let cleanups: (() => void)[] = [];
      let cancelled = false;
      import("@tauri-apps/api/event")
        .then(({ listen }) => {
          if (cancelled) return;
          listen<string[]>("qmd-processing", (event) => {
            const currentId = loadedNoteIdRef.current;
            if (currentId && event.payload.includes(currentId)) {
              setRelatedLoading(true);
            }
          }).then((unlisten) => {
            if (cancelled) unlisten();
            else cleanups.push(unlisten);
          });
          listen("related-notes-changed", () => {
            const currentId = loadedNoteIdRef.current;
            if (currentId) {
              getRelatedNotes(currentId)
                .then((results) => {
                  setPrecomputedRelated(results);
                  setRelatedLoading(false);
                })
                .catch(() => {
                  setRelatedLoading(false);
                });
            }
          }).then((unlisten) => {
            if (cancelled) unlisten();
            else cleanups.push(unlisten);
          });
        })
        .catch(() => {});
      return () => {
        cancelled = true;
        cleanups.forEach((fn) => fn());
      };
    }, []);

    const handleChange = useCallback((value: string) => {
      contentRef.current = value;
      setContent(value);
      setUserModified(true);
    }, []);

    const handleTagsChange = useCallback((nextTags: string[]) => {
      tagsRef.current = nextTags;
      setTags(nextTags);
      setUserModified(true);
    }, []);

    const handleNoteClick = useCallback(
      (noteId: string, metaKey: boolean) => {
        onNoteClick(noteId, metaKey);
      },
      [onNoteClick],
    );

    const handleEdit = useCallback(() => {
      setUserModified(true);
      requestAnimationFrame(() => editorRef.current?.focus());
    }, []);

    const regenerateTagsForNote = useCallback(
      async (noteId: string) => {
        setRegeneratingTags(true);
        try {
          const updated = await regenerateTags(noteId);
          if (loadedNoteIdRef.current !== noteId) return;
          setTags(updated.tags);
          tagsRef.current = updated.tags;
          savedTagsRef.current = updated.tags;
          await onSaved();
        } catch (e) {
          console.error("Failed to regenerate tags:", e);
        } finally {
          setRegeneratingTags(false);
        }
      },
      [onSaved],
    );

    const handleRegenerateTags = useCallback(async () => {
      if (!loadedNoteId || regeneratingTags) return;
      await regenerateTagsForNote(loadedNoteId);
    }, [loadedNoteId, regeneratingTags, regenerateTagsForNote]);

    const handleRetranscribeNote = useCallback(async () => {
      if (!loadedNoteId || retranscribingNote) return;
      setRetranscribingNote(true);
      const jobKey = `retranscribe-${loadedNoteId}`;
      onBgJob?.(jobKey, "Retranscribing", loadedNoteId);
      try {
        await retranscribeNote(loadedNoteId);
        const noteContent = await getNote(loadedNoteId);
        setContent(noteContent.content);
        setMeetingTranscript(noteContent.transcript ?? null);
        setMeetingHasAudio(noteContent.has_audio ?? false);
        contentRef.current = noteContent.content;
        savedContentRef.current = noteContent.content;
        setSelectedTabId("transcript");
        await onSaved();
      } catch (e) {
        console.error("Failed to retranscribe:", e);
      } finally {
        setRetranscribingNote(false);
        onBgJob?.(jobKey, null);
      }
    }, [loadedNoteId, retranscribingNote, onSaved, onBgJob]);

    const handleResummarizeNote = useCallback(async () => {
      if (!loadedNoteId || resummarizingNote) return;
      setResummarizingNote(true);
      const jobKey = `resummarize-${loadedNoteId}`;
      onBgJob?.(jobKey, "Resummarizing", loadedNoteId);
      try {
        await resummarizeNote(loadedNoteId);
        const noteContent = await getNote(loadedNoteId);
        setContent(noteContent.content);
        setMeetingTranscript(noteContent.transcript ?? null);
        setMeetingHasAudio(noteContent.has_audio ?? false);
        contentRef.current = noteContent.content;
        savedContentRef.current = noteContent.content;
        setSelectedTabId("summary");
        await onSaved();
      } catch (e) {
        console.error("Failed to resummarize:", e);
      } finally {
        setResummarizingNote(false);
        onBgJob?.(jobKey, null);
      }
    }, [loadedNoteId, resummarizingNote, onSaved, onBgJob]);

    // Auto-generate tags when opening a saved note that has no tags yet.
    useEffect(() => {
      if (!loadedNoteId || regeneratingTags || tags.length > 0) return;
      if (savedTagsRef.current.length > 0) return;
      if (autoTagAttemptedRef.current.has(loadedNoteId)) return;
      autoTagAttemptedRef.current.add(loadedNoteId);
      void regenerateTagsForNote(loadedNoteId);
    }, [loadedNoteId, regeneratingTags, tags, regenerateTagsForNote]);

    const listLabel = loadedNoteId
      ? "Related"
      : showPinnedList
        ? "Pinned"
        : "Recent";

    // Reset highlight when notes list changes
    useEffect(() => {
      setHighlightIndex(-1);
    }, [displayedNotes]);

    return (
      <div className="note-panel" onPointerDown={onFocus}>
        {showTagInput && (
          <div
            className="metadata-panel"
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.metaKey) {
                e.preventDefault();
                setShowTagInput(false);
                void handleSave();
              }
            }}
          >
            <input
              className="title-input"
              type="text"
              placeholder="Title..."
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                titleRef.current = e.target.value;
                titleManuallyEditedRef.current = true;
                setUserModified(true);
              }}
            />
            <div className="tag-row">
              <TagInput
                ref={tagInputRef}
                tags={tags}
                allTags={allTags}
                onChange={handleTagsChange}
              />
              {loadedNoteId && (
                <button
                  className="regenerate-tags-btn"
                  onClick={handleRegenerateTags}
                  disabled={regeneratingTags}
                  title="Regenerate tags from content"
                >
                  {regeneratingTags ? (
                    <span className="related-loading">...</span>
                  ) : (
                    "↻"
                  )}
                </button>
              )}
            </div>
          </div>
        )}
        <div className="panel-indicators">
          {loadedNoteId && (
            <button
              className={`pin-toggle-btn ${pinned ? "active" : ""}`}
              onClick={() => void handleTogglePin()}
              title={pinned ? "Unpin" : "Pin"}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill={pinned ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <line x1="12" x2="12" y1="17" y2="22" />
                <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
              </svg>
            </button>
          )}
          <div
            className={`editing-indicator ${userModified ? "visible" : ""}`}
            role="status"
            aria-live="polite"
          >
            Editing
          </div>
          <div className="panel-actions">
            {recording?.active && isRecordingPanel ? (
              <button
                className="record-btn recording"
                onClick={onStopRecording}
              >
                <span className="rec-dot" />
                <span style={{ fontVariantNumeric: "tabular-nums" }}>
                  {String(Math.floor(recording.elapsed_seconds / 60)).padStart(
                    1,
                    "0",
                  )}
                  :{String(recording.elapsed_seconds % 60).padStart(2, "0")}
                </span>
                <span className="level-bars">
                  <span
                    className="level-bar mic"
                    style={{
                      height: `${Math.min(100, (recording.mic_level ?? 0) * 300)}%`,
                    }}
                  />
                  <span
                    className="level-bar system"
                    style={{
                      height: `${Math.min(100, (recording.system_level ?? 0) * 300)}%`,
                    }}
                  />
                </span>
              </button>
            ) : effectiveProcessingProgress ? (
              <span className="recording-progress-text">
                {effectiveProcessingProgress.replace(/\.+$/, "")}
                <span className="related-loading"> ...</span>
              </span>
            ) : (tags.includes("meeting") || tags.includes("voice-memo")) &&
              loadedNoteId ? null : (
              <button
                className="record-btn"
                onClick={onStartRecording}
                disabled={!!recordingLocked}
                title="Record"
              >
                ●
              </button>
            )}
          </div>
        </div>
        <div style={{ display: editing ? undefined : "none" }}>
          <Editor
            ref={editorRef}
            content={content}
            onChange={handleChange}
            onSave={handleSave}
            themeId={themeId}
            vimEnabled={vimEnabled}
            onVimToggle={onVimToggle}
            onNoteNavigate={onNoteNavigate}
            recentNotes={recentNotes}
          />
        </div>
        {!editing &&
          (() => {
            const isRecordingNote =
              tags.includes("meeting") || tags.includes("voice-memo");
            // Only meeting notes are laid out as separate Summary/Transcript
            // sections. Plain voice memos store their transcript inline in the
            // body, so they must NOT get a synthetic Transcript tab.
            const isMeetingNote = tags.includes("meeting");
            const tabs = parseTopLevelHeadingTabs(content);
            // A meeting note whose audio is still on disk should always offer a
            // Transcript tab — even when the note has no `# Transcript` section
            // yet (e.g. transcription failed). It's the only entry point for
            // re-running transcription.
            if (
              isMeetingNote &&
              meetingHasAudio &&
              tabs.length > 0 &&
              !tabs.some(
                (tab) =>
                  tab.normalizedLabel === "transcript" ||
                  tab.id === "transcript",
              )
            ) {
              tabs.push({
                id: "transcript",
                label: "Transcript",
                normalizedLabel: "transcript",
                content: "",
              });
            }
            if (tabs.length > 0) {
              const activeTab =
                tabs.find((tab) => tab.id === selectedTabId) ?? tabs[0];
              const transcriptContent = meetingTranscript?.trim() ?? "";
              const viewContent =
                activeTab.normalizedLabel === "transcript" && transcriptContent
                  ? transcriptContent
                  : activeTab.content;
              const canResummarize =
                activeTab.normalizedLabel === "summary" &&
                isRecordingNote &&
                transcriptContent.length > 0;
              const canRetranscribe =
                activeTab.normalizedLabel === "transcript" &&
                isRecordingNote &&
                meetingHasAudio;
              const showTranscriptEmptyState =
                isRecordingNote &&
                activeTab.normalizedLabel === "transcript" &&
                viewContent.trim().length === 0;
              return (
                <>
                  <div className="meeting-view-toggle">
                    {tabs.map((tab) => (
                      <button
                        key={tab.id}
                        className={activeTab.id === tab.id ? "active" : ""}
                        onClick={() => setSelectedTabId(tab.id)}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                  <div
                    className={`meeting-content-wrapper${
                      showTranscriptEmptyState ? " transcript-empty" : ""
                    }`}
                  >
                    {canResummarize && (
                      <button
                        className="meeting-regen-btn"
                        onClick={() => void handleResummarizeNote()}
                        title="Regenerate summary from transcript"
                      >
                        {resummarizingNote ? (
                          <span className="related-loading">...</span>
                        ) : (
                          "↻"
                        )}
                      </button>
                    )}
                    {canRetranscribe && (
                      <button
                        className="meeting-regen-btn"
                        onClick={() => void handleRetranscribeNote()}
                        title="Retranscribe from audio file"
                      >
                        {retranscribingNote ? (
                          <span className="related-loading">...</span>
                        ) : (
                          "↻"
                        )}
                      </button>
                    )}
                    {showTranscriptEmptyState ? (
                      <p className="transcript-empty-hint">
                        {retranscribingNote
                          ? "Transcribing from the saved audio…"
                          : canRetranscribe
                            ? "No transcript yet. Click ↻ to transcribe from the saved audio."
                            : "No transcript available — the audio file for this note is no longer on disk."}
                      </p>
                    ) : (
                      <MarkdownView
                        content={viewContent}
                        onEdit={handleEdit}
                        onNoteNavigate={onNoteNavigate}
                      />
                    )}
                  </div>
                </>
              );
            }
            return (
              <MarkdownView
                content={content}
                onEdit={handleEdit}
                onNoteNavigate={onNoteNavigate}
              />
            );
          })()}
        <div className="save-hint">
          {/Mac|iPhone|iPad|iPod/i.test(
            navigator.platform || navigator.userAgent,
          ) ? (
            <>
              <kbd>⌃</kbd> <kbd>⌘</kbd> <kbd>+</kbd> shortcuts
            </>
          ) : (
            <>
              <kbd>Ctrl</kbd> <kbd>/</kbd> shortcuts
            </>
          )}
        </div>
        <NotesList
          notes={displayedNotes}
          label={listLabel}
          loading={loadedNoteId ? relatedLoading : false}
          onOpenNote={handleNoteClick}
          highlightIndex={highlightIndex}
          sortBy={sortBy}
          onSortChange={onSortChange}
          tabs={
            !loadedNoteId && !isTyping
              ? [
                  {
                    label: "Recent",
                    active: !showPinnedList,
                    onClick: () => setShowPinnedList(false),
                  },
                  {
                    label: "Pinned",
                    active: showPinnedList,
                    onClick: () => setShowPinnedList(true),
                  },
                ]
              : undefined
          }
        />
      </div>
    );
  },
);

NotePanel.displayName = "NotePanel";
