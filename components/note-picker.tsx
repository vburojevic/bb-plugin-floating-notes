// The composer's "Insert note" picker: search, pick, the note's markdown
// lands in the draft. Rendered by the content-script root so it can appear
// over any composer, while the plus-menu item only hands us the composer API.
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { controller, type ComposerInsertTarget } from "@/lib/controller";
import { useNotesState } from "@/lib/hooks";
import { cn } from "@/lib/utils";

export function NotePicker({ target }: { target: ComposerInsertTarget }) {
  const { notes } = useNotesState();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return notes
      .filter(
        (note) =>
          needle.length === 0 ||
          note.title.toLowerCase().includes(needle) ||
          note.body.toLowerCase().includes(needle),
      )
      .slice(0, 12);
  }, [notes, query]);

  useEffect(() => setIndex(0), [query]);
  const active = Math.min(index, Math.max(0, rows.length - 1));

  const close = () => controller.closeNotePicker();

  const pick = (noteIndex: number) => {
    const note = rows[noteIndex];
    if (note === undefined) return;
    close();
    try {
      target.insertText(note.body);
      toast.success(`“${note.title}” inserted into the draft`);
    } catch {
      toast.error("Could not reach the composer — is it still open?");
    }
  };

  return (
    <>
      <div className="bb-fn-overlay-backdrop" onPointerDown={close} aria-hidden="true" />
      <div className="bb-fn-overlay" role="dialog" aria-modal="true" aria-label="Insert note">
        <div
          className="overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((current) => Math.min(current + 1, rows.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((current) => Math.max(current - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              pick(active);
            }
          }}
        >
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Insert which note?"
            aria-label="Search notes to insert"
            className="h-10 rounded-none border-0 border-b border-border text-sm focus-visible:ring-0"
          />
          <div className="bb-fn-quiet-scroll max-h-72 overflow-y-auto p-1">
            {rows.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                No matching notes.
              </p>
            ) : (
              rows.map((note, rowIndex) => (
                <button
                  key={note.id}
                  type="button"
                  onClick={() => pick(rowIndex)}
                  onPointerEnter={() => setIndex(rowIndex)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm",
                    rowIndex === active ? "bg-accent text-accent-foreground" : "",
                  )}
                >
                  <Icon
                    name="FileText"
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate">{note.title}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {note.body.length > 400 ? "long" : ""}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </>
  );
}
