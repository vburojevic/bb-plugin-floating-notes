// bb-plugin-notes — frontend: a Notes nav panel (search, tags, pinning,
// trash, markdown preview, autosave editing), a per-thread quick-capture side
// panel, a thread header shortcut, and a "Save as note" action on messages.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  Markdown,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Note, rpcContract } from "./server";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePointerCoarse } from "@/components/ui/hooks/use-pointer-coarse";
import { snippetFromBody } from "@/lib/notes";
import { cn } from "@/lib/utils";

const PANEL_PATH = "notes";
const THREAD_PANEL_ACTION_ID = "thread-notes";

type TagCount = { name: string; count: number };
type NoteCounts = { active: number; trashed: number };

/** The plugin's sticky-note glyph (mirrors assets/icon.svg). */
function NotesGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="1.75 1.6 20.5 20.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <path d="M3 5a2.5 2.5 0 0 1 2.5-2.5h13A2.5 2.5 0 0 1 21 5v8.8L14.3 21H5.5A2.5 2.5 0 0 1 3 18.5Z" />
      <path d="M21 13.8h-4.7a2 2 0 0 0-2 2V21" />
      <path d="M7.5 8.5h9" />
      <path d="M7.5 12.3h5.5" />
    </svg>
  );
}

/** Plain-fetch RPC for callbacks that run outside React (and unmount flushes). */
async function rpcFetch(method: keyof typeof rpcContract & string, input: unknown): Promise<unknown> {
  const response = await fetch(`/api/v1/plugins/notes/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const envelope = (await response.json()) as
    | { ok: true; result: unknown }
    | { ok: false; error?: { message?: string } };
  if (!envelope.ok) throw new Error(envelope.error?.message ?? "Notes RPC failed");
  return envelope.result;
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

function fullDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function wordCount(body: string): number {
  const words = body.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Fetch + live-refresh a filtered note list. */
function useNotes(filter: {
  query?: string;
  tag?: string;
  view?: "active" | "trash";
  threadId?: string;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [counts, setCounts] = useState<NoteCounts>({ active: 0, trashed: 0 });
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const reload = useCallback(async () => {
    const current = filterRef.current;
    try {
      const result = await rpc.call("listNotes", {
        ...(current.query ? { query: current.query } : {}),
        ...(current.tag ? { tag: current.tag } : {}),
        ...(current.view ? { view: current.view } : {}),
        ...(current.threadId ? { threadId: current.threadId } : {}),
      });
      setNotes(result.notes);
      setTags(result.tags);
      setCounts(result.counts);
    } catch {
      setNotes((previous) => previous ?? []);
    }
  }, [rpc]);

  useEffect(() => {
    void reload();
  }, [reload, filter.query, filter.tag, filter.view, filter.threadId]);
  useRealtime("notes", () => void reload());

  return { notes, tags, counts, reload };
}

function TipButton({ tip, children }: { tip: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {icon}
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {hint ? <p className="mx-auto max-w-56 text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-3 text-[11px] font-medium text-muted-foreground first:pt-1">
      {children}
    </div>
  );
}

function TagChips({
  tags,
  activeTag,
  onToggle,
}: {
  tags: TagCount[];
  activeTag: string | null;
  onToggle: (tag: string) => void;
}) {
  if (tags.length === 0) return null;
  return (
    <div className="flex gap-1 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {tags.map((tag) => (
        <button
          key={tag.name}
          type="button"
          onClick={() => onToggle(tag.name)}
          className="shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-full"
          aria-pressed={tag.name === activeTag}
        >
          <Badge variant={tag.name === activeTag ? "default" : "secondary"} className="gap-1 rounded-full font-normal">
            #{tag.name}
            <span className={cn("tabular-nums", tag.name === activeTag ? "opacity-70" : "text-muted-foreground")}>
              {tag.count}
            </span>
          </Badge>
        </button>
      ))}
    </div>
  );
}

function NoteRow({
  note,
  view,
  selected,
  onSelect,
  onTogglePin,
  onTrash,
  onRestore,
}: {
  note: Note;
  view: "active" | "trash";
  selected: boolean;
  onSelect: () => void;
  onTogglePin: () => void;
  onTrash: () => void;
  onRestore: () => void;
}) {
  const coarse = usePointerCoarse();
  const body = snippetFromBody(note.body);
  return (
    <div
      className={cn(
        "group relative rounded-md",
        selected ? "bg-state-active" : "hover:bg-state-hover",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full cursor-pointer flex-col gap-1 rounded-md px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="flex items-center gap-1.5">
          {view === "active" && note.pinned ? (
            <Icon name="Pin" className="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{note.title}</span>
          <span
            className={cn(
              "shrink-0 text-[11px] tabular-nums text-muted-foreground",
              !coarse && "transition-opacity group-focus-within:opacity-0 group-hover:opacity-0",
            )}
          >
            {relativeTime(view === "trash" ? (note.trashedAt ?? note.updatedAt) : note.updatedAt)}
          </span>
        </span>
        {body ? (
          <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{body}</span>
        ) : null}
        {note.tags.length > 0 ? (
          <span className="flex flex-wrap gap-1 pt-0.5">
            {note.tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="rounded-full text-[10px] font-normal">
                #{tag}
              </Badge>
            ))}
          </span>
        ) : null}
      </button>
      {!coarse ? (
        <div className="absolute right-1.5 top-1.5 hidden items-center gap-0.5 group-focus-within:flex group-hover:flex">
          {view === "active" ? (
            <>
              <TipButton tip={note.pinned ? "Unpin" : "Pin"}>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  aria-label={note.pinned ? "Unpin note" : "Pin note"}
                  onClick={onTogglePin}
                >
                  <Icon name={note.pinned ? "PinOff" : "Pin"} className="size-3.5" />
                </Button>
              </TipButton>
              <TipButton tip="Move to trash">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  aria-label="Move note to trash"
                  onClick={onTrash}
                >
                  <Icon name="Trash2" className="size-3.5" />
                </Button>
              </TipButton>
            </>
          ) : (
            <TipButton tip="Restore">
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label="Restore note"
                onClick={onRestore}
              >
                <Icon name="ArchiveRestore" className="size-3.5" />
              </Button>
            </TipButton>
          )}
        </div>
      ) : null}
    </div>
  );
}

function NoteListSkeleton() {
  return (
    <div className="flex flex-col gap-1 p-2">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex flex-col gap-2 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-8" />
          </div>
          <Skeleton className="h-3 w-11/12" />
        </div>
      ))}
    </div>
  );
}

type SaveState = "idle" | "dirty" | "saving" | "saved";

function NoteEditor({
  noteId,
  onBack,
  onGone,
}: {
  noteId: string;
  onBack: () => void;
  onGone: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const [note, setNote] = useState<Note | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const pendingRef = useRef<{ id: string; body: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const { note } = await rpc.call("getNote", { id: noteId });
      setNote(note);
      setLoaded(true);
      if (note && note.body.trim() === "" && note.trashedAt === null && !editingRef.current) {
        setDraft(note.body);
        setEditing(true);
      }
    } catch {
      setLoaded(true);
    }
  }, [rpc, noteId]);

  useEffect(() => {
    setEditing(false);
    setLoaded(false);
    setSaveState("idle");
    void load();
  }, [load]);
  useRealtime("notes", () => void load());

  // Flush an unsaved draft when switching notes or unmounting mid-edit.
  useEffect(
    () => () => {
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) void rpcFetch("updateNote", { id: pending.id, body: pending.body }).catch(() => {});
    },
    [noteId],
  );

  const persist = useCallback(async () => {
    const pending = pendingRef.current;
    if (!pending) return;
    setSaveState("saving");
    try {
      await rpc.call("updateNote", { id: pending.id, body: pending.body });
      if (pendingRef.current?.body === pending.body) pendingRef.current = null;
      setSaveState("saved");
    } catch (error) {
      setSaveState("dirty");
      toast.error(error instanceof Error ? error.message : "Could not save note");
    }
  }, [rpc]);

  // Debounced autosave while editing.
  useEffect(() => {
    if (!editing || !note) return;
    if (draft === note.body) return;
    pendingRef.current = { id: note.id, body: draft };
    setSaveState("dirty");
    const timer = setTimeout(() => void persist(), 800);
    return () => clearTimeout(timer);
  }, [draft, editing, note, persist]);

  // Let the "Saved" indicator rest back to idle.
  useEffect(() => {
    if (saveState !== "saved") return;
    const timer = setTimeout(() => setSaveState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [saveState]);

  const finishEditing = () => {
    void persist();
    setEditing(false);
  };

  const startEditing = () => {
    if (!note || note.trashedAt !== null) return;
    setDraft(note.body);
    setEditing(true);
  };

  const mutate = async (operation: () => Promise<unknown>, failure: string) => {
    try {
      await operation();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : failure);
    }
  };

  if (!loaded) return null;
  if (!note)
    return (
      <EmptyState
        icon={<Icon name="FileQuestion" className="size-5" />}
        title="This note no longer exists"
        action={
          <Button variant="outline" size="sm" onClick={onGone}>
            Back to notes
          </Button>
        }
      />
    );

  const addTag = () =>
    mutate(async () => {
      const tag = tagDraft.trim();
      if (!tag) return;
      await rpc.call("updateNote", { id: note.id, tags: [...note.tags, tag] });
      setTagDraft("");
    }, "Could not add tag");

  const copyMarkdown = () =>
    mutate(async () => {
      await navigator.clipboard.writeText(note.body);
      toast.success("Markdown copied");
    }, "Could not copy note");

  const trashed = note.trashedAt !== null;
  const words = wordCount(editing ? draft : note.body);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div className="flex h-11 items-center gap-1 border-b border-border px-3">
        <Button variant="ghost" size="icon" className="size-7 md:hidden" aria-label="Back to list" onClick={onBack}>
          <Icon name="ChevronLeft" />
        </Button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{note.title}</span>
        <span
          aria-live="polite"
          className={cn(
            "shrink-0 px-1 text-[11px] text-muted-foreground transition-opacity",
            saveState === "idle" && "opacity-0",
          )}
        >
          {saveState === "saved" ? "Saved" : saveState === "idle" ? "" : "Saving…"}
        </span>
        {!trashed ? (
          <>
            <TipButton tip={note.pinned ? "Unpin" : "Pin"}>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={note.pinned ? "Unpin note" : "Pin note"}
                aria-pressed={note.pinned}
                onClick={() =>
                  mutate(() => rpc.call("updateNote", { id: note.id, pinned: !note.pinned }), "Could not pin note")
                }
              >
                <Icon name={note.pinned ? "PinOff" : "Pin"} />
              </Button>
            </TipButton>
            {editing ? (
              <Button size="sm" className="h-7" onClick={finishEditing}>
                Done
              </Button>
            ) : (
              <TipButton tip="Edit note">
                <Button variant="ghost" size="icon" className="size-7" aria-label="Edit note" onClick={startEditing}>
                  <Icon name="Edit" />
                </Button>
              </TipButton>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7" aria-label="More actions">
                  <Icon name="MoreHorizontal" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={() => void copyMarkdown()}>
                    <Icon name="Copy" className="size-4" />
                    Copy markdown
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      mutate(async () => {
                        const { note: duplicate } = await rpc.call("createNote", {
                          body: note.body,
                          tags: note.tags,
                        });
                        toast.success("Note duplicated");
                        nav.toPluginPanel(PANEL_PATH, { subPath: duplicate.id });
                      }, "Could not duplicate note")
                    }
                  >
                    <Icon name="Layers" className="size-4" />
                    Duplicate note
                  </DropdownMenuItem>
                  {note.originThreadId ? (
                    <DropdownMenuItem onSelect={() => nav.toThread(note.originThreadId!)}>
                      <Icon name="ExternalLink" className="size-4" />
                      Open origin thread
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() =>
                    mutate(async () => {
                      await rpc.call("trashNote", { id: note.id });
                      toast.success("Moved to trash");
                      onGone();
                    }, "Could not trash note")
                  }
                >
                  <Icon name="Trash2" className="size-4" />
                  Move to trash
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : null}
      </div>

      {trashed ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-4 py-2">
          <Icon name="Trash2" className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 text-xs text-muted-foreground">
            This note is in the trash. Restore it to edit.
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7"
            onClick={() =>
              mutate(async () => {
                await rpc.call("restoreNote", { id: note.id });
                toast.success("Note restored");
              }, "Could not restore note")
            }
          >
            <Icon name="ArchiveRestore" className="size-3.5" />
            Restore
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm" className="h-7">
                Delete forever
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this note forever?</AlertDialogTitle>
                <AlertDialogDescription>
                  “{note.title}” will be permanently deleted. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() =>
                    mutate(async () => {
                      await rpc.call("purgeNote", { id: note.id });
                      toast.success("Note permanently deleted");
                      onGone();
                    }, "Could not delete note")
                  }
                >
                  Delete forever
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 overflow-x-auto border-b border-border px-3 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {note.tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="shrink-0 gap-1 rounded-full font-normal">
              #{tag}
              <button
                type="button"
                aria-label={`Remove tag ${tag}`}
                className="cursor-pointer opacity-60 hover:opacity-100"
                onClick={() =>
                  mutate(
                    () =>
                      rpc.call("updateNote", {
                        id: note.id,
                        tags: note.tags.filter((t) => t !== tag),
                      }),
                    "Could not remove tag",
                  )
                }
              >
                <Icon name="X" className="size-3" />
              </button>
            </Badge>
          ))}
          <Input
            value={tagDraft}
            onChange={(event) => setTagDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                void addTag();
              }
            }}
            placeholder={note.tags.length === 0 ? "Add a tag…" : "Add…"}
            aria-label="Add tag"
            className="h-6 w-24 shrink-0 border-none px-1 text-xs shadow-none focus-visible:ring-0"
          />
        </div>
      )}

      {editing ? (
        <Textarea
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              finishEditing();
            }
            if (event.key === "Escape") finishEditing();
          }}
          onBlur={() => void persist()}
          placeholder="Write in Markdown — the first line becomes the title."
          className="min-h-0 flex-1 resize-none rounded-none border-none p-4 font-mono text-[13px] leading-relaxed shadow-none focus-visible:ring-0"
        />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div
            className={cn("p-4", !trashed && "cursor-text")}
            onDoubleClick={startEditing}
          >
            {note.body.trim() === "" ? (
              <p className="text-sm text-muted-foreground">Empty note — double-click to write.</p>
            ) : (
              <Markdown content={note.body} />
            )}
          </div>
        </ScrollArea>
      )}

      <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-1.5 text-[11px] text-muted-foreground">
        <span>
          {words} {words === 1 ? "word" : "words"}
          {editing ? " · ⌘↵ to finish" : ""}
        </span>
        <span className="truncate">Edited {fullDate(note.updatedAt)}</span>
      </div>
    </div>
  );
}

function NotesNavPanel({ subPath }: { subPath: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search, 150);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [view, setView] = useState<"active" | "trash">("active");
  const [creating, setCreating] = useState(false);
  const { notes, tags, counts } = useNotes({
    query: query || undefined,
    tag: view === "active" ? (activeTag ?? undefined) : undefined,
    view,
  });
  const selectedId = subPath === "" ? null : subPath;
  const open = (id: string | null) => nav.toPluginPanel(PANEL_PATH, { subPath: id ?? "" });

  // Drop a stale tag filter when its last note loses the tag.
  useEffect(() => {
    if (activeTag && !tags.some((tag) => tag.name === activeTag)) setActiveTag(null);
  }, [tags, activeTag]);

  const createNote = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const { note } = await rpc.call("createNote", { body: "" });
      setView("active");
      setSearch("");
      setActiveTag(null);
      open(note.id);
    } catch {
      toast.error("Could not create note");
    } finally {
      setCreating(false);
    }
  };

  const rowActions = (note: Note) => ({
    onTogglePin: () =>
      void rpc
        .call("updateNote", { id: note.id, pinned: !note.pinned })
        .catch(() => toast.error("Could not pin note")),
    onTrash: () =>
      void rpc
        .call("trashNote", { id: note.id })
        .then(() => {
          toast.success("Moved to trash");
          if (selectedId === note.id) open(null);
        })
        .catch(() => toast.error("Could not trash note")),
    onRestore: () =>
      void rpc
        .call("restoreNote", { id: note.id })
        .then(() => toast.success("Note restored"))
        .catch(() => toast.error("Could not restore note")),
  });

  const emptyTrash = async () => {
    try {
      const { purged } = await rpc.call("emptyTrash");
      toast.success(purged > 0 ? `Deleted ${purged} note${purged === 1 ? "" : "s"}` : "Trash was already empty");
      open(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not empty trash");
    }
  };

  const filtered = Boolean(query || activeTag);
  const pinned = (notes ?? []).filter((note) => note.pinned);
  const unpinned = (notes ?? []).filter((note) => !note.pinned);
  const orderedIds =
    view === "trash" ? (notes ?? []).map((note) => note.id) : [...pinned, ...unpinned].map((note) => note.id);

  const moveSelection = (delta: 1 | -1) => {
    if (orderedIds.length === 0) return;
    const index = selectedId ? orderedIds.indexOf(selectedId) : -1;
    const next =
      index === -1
        ? delta === 1
          ? 0
          : orderedIds.length - 1
        : Math.min(orderedIds.length - 1, Math.max(0, index + delta));
    if (orderedIds[next] !== selectedId) open(orderedIds[next]!);
  };

  // Arrow-key navigation while focus is on a list row (never while typing).
  const onListKeyDown = (event: React.KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, [contenteditable=true]")) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
    }
  };

  const renderRow = (note: Note) => (
    <NoteRow
      key={note.id}
      note={note}
      view={view}
      selected={note.id === selectedId}
      onSelect={() => open(note.id)}
      {...rowActions(note)}
    />
  );

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full">
        <div
          className={cn(
            "w-full shrink-0 flex-col border-r border-border md:flex md:w-80",
            selectedId ? "hidden" : "flex",
          )}
          onKeyDown={onListKeyDown}
        >
          <div className="flex flex-col gap-2 p-3 pb-2">
            <div className="flex items-center gap-1.5">
              <div className="relative min-w-0 flex-1">
                <Icon
                  name="Search"
                  className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown" || event.key === "Enter") {
                      event.preventDefault();
                      moveSelection(1);
                    } else if (event.key === "Escape" && search) {
                      event.preventDefault();
                      setSearch("");
                    }
                  }}
                  placeholder={view === "trash" ? "Search trash…" : "Search notes…"}
                  aria-label={view === "trash" ? "Search trash" : "Search notes"}
                  className="h-8 pl-8 pr-7"
                />
                {search ? (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => setSearch("")}
                    className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                  >
                    <Icon name="X" className="size-3.5" />
                  </button>
                ) : null}
              </div>
              {view === "active" ? (
                <Button
                  size="sm"
                  className="h-8 shrink-0 gap-1 px-2.5"
                  disabled={creating}
                  onClick={() => void createNote()}
                >
                  <Icon name="Plus" className="size-3.5" />
                  New
                </Button>
              ) : (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 shrink-0"
                      disabled={counts.trashed === 0}
                    >
                      Empty trash
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Empty the trash?</AlertDialogTitle>
                      <AlertDialogDescription>
                        {counts.trashed === 1
                          ? "1 note will be permanently deleted."
                          : `${counts.trashed} notes will be permanently deleted.`}{" "}
                        This cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        onClick={() => void emptyTrash()}
                      >
                        Delete {counts.trashed === 1 ? "1 note" : `${counts.trashed} notes`}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
            {view === "active" ? (
              <TagChips
                tags={tags}
                activeTag={activeTag}
                onToggle={(tag) => setActiveTag(activeTag === tag ? null : tag)}
              />
            ) : null}
          </div>
          <div className="min-h-0 flex-1 border-t border-border">
            {notes === null ? (
              <NoteListSkeleton />
            ) : notes.length === 0 ? (
              view === "trash" ? (
                <EmptyState
                  icon={<Icon name="Trash2" className="size-5" />}
                  title="Trash is empty"
                  hint="Trashed notes land here and can be restored."
                />
              ) : filtered ? (
                <EmptyState
                  icon={<Icon name="Search" className="size-5" />}
                  title="No matching notes"
                  action={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setSearch("");
                        setActiveTag(null);
                      }}
                    >
                      Clear filters
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={<NotesGlyph className="size-5" />}
                  title="No notes yet"
                  hint="Capture ideas, save chat snippets, and reference them with @note in any thread."
                  action={
                    <Button size="sm" disabled={creating} onClick={() => void createNote()}>
                      <Icon name="Plus" className="size-3.5" />
                      New note
                    </Button>
                  }
                />
              )
            ) : (
              <ScrollArea className="h-full">
                <div className="flex flex-col gap-0.5 p-2">
                  {view === "trash" ? (
                    notes.map(renderRow)
                  ) : pinned.length > 0 ? (
                    <>
                      {unpinned.length > 0 ? <SectionLabel>Pinned</SectionLabel> : null}
                      {pinned.map(renderRow)}
                      {unpinned.length > 0 ? <SectionLabel>Notes</SectionLabel> : null}
                      {unpinned.map(renderRow)}
                    </>
                  ) : (
                    notes.map(renderRow)
                  )}
                </div>
              </ScrollArea>
            )}
          </div>
          <div className="flex items-center justify-between border-t border-border px-3 py-1">
            <span className="text-[11px] text-muted-foreground">
              {view === "trash"
                ? `${counts.trashed} in trash`
                : `${counts.active} ${counts.active === 1 ? "note" : "notes"}`}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
              aria-pressed={view === "trash"}
              onClick={() => {
                setView(view === "trash" ? "active" : "trash");
                setSearch("");
                open(null);
              }}
            >
              {view === "trash" ? (
                <>
                  <Icon name="ChevronLeft" className="size-3.5" />
                  Back to notes
                </>
              ) : (
                <>
                  <Icon name="Trash2" className="size-3.5" />
                  Trash{counts.trashed > 0 ? ` · ${counts.trashed}` : ""}
                </>
              )}
            </Button>
          </div>
        </div>
        <div className={cn("min-w-0 flex-1 md:flex", selectedId ? "flex" : "hidden")}>
          {selectedId ? (
            <NoteEditor noteId={selectedId} onBack={() => open(null)} onGone={() => open(null)} />
          ) : (
            <EmptyState
              icon={<NotesGlyph className="size-5" />}
              title="Select a note"
              hint="Pick a note from the list, or start a new one."
              action={
                <Button variant="outline" size="sm" disabled={creating} onClick={() => void createNote()}>
                  <Icon name="Plus" className="size-3.5" />
                  New note
                </Button>
              }
            />
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}

function NotesHeaderContent() {
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  return (
    <TooltipProvider delayDuration={400}>
      <TipButton tip="New note">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="New note"
          onClick={() => {
            void rpc
              .call("createNote", { body: "" })
              .then(({ note }) => nav.toPluginPanel(PANEL_PATH, { subPath: note.id }))
              .catch(() => toast.error("Could not create note"));
          }}
        >
          <Icon name="Plus" />
        </Button>
      </TipButton>
    </TooltipProvider>
  );
}

function ThreadNotesPanel({ threadId }: { threadId: string; params: unknown }) {
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { notes } = useNotes({ threadId });

  const capture = async () => {
    const body = draft.trim();
    if (!body || saving) return;
    setSaving(true);
    try {
      await rpc.call("createNote", { body, originThreadId: threadId });
      setDraft("");
      toast.success("Note saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save note");
    } finally {
      setSaving(false);
    }
  };

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-2.5 focus-within:ring-1 focus-within:ring-ring">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void capture();
              }
            }}
            placeholder="Jot a note for this thread…"
            rows={3}
            className="min-h-0 resize-none border-none p-1 text-sm shadow-none focus-visible:ring-0"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">Markdown · ⌘↵ to save</span>
            <Button size="sm" className="h-7" disabled={draft.trim() === "" || saving} onClick={() => void capture()}>
              Save note
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between px-0.5">
          <span className="text-xs font-medium text-muted-foreground">From this thread</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
            onClick={() => nav.toPluginPanel(PANEL_PATH)}
          >
            All notes
            <Icon name="ArrowUpRight" className="size-3" />
          </Button>
        </div>

        <div className="flex flex-col gap-1.5">
          {notes === null ? null : notes.length === 0 ? (
            <p className="py-3 text-center text-xs text-muted-foreground">
              Notes you capture here stay linked to this thread.
            </p>
          ) : (
            notes.map((note) => (
              <div key={note.id} className="rounded-md border border-border">
                <div className="flex items-center gap-1 px-2 py-1.5">
                  <button
                    type="button"
                    aria-expanded={expandedId === note.id}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
                    onClick={() => setExpandedId(expandedId === note.id ? null : note.id)}
                  >
                    <Icon
                      name="ChevronRight"
                      className={cn(
                        "size-3 shrink-0 text-muted-foreground transition-transform",
                        expandedId === note.id && "rotate-90",
                      )}
                    />
                    {note.pinned ? <Icon name="Pin" className="size-3 shrink-0 text-muted-foreground" /> : null}
                    <span className="min-w-0 flex-1 truncate text-sm">{note.title}</span>
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {relativeTime(note.updatedAt)}
                    </span>
                  </button>
                  <TipButton tip="Open in Notes">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 shrink-0"
                      aria-label="Open in Notes"
                      onClick={() => nav.toPluginPanel(PANEL_PATH, { subPath: note.id })}
                    >
                      <Icon name="ExternalLink" className="size-3.5" />
                    </Button>
                  </TipButton>
                </div>
                {expandedId === note.id ? (
                  <div className="border-t border-border p-3">
                    <Markdown content={note.body} />
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}

function ThreadHeaderNotesButton() {
  const nav = useBbNavigate();
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7"
      aria-label="Notes"
      onClick={() => nav.openThreadPanel({ actionId: THREAD_PANEL_ACTION_ID, title: "Notes" })}
    >
      <NotesGlyph />
    </Button>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "notes",
    title: "Notes",
    icon: "FileText",
    path: PANEL_PATH,
    component: NotesNavPanel,
    headerContent: NotesHeaderContent,
  });

  app.slots.threadPanelAction({
    id: THREAD_PANEL_ACTION_ID,
    title: "Notes",
    icon: "FileText",
    component: ThreadNotesPanel,
  });

  app.slots.experimental_threadHeaderAction({
    id: "notes-shortcut",
    title: "Notes",
    component: ThreadHeaderNotesButton,
  });

  app.slots.messageAction({
    id: "save-note",
    title: "Save as note",
    icon: "FileText",
    async run({ threadId, message, selectedText, openPanel }) {
      const body = (selectedText ?? message.text).trim();
      if (!body) {
        toast.error("Nothing to save from this message");
        return;
      }
      try {
        await rpcFetch("createNote", { body, originThreadId: threadId });
        toast.success(selectedText ? "Selection saved as note" : "Message saved as note");
        openPanel({ actionId: THREAD_PANEL_ACTION_ID, title: "Notes" });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not save note");
      }
    },
  });
});
