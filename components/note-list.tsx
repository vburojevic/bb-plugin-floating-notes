// The note list: smart rows for the singletons, then one section per scope —
// each project by name, then global notes, thread scratchpads and daily
// notes. Every row carries a scope glyph and a tinted left edge, so "is this
// a project note or a global one" is answered at a glance rather than by
// reading. Search and tag filters flatten the list to ranked results, where
// each row spells its scope out instead of relying on its section.
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon, type IconName } from "@/components/ui/icon";
import { ProgressRing } from "@/components/progress-ring";
import { highlightRuns, localDateKey, snippetFromBody } from "@/lib/notes";
import {
  groupNotesByScope,
  matchesScopeFilter,
  noteScope,
  projectsInNotes,
  type ScopeFilter,
  type ScopeKind,
} from "@/lib/scope";
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

/** One glyph per scope family — the same glyph the section header uses. */
export const SCOPE_ICON: Record<ScopeKind, IconName> = {
  project: "FolderGit",
  thread: "MessageSquare",
  scratchpad: "MessageSquare",
  daily: "Calendar",
  inbox: "Archive",
  global: "Globe",
};

const SCOPE_CLASS: Record<ScopeKind, string> = {
  project: "bb-fn-scope-project",
  thread: "bb-fn-scope-thread",
  scratchpad: "bb-fn-scope-thread",
  daily: "bb-fn-scope-daily",
  inbox: "bb-fn-scope-inbox",
  global: "bb-fn-scope-global",
};

/** What the row is called: a scratchpad is named for its thread. */
export function displayTitle(note: ListedNote): string {
  if (note.kind === "scratchpad" && note.threadTitle !== null) {
    return note.threadTitle;
  }
  return note.title;
}

