// The in-window command palette: actions first, then notes by title.
// Hand-rolled (a filtered list and a roving index) — cmdk would be a
// dependency for what is one input and one <ul>.
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import type { ListedNote } from "@/lib/contract";
import { displayTitle } from "@/components/note-list";
import { cn } from "@/lib/utils";

export interface PaletteAction {
  id: string;
  label: string;
  icon?: IconName;
  hint?: string;
  run: () => void;
}

interface Row {
  key: string;
  label: string;
  icon?: IconName;
  hint?: string;
  run: () => void;
}

const MAX_NOTE_ROWS = 8;

export function Palette({
  actions,
  notes,
  onOpenNote,
  onClose,
}: {
  actions: PaletteAction[];
  notes: readonly ListedNote[];
  onOpenNote: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const rows = useMemo((): Row[] => {
    const needle = query.trim().toLowerCase();
    const actionRows: Row[] = actions
      .filter((action) => needle.length === 0 || action.label.toLowerCase().includes(needle))
      .map((action) => ({
        key: `action:${action.id}`,
        label: action.label,
        icon: action.icon,
        hint: action.hint,
        run: action.run,
      }));
    const noteRows: Row[] = notes
      .filter(
        (note) =>
          needle.length === 0 ||
          displayTitle(note).toLowerCase().includes(needle),
      )
      .slice(0, MAX_NOTE_ROWS)
      .map((note) => ({
        key: `note:${note.id}`,
        label: displayTitle(note),
        icon: (note.kind === "scratchpad" ? "MessageSquare" : "FileText") as IconName,
        run: () => onOpenNote(note.id),
      }));
    return [...actionRows, ...noteRows];
  }, [query, actions, notes, onOpenNote]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  const active = Math.min(index, Math.max(0, rows.length - 1));

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((current) => Math.min(current + 1, rows.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[active];
      if (row !== undefined) {
        onClose();
        row.run();
      }
    }
  };

  return (
    <div className="bb-fn-palette" onPointerDown={onClose}>
      <div
        className="w-full max-w-md overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl"
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <Input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Type a command or a note title…"
          aria-label="Command palette"
          className="h-10 rounded-none border-0 border-b border-border text-sm focus-visible:ring-0"
        />
        <div className="bb-fn-quiet-scroll max-h-64 overflow-y-auto p-1">
          {rows.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              Nothing matches.
            </p>
          ) : (
            rows.map((row, rowIndex) => (
              <button
                key={row.key}
                type="button"
                onClick={() => {
                  onClose();
                  row.run();
                }}
                onPointerEnter={() => setIndex(rowIndex)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm",
                  rowIndex === active ? "bg-accent text-accent-foreground" : "",
                )}
              >
                {row.icon !== undefined ? (
                  <Icon name={row.icon} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                ) : null}
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                {row.hint !== undefined ? (
                  <span className="shrink-0 text-[11px] text-muted-foreground">{row.hint}</span>
                ) : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
