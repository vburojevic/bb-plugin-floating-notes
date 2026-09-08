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
import { displayTitle, SCOPE_ICON } from "@/components/note-list";
import { noteScope } from "@/lib/scope";
import { cn } from "@/lib/utils";

const COLOR_LABEL: Record<NoteColor, string> = {
  yellow: "Yellow",
  mint: "Mint",
  sky: "Sky",
  rose: "Rose",
  lavender: "Lavender",
  peach: "Peach",
};

/**
 * A title-bar control. Always rendered — the old `opacity-0` until hover hid
 * half the bar at rest and made those controls unreachable entirely on a
 * touch screen, where there is no hover. They sit dimmed instead and come up
 * to full strength with the pointer or keyboard focus.
 */
function BarButton({
  icon,
  label,
  onClick,
  className,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-no-drag=""
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "bb-fn-bar-button flex size-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-foreground/10",
        className,
      )}
    >
      <Icon name={icon} className="size-3.5" aria-hidden />
    </button>
  );
}

const GHOST_KEY_PREFIX = "bb-plugin-notes:ghost:";

export function StickyNote({ note, index }: { note: ListedNote; index: number }) {
  const { rootRef, handleRef, resizeEdges } = useFloatingFrame({
    frameKey: `sticky:${note.id}`,
    profile: STICKY_PROFILE,
    fallback: () => defaultStickyFrame(index),
    active: true,
    skipHeight: note.collapsed,
    snap: true,
  });

  // Reference mode: translucent and read-only until hovered — a checklist
  // that overlays the agent's output without stealing clicks. Client-side
  // preference, per sticky.
  const [ghost, setGhost] = useState(() => {
    try {
      return window.localStorage.getItem(GHOST_KEY_PREFIX + note.id) === "1";
    } catch {
      return false;
    }
  });
  const toggleGhost = () => {
    setGhost((current) => {
      const next = !current;
      try {
        if (next) window.localStorage.setItem(GHOST_KEY_PREFIX + note.id, "1");
        else window.localStorage.removeItem(GHOST_KEY_PREFIX + note.id);
      } catch {
        // Preference only.
      }
      return next;
    });
  };

  // A freshly inserted element has no previous value to transition from.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const raf = window.requestAnimationFrame(() => setArmed(true));
    return () => window.cancelAnimationFrame(raf);
  }, []);

  const scope = noteScope(note);
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
      aria-label={`Sticky note: ${displayTitle(note)}`}
      data-state={armed ? "open" : "closed"}
      data-collapsed={note.collapsed ? "true" : "false"}
      data-scope={scope.kind}
      className={cn(
        "bb-fn-sticky fixed flex flex-col overflow-hidden rounded-lg border border-border text-card-foreground shadow-xl",
        note.color !== null ? `bb-fn-tint-${note.color}` : "",
        ghost && !note.collapsed ? "bb-fn-ghost" : "",
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
              title={note.color === null ? "Set a colour" : "Change colour"}
              aria-label="Sticky color"
              className="bb-fn-bar-button flex size-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-foreground/10"
            >
              {note.color === null ? (
                <Icon name="Palette" className="size-3.5" aria-hidden />
              ) : (
                <span className={cn("bb-fn-swatch", `bb-fn-tint-${note.color}`)} aria-hidden />
              )}
            </button>
          </DropdownMenuTrigger>
          {/* z-[68]: the vendored menu portals to body at z-50, underneath
              the floating surfaces' [53,64] band — it must clear them. */}
          <DropdownMenuContent align="start" data-no-drag="" style={{ zIndex: 68 }}>
            {noteColorSchema.options.map((color) => (
              <DropdownMenuItem
                key={color}
                onSelect={() => void notesStore.updateNote({ id: note.id, color })}
              >
                <span className={cn("bb-fn-swatch", `bb-fn-tint-${color}`)} aria-hidden />
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
            <DropdownMenuSeparator />
            {note.pinnedThreadId !== null || note.pinnedProjectId !== null ? (
              <DropdownMenuItem
                onSelect={() =>
                  void notesStore.updateNote({
                    id: note.id,
                    pinnedThreadId: null,
                    pinnedProjectId: null,
                  })
                }
              >
                <Icon name="PinOff" className="size-3.5" aria-hidden />
                Unpin (float everywhere)
              </DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuItem onSelect={togglePin}>
                  <Icon name="Pin" className="size-3.5" aria-hidden />
                  Pin to this thread
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    const thread = controller.activeThread();
                    if (thread === null || thread.projectId === null) {
                      toast.error("Open a project thread first.");
                      return;
                    }
                    void notesStore.updateNote({
                      id: note.id,
                      pinnedProjectId: thread.projectId,
                    });
                    toast.success("Sticky pinned to this project");
                  }}
                >
                  <Icon name="FolderGit" className="size-3.5" aria-hidden />
                  Pin to this project
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuItem onSelect={toggleGhost}>
              <Icon name="Layers" className="size-3.5" aria-hidden />
              {ghost ? "Full opacity" : "Reference mode"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                void notesStore.trashNote(note.id);
                toast.success("Moved to trash");
              }}
            >
              <Icon name="Trash2" className="size-3.5" aria-hidden />
              Move to trash
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Icon
          name={SCOPE_ICON[scope.kind]}
          className="size-3 shrink-0 opacity-70"
          aria-hidden
        />
        <span
          className="min-w-0 flex-1 truncate text-xs font-medium"
          title={`${displayTitle(note)} — ${scope.label}`}
        >
          {displayTitle(note)}
        </span>

        <ProgressRing done={note.taskDone} total={note.taskTotal} />

        <BarButton
          icon={pinned ? "Pin" : "PinOff"}
          label={
            pinned
              ? note.threadTitle !== null
                ? `Pinned to “${note.threadTitle}” — click to unpin`
                : "Unpin from thread"
              : "Pin to current thread"
          }
          onClick={togglePin}
          className={pinned ? "text-primary" : ""}
        />
        <BarButton
          icon="AppWindow"
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
