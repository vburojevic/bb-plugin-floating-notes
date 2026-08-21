// The main floating window: note list left, editor right, palette over both.
//
// Desktop: draggable/resizable, geometry persisted. Compact viewports: a
// sheet owned by the stylesheet, with visualViewport keeping the editor's
// caret above the software keyboard. Ported wholesale from the floating
// terminal's window and rebuilt around notes.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { NoteList } from "@/components/note-list";
import { NoteEditor } from "@/components/note-editor";
import { Palette, type PaletteAction } from "@/components/palette";
import { useFloatingFrame } from "@/components/use-floating-frame";
import { useControllerState, useNotesState } from "@/lib/hooks";
import { controller } from "@/lib/controller";
import { notesStore, rpc } from "@/lib/store";
import { defaultWindowFrame, WINDOW_PROFILE } from "@/lib/frame";
import { raiseLayer } from "@/lib/z-order";
import { trackVisualViewport } from "@/lib/viewport";
import {
  noteColorSchema,
  type ListedNote,
  type NoteColor,
} from "@/lib/contract";
import { cn } from "@/lib/utils";

const SEARCH_DEBOUNCE_MS = 150;
const LAST_NOTE_KEY = "bb-plugin-notes:last-note";

const COLOR_LABEL: Record<NoteColor, string> = {
  yellow: "Yellow",
  mint: "Mint",
  sky: "Sky",
  rose: "Rose",
  lavender: "Lavender",
  peach: "Peach",
};

function wordCount(body: string): number {
  const words = body.trim().split(/\s+/).filter((word) => word.length > 0);
  return words.length;
}

