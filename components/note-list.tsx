// The note list: Inbox/Today smart rows, then scope sections — Pinned, your
// notes, thread scratchpads, daily notes — so a row's reach is never a
// mystery. Search and tag filters flatten to results with per-row context
// labels. Shared by the floating window and the nav panel, so the vocabulary
// never shifts between surfaces.
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon, type IconName } from "@/components/ui/icon";
import { ProgressRing } from "@/components/progress-ring";
import { highlightRuns, snippetFromBody } from "@/lib/notes";
import type { ListedNote, TagCount } from "@/lib/contract";
import { cn } from "@/lib/utils";

/** FTS snippet sentinels (char(1) opens a hit, char(2) closes it). */
const MATCH_OPEN = String.fromCharCode(1);
const MATCH_CLOSE = String.fromCharCode(2);
const MATCH_SPLIT = new RegExp(`([${MATCH_OPEN}${MATCH_CLOSE}])`);

function MatchSnippet({ snippet }: { snippet: string }) {
  const parts = useMemo(() => snippet.split(MATCH_SPLIT), [snippet]);
  let matched = false;
  return (
    <>
      {parts.map((part, index) => {
        if (part === MATCH_OPEN) {
          matched = true;
          return null;
        }
        if (part === MATCH_CLOSE) {
          matched = false;
          return null;
        }
        if (part === "") return null;
        return matched ? (
          <span key={index} className="bb-fn-match">
            {part}
          </span>
        ) : (
          <span key={index}>{part}</span>
        );
      })}
    </>
  );
}

/** LIKE-fallback highlighting: alternate plain/matched runs. */
function QueryRuns({ text, query }: { text: string; query: string }) {
  const runs = useMemo(() => highlightRuns(text, query), [text, query]);
  return (
    <>
      {runs.map((run, index) =>
        index % 2 === 1 ? (
          <span key={index} className="bb-fn-match">
            {run}
          </span>
        ) : (
          <span key={index}>{run}</span>
        ),
      )}
    </>
  );
}

const KIND_ICON: Partial<Record<ListedNote["kind"], IconName>> = {
  daily: "Calendar",
  scratchpad: "MessageSquare",
  inbox: "Archive",
};

/** What the row is called: a scratchpad is named for its thread. */
export function displayTitle(note: ListedNote): string {
  if (note.kind === "scratchpad" && note.threadTitle !== null) {
    return note.threadTitle;
  }
  return note.title;
}

/**
 * The scope line under the title. In sectioned mode the section header
 * already says "scratchpad"/"daily", so only cross-scope facts (a captured
 * note's origin thread) show; flat mode (search results) labels everything.
 */
function contextLabel(note: ListedNote, flat: boolean): string | null {
  if (note.kind === "scratchpad") {
    return flat ? "Thread scratchpad" : null;
  }
  if (note.kind === "daily") return flat ? "Daily note" : null;
  if (note.kind === "inbox") return flat ? "Inbox" : null;
  if (note.threadTitle !== null) return `from ${note.threadTitle}`;
  return null;
}

