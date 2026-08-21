// The thread's side-panel tab: the scratchpad on top, then every note that
// was captured from this thread.
import { useEffect, useMemo, useState } from "react";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { NoteEditor } from "@/components/note-editor";
import { ProgressRing } from "@/components/progress-ring";
import { controller } from "@/lib/controller";
import { useNotesState } from "@/lib/hooks";
import { notesStore } from "@/lib/store";
import { snippetFromBody } from "@/lib/notes";
import { displayTitle } from "@/components/note-list";
import type { ListedNote } from "@/lib/contract";

export function ThreadNotesPanel({ threadId }: { threadId: string }) {
  const { notes } = useNotesState();
  const [scratchpadId, setScratchpadId] = useState<string | null>(null);
  const compact = useIsCompactViewport();

  useEffect(() => {
    void notesStore.refresh();
    void notesStore
      .scratchpad(threadId)
      .then((note) => setScratchpadId(note.id))
      .catch(() => toast.error("Could not open the scratchpad"));
  }, [threadId]);

  const scratchpad = useMemo(
    (): ListedNote | null =>
      notes.find((note) => note.id === scratchpadId) ?? null,
    [notes, scratchpadId],
  );

  const threadNotes = useMemo(
    () =>
      notes.filter(
        (note) => note.originThreadId === threadId && note.kind === "note",
      ),
    [notes, threadId],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-[3] flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
          <Icon name="FileText" className="size-3.5 text-muted-foreground" aria-hidden />
          <span className="flex-1 text-xs font-medium">Scratchpad</span>
          {scratchpad !== null ? (
            <>
              <ProgressRing done={scratchpad.taskDone} total={scratchpad.taskTotal} />
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label={compact ? "Open in notes" : "Float over this thread"}
                onClick={() => {
                  // No stickies on compact viewports — open the sheet instead.
                  if (compact) {
                    controller.showWindow(scratchpad.id);
                    return;
                  }
                  void notesStore.updateNote({
                    id: scratchpad.id,
                    stickyOpen: true,
                    pinnedThreadId: threadId,
                  });
                  toast.success("Scratchpad floating over this thread");
                }}
              >
                <Icon name="ArrowUpRight" className="size-3.5" aria-label="Float" />
              </Button>
            </>
          ) : null}
        </div>
        {scratchpad === null ? (
          <p className="p-3 text-xs text-muted-foreground">Opening the scratchpad…</p>
        ) : (
          <NoteEditor note={scratchpad} placeholder="Notes for this thread…" />
        )}
      </div>

      <div className="flex min-h-0 flex-[2] flex-col border-t border-border">
        <div className="shrink-0 px-2 py-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Captured from this thread
          </span>
        </div>
        <div className="bb-fn-quiet-scroll min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
          {threadNotes.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              Nothing captured yet — use “Save as note” on any message.
            </p>
          ) : (
            threadNotes.map((note) => {
              const snippet = snippetFromBody(note.body);
              return (
                <button
                  key={note.id}
                  type="button"
                  onClick={() => controller.showWindow(note.id)}
                  className="flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left hover:bg-accent/50"
                >
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {displayTitle(note)}
                    </span>
                    <ProgressRing done={note.taskDone} total={note.taskTotal} />
                  </span>
                  {snippet.length > 0 ? (
                    <span className="line-clamp-1 text-xs text-muted-foreground">
                      {snippet}
                    </span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
