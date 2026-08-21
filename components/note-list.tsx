// The note list: search, tag chips, rows, trash view. Shared by the floating
// window's sidebar and the nav panel, so the vocabulary never shifts between
// surfaces.
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
  scratchpad: "FileText",
  inbox: "Archive",
};

function NoteRow({
  note,
  query,
  selected,
  trashView,
  onSelect,
  onRestore,
  onPurge,
}: {
  note: ListedNote;
  query: string;
  selected: boolean;
  trashView: boolean;
  onSelect: (id: string) => void;
  onRestore?: (id: string) => void;
  onPurge?: (id: string) => void;
}) {
  const kindIcon = KIND_ICON[note.kind];
  const snippet = note.matchSnippet ?? snippetFromBody(note.body);
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
            <QueryRuns text={note.title} query={query} />
          ) : (
            note.title
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
      {snippet.length > 0 ? (
        <span className="line-clamp-2 pl-0 text-xs leading-snug text-muted-foreground">
          {note.matchSnippet !== null ? (
            <MatchSnippet snippet={snippet} />
          ) : query.length > 0 ? (
            <QueryRuns text={snippet} query={query} />
          ) : (
            snippet
          )}
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
  onRestore,
  onPurge,
  onEmptyTrash,
  searchInputRef,
  className,
}: NoteListProps) {
  const trashView = view === "trash";
  const topTags = tags.slice(0, 8);
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
            className="h-8 pl-7 text-sm"
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
        {notes.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
            <p className="text-sm text-muted-foreground">
              {trashView
                ? "Trash is empty."
                : query.length > 0 || activeTag !== null
                  ? "No matching notes."
                  : "No notes yet."}
            </p>
            {!trashView && query.length === 0 && activeTag === null ? (
              <p className="text-xs text-muted-foreground/70">
                ⌘N starts one · Ctrl+&apos; toggles this window
              </p>
            ) : null}
          </div>
        ) : (
          notes.map((note) => (
            <NoteRow
              key={note.id}
              note={note}
              query={query}
              selected={note.id === selectedId}
              trashView={trashView}
              onSelect={onSelect}
              onRestore={onRestore}
              onPurge={onPurge}
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
          <Icon name="Trash2" className="size-3.5" aria-hidden />
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