function NoteRow({
  note,
  query,
  flat,
  selected,
  trashView,
  onSelect,
  onRestore,
  onPurge,
}: {
  note: ListedNote;
  query: string;
  flat: boolean;
  selected: boolean;
  trashView: boolean;
  onSelect: (id: string) => void;
  onRestore?: (id: string) => void;
  onPurge?: (id: string) => void;
}) {
  const kindIcon = KIND_ICON[note.kind];
  const snippet = note.matchSnippet ?? snippetFromBody(note.body);
  const context = contextLabel(note, flat);
  const title = displayTitle(note);
  return (
    // A div with button semantics, not a <button>: trash rows nest real
    // buttons (Restore / Delete forever), and interactive content inside a
    // button is invalid DOM with browser-dependent click behavior.
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(note.id)}
      onKeyDown={(event) => {
        // Only keys aimed at the row itself: the trash rows nest real
        // buttons whose Enter/Space must keep activating them.
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(note.id);
        }
      }}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "group flex w-full cursor-pointer flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {kindIcon !== undefined ? (
          <Icon
            name={kindIcon}
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
        ) : note.color !== null ? (
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              `bb-fn-tint-${note.color}`,
            )}
            style={{ background: "var(--bb-fn-dot)" }}
            aria-hidden
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {query.length > 0 && note.matchSnippet === null ? (
            <QueryRuns text={title} query={query} />
          ) : (
            title
          )}
        </span>
        <ProgressRing done={note.taskDone} total={note.taskTotal} />
        {note.pinned ? (
          <Icon name="Pin" className="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" />
        ) : null}
        {note.stickyOpen && !trashView ? (
          <Icon
            name="ArrowUpRight"
            className="size-3 shrink-0 text-muted-foreground"
            aria-label="Open as sticky"
          />
        ) : null}
      </span>
      {snippet.length > 0 || context !== null ? (
        <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">
          {note.matchSnippet !== null ? (
            <MatchSnippet snippet={snippet} />
          ) : query.length > 0 && snippet.length > 0 ? (
            <QueryRuns text={snippet} query={query} />
          ) : (
            snippet
          )}
          {context !== null ? (
            <span className="text-muted-foreground/70 italic">
              {snippet.length > 0 ? " · " : ""}
              {context}
            </span>
          ) : null}
        </span>
      ) : null}
      {trashView ? (
        <span className="mt-1 flex gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={(event) => {
              event.stopPropagation();
              onRestore?.(note.id);
            }}
          >
            Restore
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs text-destructive"
            onClick={(event) => {
              event.stopPropagation();
              onPurge?.(note.id);
            }}
          >
            Delete forever
          </Button>
        </span>
      ) : null}
    </div>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="px-2.5 pb-0.5 pt-2.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
      {label}
    </div>
  );
}

/** Inbox / Today: labeled destinations, not mystery icons. */
function SmartRow({
  icon,
  label,
  hint,
  active,
  onClick,
}: {
  icon: IconName;
  label: string;
  hint: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors",
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
    >
      <Icon name={icon} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex-1 font-medium">{label}</span>
    </button>
  );
}

export interface NoteListProps {
  notes: readonly ListedNote[];
  tags: readonly TagCount[];
  trashedCount: number;
  query: string;
  onQueryChange: (query: string) => void;
  activeTag: string | null;
  onTagChange: (tag: string | null) => void;
  view: "active" | "trash";
  onViewChange: (view: "active" | "trash") => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onOpenInbox: () => void;
  onOpenDaily: () => void;
  onRestore: (id: string) => void;
  onPurge: (id: string) => void;
  onEmptyTrash: () => void;
  /** Lets the window's ⌘F land in this list's search field. */
  searchInputRef?: React.Ref<HTMLInputElement>;
  className?: string;
}

