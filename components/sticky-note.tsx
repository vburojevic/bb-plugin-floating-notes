// One sticky: a small floating card with a tinted title bar and the editor.
//
// The bar is the drag handle; double-click collapses to just the bar. The pin
// button binds the sticky to the thread you are looking at, which is what
// makes it a spatial note: it only renders while that thread is on screen
// (the root component filters on the controller's visible-thread registry).
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { ProgressRing } from "@/components/progress-ring";
import { NoteEditor } from "@/components/note-editor";
import { useFloatingFrame } from "@/components/use-floating-frame";
import { controller } from "@/lib/controller";
import { notesStore } from "@/lib/store";
import { defaultStickyFrame, STICKY_PROFILE } from "@/lib/frame";
import { noteColorSchema, type ListedNote, type NoteColor } from "@/lib/contract";
import { cn } from "@/lib/utils";

const COLOR_LABEL: Record<NoteColor, string> = {
  yellow: "Yellow",
  mint: "Mint",
  sky: "Sky",
  rose: "Rose",
  lavender: "Lavender",
  peach: "Peach",
};

function BarButton({
  icon,
  label,
  onClick,
  className,
  subtle = true,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  onClick: () => void;
  className?: string;
  subtle?: boolean;
}) {
  return (
    <button
      type="button"
      data-no-drag=""
      title={label}
      onClick={onClick}
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-foreground/10",
        subtle ? "opacity-0 group-hover/bar:opacity-100 focus-visible:opacity-100" : "",
        className,
      )}
    >
      <Icon name={icon} className="size-3.5" aria-label={label} />
    </button>
  );
}

export function StickyNote({ note, index }: { note: ListedNote; index: number }) {
  const { rootRef, handleRef, resizeEdges } = useFloatingFrame({
    frameKey: `sticky:${note.id}`,
    profile: STICKY_PROFILE,
    fallback: () => defaultStickyFrame(index),
    active: true,
    skipHeight: note.collapsed,
  });

  // A freshly inserted element has no previous value to transition from.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const raf = window.requestAnimationFrame(() => setArmed(true));
    return () => window.cancelAnimationFrame(raf);
  }, []);

  const pinned = note.pinnedThreadId !== null;

  const togglePin = () => {
    if (pinned) {
      void notesStore.updateNote({ id: note.id, pinnedThreadId: null });
      return;
    }
    const thread = controller.activeThread();
    if (thread === null) {
      toast.error("Open a thread first — the sticky pins to the thread on screen.");
      return;
    }
    void notesStore.updateNote({ id: note.id, pinnedThreadId: thread.threadId });
    toast.success("Sticky pinned to this thread");
  };

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="false"
      aria-label={`Sticky note: ${note.title}`}
      data-state={armed ? "open" : "closed"}
      data-collapsed={note.collapsed ? "true" : "false"}
      className={cn(
        "bb-fn-sticky fixed flex flex-col overflow-hidden rounded-lg border border-border text-card-foreground shadow-xl",
        note.color !== null ? `bb-fn-tint-${note.color}` : "",
      )}
    >
      <div
        ref={handleRef}
        onDoubleClick={(event) => {
          // Two fast clicks on a bar button are the button twice, not a
          // collapse request — same guard the drag handler uses.
          if ((event.target as HTMLElement | null)?.closest("[data-no-drag]") != null) {
            return;
          }
          void notesStore.updateNote({ id: note.id, collapsed: !note.collapsed });
        }}
        className="bb-fn-sticky-bar group/bar flex shrink-0 cursor-grab items-center gap-1.5 border-b border-border/60 px-2 py-1.5 active:cursor-grabbing"
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-no-drag=""
              title="Color"
              className="flex size-4 shrink-0 items-center justify-center"
            >
              <span
                className="size-2.5 rounded-full border border-foreground/20"
                style={{
                  background:
                    note.color !== null ? "var(--bb-fn-dot)" : "transparent",
                }}
                aria-label="Sticky color"
              />
            </button>
          </DropdownMenuTrigger>
          {/* z-[68]: the vendored menu portals to body at z-50, underneath
              the floating surfaces' [53,64] band — it must clear them. */}
          <DropdownMenuContent align="start" data-no-drag="" className="z-[68]">
            {noteColorSchema.options.map((color) => (
              <DropdownMenuItem
                key={color}
                onSelect={() => void notesStore.updateNote({ id: note.id, color })}
              >
                <span
                  className={cn("size-2.5 rounded-full", `bb-fn-tint-${color}`)}
                  style={{ background: "var(--bb-fn-dot)" }}
                  aria-hidden
                />
                {COLOR_LABEL[color]}
                {note.color === color ? (
                  <Icon name="Check" className="ml-auto size-3.5" aria-hidden />
                ) : null}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => void notesStore.updateNote({ id: note.id, color: null })}
            >
              No color
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {note.title}
        </span>

        <ProgressRing done={note.taskDone} total={note.taskTotal} />

        <BarButton
          icon={pinned ? "Pin" : "PinOff"}
          label={pinned ? "Unpin from thread" : "Pin to current thread"}
          onClick={togglePin}
          subtle={!pinned}
          className={pinned ? "text-primary" : ""}
        />
        <BarButton
          icon="Maximize2"
          label="Open in notes window"
          onClick={() => controller.showWindow(note.id)}
        />
        <BarButton
          icon={note.collapsed ? "Maximize2" : "Minimize2"}
          label={note.collapsed ? "Expand" : "Collapse to bar"}
          onClick={() =>
            void notesStore.updateNote({ id: note.id, collapsed: !note.collapsed })
          }
        />
        <BarButton
          icon="X"
          label="Close sticky"
          subtle={false}
          onClick={() => void notesStore.updateNote({ id: note.id, stickyOpen: false })}
        />
      </div>

      <div className="bb-fn-sticky-body flex min-h-0 flex-1 flex-col">
        <NoteEditor note={note} placeholder="Jot…" />
      </div>

      {note.collapsed ? null : resizeEdges}
    </div>
  );
}