export function NotesWindow() {
  const { windowOpen: open, focusNoteId } = useControllerState();
  const { notes, tags, counts, config, loaded, error } = useNotesState();

  const sheet = useIsCompactViewport();
  const [mounted, setMounted] = useState(false);
  /** One frame behind `mounted`, so the first open still animates in. */
  const [armed, setArmed] = useState(false);

  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [view, setView] = useState<"active" | "trash">("active");
  const [searchResults, setSearchResults] = useState<ListedNote[] | null>(null);
  const [trashNotes, setTrashNotes] = useState<ListedNote[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(LAST_NOTE_KEY);
    } catch {
      return null;
    }
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** The note whose editor should grab focus (just created). */
  const [focusEditorId, setFocusEditorId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // The window re-opens on the note you were last reading.
  useEffect(() => {
    if (selectedId === null || view !== "active") return;
    try {
      window.localStorage.setItem(LAST_NOTE_KEY, selectedId);
    } catch {
      // Selection memory is a nicety; private mode just forgets.
    }
  }, [selectedId, view]);

  const { rootRef, handleRef, resizeEdges } = useFloatingFrame({
    frameKey: "window",
    profile: WINDOW_PROFILE,
    fallback: defaultWindowFrame,
    active: mounted && !sheet,
  });

  // ------------------------------------------------------------ lifecycle

  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  useEffect(() => {
    if (!mounted || armed) return;
    const raf = window.requestAnimationFrame(() => setArmed(true));
    return () => window.cancelAnimationFrame(raf);
  }, [mounted, armed]);

  // Re-opening brings the window above any stickies it was buried under.
  useEffect(() => {
    if (open && !sheet && rootRef.current !== null) raiseLayer(rootRef.current);
  }, [open, sheet, rootRef]);

  // Only the sheet needs keyboard-aware geometry.
  useEffect(() => {
    const node = rootRef.current;
    if (!sheet || node === null || !mounted) return;
    return trackVisualViewport(node);
  }, [sheet, mounted, rootRef]);

  // A reveal request (palette on another surface, message action, sticky).
  useEffect(() => {
    if (focusNoteId === null) return;
    setView("active");
    setSelectedId(focusNoteId);
    controller.clearFocusNote();
  }, [focusNoteId]);

  // autoFocus is a mount-time request; clear it once consumed so re-selecting
  // that note later does not yank focus out of the list or search field.
  useEffect(() => {
    if (focusEditorId === null) return;
    const raf = window.requestAnimationFrame(() => setFocusEditorId(null));
    return () => window.cancelAnimationFrame(raf);
  }, [focusEditorId]);

  // ---------------------------------------------------------------- data

  const searchTimer = useRef<number | null>(null);
  /** Monotonic token: a late response for an old query/view must not land. */
  const searchSeq = useRef(0);
  useEffect(() => {
    const seq = ++searchSeq.current;
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    if (query.trim().length === 0) {
      setSearchResults(null);
      return;
    }
    searchTimer.current = window.setTimeout(() => {
      void rpc
        .call("listNotes", { query, view })
        .then((result) => {
          if (seq === searchSeq.current) setSearchResults(result.notes);
        })
        .catch(() => {
          if (seq === searchSeq.current) setSearchResults(null);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    };
  }, [query, view]);

  const refreshTrash = useCallback(() => {
    void rpc
      .call("listNotes", { view: "trash" })
      .then((result) => setTrashNotes(result.notes))
      .catch(() => setTrashNotes([]));
  }, []);

  useEffect(() => {
    if (view === "trash" && open) refreshTrash();
  }, [view, open, refreshTrash]);

  const visibleNotes = useMemo((): readonly ListedNote[] => {
    if (query.trim().length > 0 && searchResults !== null) return searchResults;
    if (view === "trash") return trashNotes;
    if (activeTag !== null) {
      return notes.filter((note) => note.tags.includes(activeTag));
    }
    return notes;
  }, [query, searchResults, view, trashNotes, activeTag, notes]);

  const selected = useMemo((): ListedNote | null => {
    const pool = view === "trash" ? trashNotes : notes;
    return (
      pool.find((note) => note.id === selectedId) ??
      visibleNotes.find((note) => note.id === selectedId) ??
      null
    );
  }, [selectedId, notes, trashNotes, view, visibleNotes]);

  // Keep something selected once notes exist — but never on the sheet, where
  // "nothing selected" IS the list screen and auto-selecting would bounce the
  // user straight back into the editor they just left.
  useEffect(() => {
    if (!sheet && selected === null && visibleNotes.length > 0) {
      setSelectedId(visibleNotes[0]!.id);
    }
  }, [sheet, selected, visibleNotes]);

  // -------------------------------------------------------------- actions

  const newNote = useCallback(async () => {
    try {
      const color =
        config.defaultColor !== "none" &&
        noteColorSchema.options.includes(config.defaultColor as NoteColor)
          ? (config.defaultColor as NoteColor)
          : undefined;
      const note = await notesStore.createNote(color !== undefined ? { color } : {});
      setView("active");
      setQuery("");
      setActiveTag(null);
      setSelectedId(note.id);
      setFocusEditorId(note.id);
    } catch {
      toast.error("Could not create a note");
    }
  }, [config.defaultColor]);

  const openDaily = useCallback(async () => {
    try {
      const note = await notesStore.dailyNote();
      setView("active");
      setSelectedId(note.id);
    } catch {
      toast.error("Could not open the daily note");
    }
  }, []);

  const openInbox = useCallback(async () => {
    try {
      const note = await notesStore.inboxNote();
      setView("active");
      setSelectedId(note.id);
    } catch {
      toast.error("Could not open the inbox");
    }
  }, []);

  const copySelected = useCallback(() => {
    if (selected === null) return;
    void navigator.clipboard
      ?.writeText(selected.body)
      .then(() => toast.success("Copied as Markdown"))
      .catch(() => toast.error("Clipboard is not available here"));
  }, [selected]);

  const popOutSelected = useCallback(() => {
    if (selected === null) return;
    void notesStore.updateNote({ id: selected.id, stickyOpen: true });
    toast.success("Popped out as a sticky");
  }, [selected]);

  const newSticky = useCallback(async () => {
    // Stickies never render on the compact sheet; a sticky created there
    // would be invisible. Fall back to a plain note in the window.
    if (sheet) {
      await newNote();
      return;
    }
    try {
      const color =
        config.defaultColor !== "none" &&
        noteColorSchema.options.includes(config.defaultColor as NoteColor)
          ? (config.defaultColor as NoteColor)
          : "yellow";
      await notesStore.createNote({ color, stickyOpen: true });
      toast.success("Sticky created — it's floating now");
    } catch {
      toast.error("Could not create a sticky");
    }
  }, [config.defaultColor, sheet, newNote]);

  const trashSelected = useCallback(() => {
    if (selected === null) return;
    void notesStore.trashNote(selected.id).then(() => {
      toast.success("Moved to trash");
    });
  }, [selected]);

  const hide = useCallback(() => controller.hideWindow(), []);

  // ------------------------------------------------------------- keyboard

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "n" && !event.shiftKey) {
        event.preventDefault();
        void newNote();
        return;
      }
      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((current) => !current);
        return;
      }
      if (mod && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (event.key === "Escape") {
        event.stopPropagation();
        if (paletteOpen) setPaletteOpen(false);
        else hide();
      }
    },
    [newNote, paletteOpen, hide],
  );

  // -------------------------------------------------------------- palette

  const paletteActions = useMemo((): PaletteAction[] => {
    const actions: PaletteAction[] = [
      { id: "new", label: "New note", icon: "Plus", hint: "⌘N", run: () => void newNote() },
      { id: "new-sticky", label: "New sticky note", icon: "ArrowUpRight", run: () => void newSticky() },
      { id: "daily", label: "Open daily note", icon: "Calendar", run: () => void openDaily() },
      { id: "inbox", label: "Open inbox", icon: "Archive", run: () => void openInbox() },
      {
        id: "trash",
        label: view === "trash" ? "Back to notes" : "Open trash",
        icon: "Trash2",
        run: () => setView(view === "trash" ? "active" : "trash"),
      },
    ];
    if (selected !== null && view === "active") {
      actions.push(
        { id: "popout", label: `Pop out “${selected.title}”`, icon: "ArrowUpRight", run: popOutSelected },
        { id: "copy", label: "Copy note as Markdown", icon: "Copy", run: copySelected },
        {
          id: "pin",
          label: selected.pinned ? "Unpin note" : "Pin note to top",
          icon: "Pin",
          run: () => void notesStore.updateNote({ id: selected.id, pinned: !selected.pinned }),
        },
        { id: "trash-note", label: "Move note to trash", icon: "Trash2", run: trashSelected },
      );
    }
    return actions;
  }, [newNote, newSticky, openDaily, openInbox, view, selected, popOutSelected, copySelected, trashSelected]);

  // --------------------------------------------------------------- render

  if (!mounted) return null;

  const editorPane =
    selected === null ? (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
        <p className="text-sm text-muted-foreground">
          {loaded ? "Select a note, or start one." : "Loading notes…"}
        </p>
        {error !== null ? (
          <p className="text-xs text-destructive">{error}</p>
        ) : (
          <p className="text-xs text-muted-foreground/70">
            ⌘N new · ⌘K palette · Ctrl+Shift+&apos; quick capture
          </p>
        )}
      </div>
    ) : (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-0.5 border-b border-border px-2 py-1">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
            {selected.title}
          </span>
          {view === "trash" ? (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => {
                  void notesStore.restoreNote(selected.id).then(() => {
                    refreshTrash();
                    setView("active");
                    setSelectedId(selected.id);
                  });
                }}
              >
                Restore
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-xs text-destructive"
                onClick={() => {
                  void notesStore.purgeNote(selected.id).then(refreshTrash);
                }}
              >
                Delete forever
              </Button>
            </>
          ) : (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-6" aria-label="Color">
                    <Icon name="Palette" className="size-3.5" aria-label="Note color" />
                  </Button>
                </DropdownMenuTrigger>
                {/* z-[68]: portals to body at z-50, beneath the floating
                    surfaces' [53,64] band. */}
                <DropdownMenuContent align="end" className="z-[68]">
                  {noteColorSchema.options.map((color) => (
                    <DropdownMenuItem
                      key={color}
                      onSelect={() => void notesStore.updateNote({ id: selected.id, color })}
                    >
                      <span
                        className={cn("size-2.5 rounded-full", `bb-fn-tint-${color}`)}
                        style={{ background: "var(--bb-fn-dot)" }}
                        aria-hidden
                      />
                      {COLOR_LABEL[color]}
                      {selected.color === color ? (
                        <Icon name="Check" className="ml-auto size-3.5" aria-hidden />
                      ) : null}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => void notesStore.updateNote({ id: selected.id, color: null })}
                  >
                    No color
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label={selected.pinned ? "Unpin" : "Pin to top"}
                onClick={() =>
                  void notesStore.updateNote({ id: selected.id, pinned: !selected.pinned })
                }
              >
                <Icon
                  name="Pin"
                  className={cn("size-3.5", selected.pinned ? "text-primary" : "")}
                  aria-label={selected.pinned ? "Unpin" : "Pin"}
                />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label="Pop out as sticky"
                onClick={popOutSelected}
              >
                <Icon name="ArrowUpRight" className="size-3.5" aria-label="Pop out" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label="Copy as Markdown"
                onClick={copySelected}
              >
                <Icon name="Copy" className="size-3.5" aria-label="Copy" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label="Move to trash"
                onClick={trashSelected}
              >
                <Icon name="Trash2" className="size-3.5" aria-label="Trash" />
              </Button>
            </>
          )}
        </div>
        {view === "trash" ? (
          <div className="bb-fn-quiet-scroll min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap p-3 font-mono text-xs text-muted-foreground">
            {selected.body}
          </div>
        ) : (
          <NoteEditor
            key={selected.id}
            note={selected}
            autoFocus={focusEditorId === selected.id}
          />
        )}
        <div className="flex shrink-0 items-center gap-2 border-t border-border px-2.5 py-1 text-[11px] text-muted-foreground">
          {selected.tags.length > 0 ? (
            <span className="flex min-w-0 shrink items-center gap-1 overflow-hidden">
              {selected.tags.slice(0, 4).map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => {
                    setView("active");
                    setQuery("");
                    setActiveTag(tag);
                  }}
                  className="shrink-0 rounded-full border border-border px-1.5 leading-4 transition-colors hover:bg-accent hover:text-foreground"
                >
                  #{tag}
                </button>
              ))}
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate">
            {selected.taskTotal > 0
              ? `${selected.taskDone}/${selected.taskTotal} tasks · `
              : ""}
            {wordCount(selected.body)} words
          </span>
          <span className="shrink-0">
            {new Date(selected.updatedAt).toLocaleString()}
          </span>
        </div>
      </div>
    );

  return (
    <>
      {sheet ? (
        <div
          className="bb-fn-backdrop"
          data-state={open && armed ? "open" : "closed"}
          aria-hidden="true"
          onPointerDown={hide}
        />
      ) : null}
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="false"
        aria-label="Floating notes"
        aria-hidden={!open}
        data-state={open && armed ? "open" : "closed"}
        data-layout={sheet ? "sheet" : "window"}
        className="bb-fn-window fixed flex flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-2xl"
        onKeyDown={onKeyDown}
      >
        <div
          ref={handleRef}
          data-bb-fn-handle=""
          className={cn(
            "flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5",
            sheet ? "" : "cursor-grab active:cursor-grabbing",
          )}
        >
          <Icon name="FileText" className="size-4 text-muted-foreground" aria-hidden />
          <span className="text-sm font-medium">Notes</span>
          <span className="min-w-0 flex-1" />
          <Button
            data-no-drag=""
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Daily note"
            onClick={() => void openDaily()}
          >
            <Icon name="Calendar" className="size-4" aria-label="Daily note" />
          </Button>
          <Button
            data-no-drag=""
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Inbox"
            onClick={() => void openInbox()}
          >
            <Icon name="Archive" className="size-4" aria-label="Inbox" />
          </Button>
          <Button
            data-no-drag=""
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Palette (⌘K)"
            onClick={() => setPaletteOpen(true)}
          >
            <Icon name="Sort" className="size-4" aria-label="Command palette" />
          </Button>
          <Button
            data-no-drag=""
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Hide (Esc)"
            onClick={hide}
          >
            <Icon name="X" className="size-4" aria-label="Hide" />
          </Button>
        </div>

        <div className="relative flex min-h-0 flex-1">
          <NoteList
            notes={visibleNotes}
            tags={tags}
            trashedCount={counts.trashed}
            query={query}
            onQueryChange={setQuery}
            searchInputRef={searchInputRef}
            activeTag={activeTag}
            onTagChange={setActiveTag}
            view={view}
            onViewChange={(next) => {
              setView(next);
              setQuery("");
            }}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onNew={() => void newNote()}
            onRestore={(id) => {
              void notesStore.restoreNote(id).then(refreshTrash);
            }}
            onPurge={(id) => {
              void notesStore.purgeNote(id).then(refreshTrash);
            }}
            onEmptyTrash={() => {
              void notesStore.emptyTrash().then(() => {
                refreshTrash();
                toast.success("Trash emptied");
              });
            }}
            className={cn(
              "shrink-0 border-r border-border",
              sheet && selected !== null ? "hidden" : "",
              sheet ? "w-full" : "w-60",
            )}
          />
          {/* On the sheet, the editor replaces the list; a back affordance
              lives in its header via deselect. */}
          {sheet && selected !== null ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <button
                type="button"
                className="flex shrink-0 items-center gap-1 px-2 py-1 text-xs text-muted-foreground"
                onClick={() => setSelectedId(null)}
              >
                <Icon name="ChevronLeft" className="size-3.5" aria-hidden />
                All notes
              </button>
              {editorPane}
            </div>
          ) : sheet ? null : (
            editorPane
          )}

          {paletteOpen ? (
            <Palette
              actions={paletteActions}
              notes={notes}
              onOpenNote={(id) => {
                setView("active");
                setSelectedId(id);
              }}
              onClose={() => setPaletteOpen(false)}
            />
          ) : null}
        </div>

        {resizeEdges}
      </div>
    </>
  );
}