export function NoteList({
  notes,
  tags,
  trashedCount,
  query,
  onQueryChange,
  activeTag,
  onTagChange,
  view,
  onViewChange,
  selectedId,
  onSelect,
  onNew,
  onOpenInbox,
  onOpenDaily,
  onRestore,
  onPurge,
  onEmptyTrash,
  searchInputRef,
  className,
}: NoteListProps) {
  const trashView = view === "trash";
  const topTags = tags.slice(0, 8);
  /** Sections only apply to the untouched active list; anything filtered is flat. */
  const sectioned =
    !trashView && query.trim().length === 0 && activeTag === null;

  const groups = useMemo(() => {
    if (!sectioned) return null;
    const pinned = notes.filter((note) => note.pinned);
    const rest = notes.filter((note) => !note.pinned);
    return {
      pinned,
      inbox: rest.find((note) => note.kind === "inbox") ?? null,
      plain: rest.filter((note) => note.kind === "note"),
      scratchpads: rest.filter((note) => note.kind === "scratchpad"),
      daily: rest.filter((note) => note.kind === "daily"),
    };
  }, [sectioned, notes]);

  const rowProps = {
    query,
    trashView,
    onSelect,
    onRestore,
    onPurge,
  };

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex shrink-0 items-center gap-1.5 p-2 pb-1.5">
        <div className="relative min-w-0 flex-1">
          <Icon
            name="Search"
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            ref={searchInputRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={trashView ? "Search trash…" : "Search notes…"}
            aria-label="Search notes"
            className="bb-fn-input h-8 pl-7 text-sm"
          />
        </div>
        {!trashView ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            onClick={onNew}
            aria-label="New note (⌘N)"
          >
            <Icon name="Plus" className="size-4" aria-label="New note" />
          </Button>
        ) : null}
      </div>

      {!trashView && topTags.length > 0 ? (
        <div className="flex shrink-0 flex-wrap gap-1 px-2 pb-1.5">
          {topTags.map((tag) => (
            <button
              key={tag.name}
              type="button"
              onClick={() => onTagChange(activeTag === tag.name ? null : tag.name)}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[11px] leading-4 transition-colors",
                activeTag === tag.name
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:bg-accent",
              )}
            >
              #{tag.name}
            </button>
          ))}
        </div>
      ) : null}

      <div className="bb-fn-quiet-scroll min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
        {groups !== null ? (
          <>
            <SmartRow
              icon="Archive"
              label="Inbox"
              hint="Everything quick capture collects"
              active={groups.inbox !== null && groups.inbox.id === selectedId}
              onClick={onOpenInbox}
            />
            <SmartRow
              icon="Calendar"
              label="Today"
              hint="Today's daily note"
              active={false}
              onClick={onOpenDaily}
            />
            {groups.pinned.length > 0 ? (
              <>
                <SectionHeader label="Pinned" />
                {groups.pinned.map((note) => (
                  <NoteRow
                    key={note.id}
                    note={note}
                    flat={false}
                    selected={note.id === selectedId}
                    {...rowProps}
                  />
                ))}
              </>
            ) : null}
            {groups.plain.length > 0 ? (
              <>
                <SectionHeader label="Notes" />
                {groups.plain.map((note) => (
                  <NoteRow
                    key={note.id}
                    note={note}
                    flat={false}
                    selected={note.id === selectedId}
                    {...rowProps}
                  />
                ))}
              </>
            ) : null}
            {groups.scratchpads.length > 0 ? (
              <>
                <SectionHeader label="Thread scratchpads" />
                {groups.scratchpads.map((note) => (
                  <NoteRow
                    key={note.id}
                    note={note}
                    flat={false}
                    selected={note.id === selectedId}
                    {...rowProps}
                  />
                ))}
              </>
            ) : null}
            {groups.daily.length > 0 ? (
              <>
                <SectionHeader label="Daily notes" />
                {groups.daily.map((note) => (
                  <NoteRow
                    key={note.id}
                    note={note}
                    flat={false}
                    selected={note.id === selectedId}
                    {...rowProps}
                  />
                ))}
              </>
            ) : null}
            {notes.length === 0 ? (
              <div className="flex flex-col items-center gap-1 px-4 py-8 text-center">
                <p className="text-sm text-muted-foreground">No notes yet.</p>
                <p className="text-xs text-muted-foreground/70">
                  ⌘N starts one · Ctrl+&apos; toggles this window
                </p>
              </div>
            ) : null}
          </>
        ) : notes.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
            <p className="text-sm text-muted-foreground">
              {trashView ? "Trash is empty." : "No matching notes."}
            </p>
          </div>
        ) : (
          notes.map((note) => (
            <NoteRow
              key={note.id}
              note={note}
              flat
              selected={note.id === selectedId}
              {...rowProps}
            />
          ))
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-border px-2 py-1.5">
        <button
          type="button"
          onClick={() => onViewChange(trashView ? "active" : "trash")}
          className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <Icon name={trashView ? "ChevronLeft" : "Trash2"} className="size-3.5" aria-hidden />
          {trashView ? "Back to notes" : `Trash${trashedCount > 0 ? ` (${trashedCount})` : ""}`}
        </button>
        {trashView && trashedCount > 0 ? (
          <button
            type="button"
            onClick={onEmptyTrash}
            className="text-xs text-destructive transition-colors hover:underline"
          >
            Empty trash
          </button>
        ) : null}
      </div>
    </div>
  );
}