function NoteRow({
  note,
  query,
  showScope,
  selected,
  trashView,
  onSelect,
  onRestore,
  onPurge,
}: {
  note: ListedNote;
  query: string;
  /** Flat results name their scope; sectioned rows inherit it from the header. */
  showScope: boolean;
  selected: boolean;
  trashView: boolean;
  onSelect: (id: string) => void;
  onRestore?: (id: string) => void;
  onPurge?: (id: string) => void;
}) {
  const scope = noteScope(note);
  const snippet = note.matchSnippet ?? snippetFromBody(note.body);
  const title = displayTitle(note);
  return (
    // A div with button semantics, not a <button>: trash rows nest real
    // buttons (Restore / Delete forever), and interactive content inside a
    // button is invalid DOM with browser-dependent click behavior.
    <div
      role="button"
      tabIndex={0}
      data-scope={scope.kind}
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
        "bb-fn-row group flex w-full cursor-pointer flex-col gap-0.5 rounded-r-lg py-1.5 pl-2 pr-2.5 text-left transition-colors",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon
          name={SCOPE_ICON[scope.kind]}
          className={cn("size-3.5 shrink-0", SCOPE_CLASS[scope.kind])}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {query.length > 0 && note.matchSnippet === null ? (
            <QueryRuns text={title} query={query} />
          ) : (
            title
          )}
        </span>
        {note.color !== null ? (
          <span
            className={cn("size-2 shrink-0 rounded-full", `bb-fn-tint-${note.color}`)}
            style={{ background: "var(--bb-fn-dot)" }}
            aria-label="Note color"
          />
        ) : null}
        <ProgressRing done={note.taskDone} total={note.taskTotal} />
        {note.pinned ? (
          <Icon name="Pin" className="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" />
        ) : null}
        {note.stickyOpen && !trashView ? (
          <Icon
            name="ArrowUpRight"
            className="size-3 shrink-0 text-muted-foreground"
            aria-label="Open as a sticky"
          />
        ) : null}
      </span>
      {snippet.length > 0 || showScope ? (
        <span className="line-clamp-2 pl-5 text-xs leading-snug text-muted-foreground">
          {note.matchSnippet !== null ? (
            <MatchSnippet snippet={snippet} />
          ) : query.length > 0 && snippet.length > 0 ? (
            <QueryRuns text={snippet} query={query} />
          ) : (
            snippet
          )}
          {showScope ? (
            <span className={cn("italic", SCOPE_CLASS[scope.kind], "opacity-80")}>
              {snippet.length > 0 ? " · " : ""}
              {scope.label}
            </span>
          ) : null}
        </span>
      ) : null}
      {trashView ? (
        <span className="mt-1 flex gap-1 pl-5">
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

function SectionHeader({
  label,
  kind,
  count,
}: {
  label: string;
  kind: ScopeKind;
  count: number;
}) {
  return (
    <div className="bb-fn-section">
      <Icon
        name={SCOPE_ICON[kind]}
        className={cn("size-3", SCOPE_CLASS[kind])}
        aria-hidden
      />
      <span className="min-w-0 truncate">{label}</span>
      <span className="bb-fn-section-count">{count}</span>
    </div>
  );
}

/**
 * Inbox and Today: the two destinations that always exist, as a pair of
 * pills above the list. They are shortcuts, not rows — the inbox note is
 * deliberately kept out of the sections below so it never appears twice.
 */
function QuickRow({
  inboxActive,
  todayActive,
  onOpenInbox,
  onOpenDaily,
}: {
  inboxActive: boolean;
  todayActive: boolean;
  onOpenInbox: () => void;
  onOpenDaily: () => void;
}) {
  const pill = (
    icon: IconName,
    label: string,
    hint: string,
    active: boolean,
    onClick: () => void,
  ) => (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-md border py-1 text-xs font-medium transition-colors",
        active
          ? "border-transparent bg-accent text-accent-foreground"
          : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      <Icon name={icon} className="size-3.5 shrink-0" aria-hidden />
      {label}
    </button>
  );
  return (
    <div className="flex shrink-0 gap-1.5 px-2 pb-2">
      {pill("Archive", "Inbox", "Everything quick capture collects", inboxActive, onOpenInbox)}
      {pill("Calendar", "Today", "Today's daily note", todayActive, onOpenDaily)}
    </div>
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
  scopeFilter: ScopeFilter;
  onScopeFilterChange: (filter: ScopeFilter) => void;
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
  scopeFilter,
  onScopeFilterChange,
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
  const searching = query.trim().length > 0 || activeTag !== null;

  const visible = useMemo(
    () =>
      scopeFilter.kind === "all"
        ? notes
        : notes.filter((note) => matchesScopeFilter(note, scopeFilter)),
    [notes, scopeFilter],
  );

  /**
   * Sections only make sense for the unfiltered list; results stay flat.
   * The inbox note is excluded: its pill above is always visible, and a
   * one-row "INBOX" section under it was the same note listed twice.
   */
  const grouped = useMemo(
    () =>
      trashView || searching
        ? null
        : groupNotesByScope(visible.filter((note) => note.kind !== "inbox")),
    [trashView, searching, visible],
  );

  const projects = useMemo(() => projectsInNotes(notes), [notes]);
  const inboxNote = useMemo(
    () => notes.find((note) => note.kind === "inbox"),
    [notes],
  );
  const todayNote = useMemo(() => {
    const today = localDateKey(new Date());
    return notes.find((note) => note.kind === "daily" && note.dateKey === today);
  }, [notes]);
  const showScopeFilter = !trashView && (projects.length > 0 || notes.length > 6);

  const rowProps = { query, trashView, onSelect, onRestore, onPurge };

  const chip = (label: string, filter: ScopeFilter, key: string) => {
    const active =
      filter.kind === scopeFilter.kind &&
      (filter.kind !== "project" ||
        (scopeFilter.kind === "project" && scopeFilter.name === filter.name));
    return (
      <button
        key={key}
        type="button"
        className="bb-fn-chip"
        data-active={active ? "true" : "false"}
        onClick={() => onScopeFilterChange(active ? { kind: "all" } : filter)}
      >
        {label}
      </button>
    );
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

      {showScopeFilter ? (
        <div className="bb-fn-scope-filter">
          {chip("All", { kind: "all" }, "all")}
          {chip("Global", { kind: "global" }, "global")}
          {projects.map((name) =>
            chip(name, { kind: "project", name }, `project:${name}`),
          )}
          {chip("Threads", { kind: "threads" }, "threads")}
        </div>
      ) : null}

      {!trashView && topTags.length > 0 ? (
        <div className="flex shrink-0 flex-wrap gap-1 px-2 pb-1.5">
          {topTags.map((tag) => (
            <button
              key={tag.name}
              type="button"
              onClick={() => onTagChange(activeTag === tag.name ? null : tag.name)}
              className="bb-fn-chip"
              data-active={activeTag === tag.name ? "true" : "false"}
            >
              #{tag.name}
            </button>
          ))}
        </div>
      ) : null}

      {!trashView ? (
        <QuickRow
          inboxActive={inboxNote !== undefined && inboxNote.id === selectedId}
          todayActive={todayNote !== undefined && todayNote.id === selectedId}
          onOpenInbox={onOpenInbox}
          onOpenDaily={onOpenDaily}
        />
      ) : null}

      <div className="bb-fn-quiet-scroll min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
        {grouped !== null ? (
          <>
            {grouped.pinned.length > 0 ? (
              <>
                <SectionHeader label="Pinned" kind="global" count={grouped.pinned.length} />
                {grouped.pinned.map((note) => (
                  <NoteRow
                    key={note.id}
                    note={note}
                    showScope
                    selected={note.id === selectedId}
                    {...rowProps}
                  />
                ))}
              </>
            ) : null}
            {grouped.sections.map((section) => (
              <div key={section.key}>
                <SectionHeader
                  label={section.label}
                  kind={section.kind}
                  count={section.notes.length}
                />
                {section.notes.map((note) => (
                  <NoteRow
                    key={note.id}
                    note={note}
                    showScope={section.kind === "thread"}
                    selected={note.id === selectedId}
                    {...rowProps}
                  />
                ))}
              </div>
            ))}
            {visible.length === 0 ? (
              <div className="flex flex-col items-center gap-1 px-4 py-10 text-center">
                <p className="text-sm text-muted-foreground">
                  {scopeFilter.kind === "all"
                    ? "No notes yet."
                    : "Nothing in this scope."}
                </p>
                <p className="text-xs text-muted-foreground/70">
                  ⌘N starts one · Ctrl+&apos; toggles this window
                </p>
              </div>
            ) : null}
          </>
        ) : visible.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
            <p className="text-sm text-muted-foreground">
              {trashView ? "Trash is empty." : "No matching notes."}
            </p>
          </div>
        ) : (
          visible.map((note) => (
            <NoteRow
              key={note.id}
              note={note}
              showScope
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
