// The nav panel: the full-page notes browser. Same list, same editor, same
// vocabulary as the floating window — just given a whole route to breathe in.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime } from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { displayTitle, NoteList, SCOPE_ICON } from "@/components/note-list";
import { noteScope, type ScopeFilter } from "@/lib/scope";
import { NoteEditor } from "@/components/note-editor";
import { useNotesState } from "@/lib/hooks";
import { controller } from "@/lib/controller";
import { notesStore, rpc } from "@/lib/store";
import { parseSearchQuery } from "@/lib/notes";
import { EditorFooter } from "@/components/editor-footer";
import type { ListedNote } from "@/lib/contract";

const SEARCH_DEBOUNCE_MS = 150;

export function NotesNavPanel() {
  const { notes, tags, counts, loaded, error } = useNotesState();

  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [view, setView] = useState<"active" | "trash">("active");
  const [searchResults, setSearchResults] = useState<ListedNote[] | null>(null);
  const [trashNotes, setTrashNotes] = useState<ListedNote[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>({ kind: "all" });

  useEffect(() => {
    void notesStore.refresh();
  }, []);

  // Instant sync: agent tools, the CLI, and other windows publish "changed".
  useRealtime(
    "notes",
    useCallback(() => void notesStore.refresh(), []),
  );

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
      const parsed = parseSearchQuery(query);
      const currentThread =
        parsed.threadRef === "current" ? controller.activeThread() : null;
      void rpc
        .call("listNotes", {
          view: parsed.view ?? view,
          ...(parsed.text.length > 0 ? { query: parsed.text } : {}),
          ...(parsed.tag !== undefined ? { tag: parsed.tag } : {}),
          ...(parsed.kinds !== undefined ? { kinds: parsed.kinds } : {}),
          ...(parsed.stickyOpen === true ? { stickyOpen: true } : {}),
          ...(currentThread !== null ? { threadId: currentThread.threadId } : {}),
        })
        .then((result) => {
          if (seq !== searchSeq.current) return;
          let rows = result.notes;
          if (parsed.task === "open") {
            rows = rows.filter((n) => n.taskTotal > n.taskDone);
          } else if (parsed.task === "done") {
            rows = rows.filter((n) => n.taskTotal > 0 && n.taskDone === n.taskTotal);
          }
          setSearchResults(rows);
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
    if (view === "trash") refreshTrash();
  }, [view, refreshTrash]);

  const visibleNotes = useMemo((): readonly ListedNote[] => {
    if (query.trim().length > 0 && searchResults !== null) return searchResults;
    if (view === "trash") return trashNotes;
    if (activeTag !== null) return notes.filter((note) => note.tags.includes(activeTag));
    return notes;
  }, [query, searchResults, view, trashNotes, activeTag, notes]);

  const selected = useMemo(
    (): ListedNote | null =>
      (view === "trash" ? trashNotes : notes).find((note) => note.id === selectedId) ??
      null,
    [selectedId, notes, trashNotes, view],
  );

  useEffect(() => {
    if (selected === null && visibleNotes.length > 0) {
      setSelectedId(visibleNotes[0]!.id);
    }
  }, [selected, visibleNotes]);

  const newNote = useCallback(async () => {
    try {
      const note = await notesStore.createNote({});
      setView("active");
      setQuery("");
      setActiveTag(null);
      setSelectedId(note.id);
    } catch {
      toast.error("Could not create a note");
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

  const openDaily = useCallback(async () => {
    try {
      const note = await notesStore.dailyNote();
      setView("active");
      setSelectedId(note.id);
    } catch {
      toast.error("Could not open the daily note");
    }
  }, []);

  return (
    <div className="bb-fn-panel flex h-full min-h-0">
      <NoteList
        notes={visibleNotes}
        tags={tags}
        trashedCount={counts.trashed}
        query={query}
        onQueryChange={setQuery}
        scopeFilter={scopeFilter}
        onScopeFilterChange={setScopeFilter}
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
        onOpenInbox={() => void openInbox()}
        onOpenDaily={() => void openDaily()}
        onRestore={(id) => void notesStore.restoreNote(id).then(refreshTrash)}
        onPurge={(id) => void notesStore.purgeNote(id).then(refreshTrash)}
        onEmptyTrash={() => void notesStore.emptyTrash().then(refreshTrash)}
        className="bb-fn-list-pane border-r border-border"
      />
      {selected === null ? (
        <div className="bb-fn-editor-pane flex min-h-0 flex-col items-center justify-center gap-1 p-8 text-center">
          <p className="text-sm text-muted-foreground">
            {loaded ? "Select a note, or start one." : "Loading notes…"}
          </p>
          {error !== null ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : null}
        </div>
      ) : (
        <div className="bb-fn-editor-pane flex min-h-0 flex-col">
          <div className="flex shrink-0 items-center gap-0.5 border-b border-border px-3 py-1.5">
            <Icon
              name={SCOPE_ICON[noteScope(selected).kind]}
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {displayTitle(selected)}
            </span>
            {view === "trash" ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() =>
                    void notesStore.restoreNote(selected.id).then(() => {
                      refreshTrash();
                      setView("active");
                      setSelectedId(selected.id);
                    })
                  }
                >
                  Restore
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs text-destructive"
                  onClick={() => void notesStore.purgeNote(selected.id).then(refreshTrash)}
                >
                  Delete forever
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={selected.pinned ? "Unpin" : "Pin to top"}
                  onClick={() =>
                    void notesStore.updateNote({ id: selected.id, pinned: !selected.pinned })
                  }
                >
                  <Icon
                    name="Pin"
                    className={selected.pinned ? "size-4 text-primary" : "size-4"}
                    aria-label={selected.pinned ? "Unpin" : "Pin"}
                  />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label="Pop out as sticky"
                  onClick={() => {
                    void notesStore.updateNote({ id: selected.id, stickyOpen: true });
                    toast.success("Popped out as a sticky");
                  }}
                >
                  <Icon name="ArrowUpRight" className="size-4" aria-label="Pop out" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label="Copy as Markdown"
                  onClick={() =>
                    void navigator.clipboard
                      ?.writeText(selected.body)
                      .then(() => toast.success("Copied as Markdown"))
                  }
                >
                  <Icon name="Copy" className="size-4" aria-label="Copy" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label="Move to trash"
                  onClick={() => void notesStore.trashNote(selected.id)}
                >
                  <Icon name="Trash2" className="size-4" aria-label="Trash" />
                </Button>
              </>
            )}
          </div>
          {view === "trash" ? (
            <div className="bb-fn-quiet-scroll min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap p-4 font-mono text-xs text-muted-foreground">
              {selected.body}
            </div>
          ) : (
            <>
              <NoteEditor
                key={selected.id}
                note={selected}
                className={
                  selected.color !== null
                    ? `bb-fn-tint-${selected.color} bb-fn-tinted-editor`
                    : undefined
                }
              />
              <EditorFooter
                note={selected}
                notes={notes}
                onTagClick={(tag) => {
                  setView("active");
                  setQuery("");
                  setActiveTag(tag);
                }}
                onOpenNote={setSelectedId}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
