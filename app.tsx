// bb-plugin-notes — frontend entry.
//
// Registrations: a content script that mounts the floating surfaces (window,
// stickies, capture bar, note picker) into document.body; the sidebar footer
// toggle; the thread-header scratchpad button (which doubles as the
// visible-thread bridge for pinned stickies); two message actions; the
// composer's "Insert note" plus-menu item; and the rewritten nav + thread
// panels. Everything drives the same external controller and store, so the
// order the pieces mount in never matters.
import { createElement, useCallback, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { definePluginApp, useBbNavigate, useRealtime } from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { FloatingNotes } from "@/components/floating-notes";
import { NotesNavPanel } from "@/components/nav-panel";
import { ThreadNotesPanel } from "@/components/thread-panel";
import { controller } from "@/lib/controller";
import { useControllerState } from "@/lib/hooks";
import { notesStore } from "@/lib/store";
import "./styles.css";

/**
 * The scratchpad button in the thread header. Mounting is the signal: one
 * instance exists per visible thread, so registering on mount and
 * unregistering on unmount gives the controller an exact set of on-screen
 * threads — which is what pinned stickies and quick capture target.
 */
function ThreadHeaderNotesButton({
  threadId,
  projectId,
}: {
  threadId: string;
  projectId: string;
}) {
  useEffect(
    () => controller.registerThread(threadId, projectId),
    [threadId, projectId],
  );

  // This component doubles as the content script's bb-tree bridge: it
  // relays realtime "changed" events into the shared store, and executes
  // thread-navigation requests the floating surfaces cannot make themselves.
  useRealtime(
    "notes",
    useCallback(() => void notesStore.refresh(), []),
  );
  const navigate = useBbNavigate();
  const { navigateRequest } = useControllerState();
  useEffect(() => {
    if (navigateRequest === null) return;
    controller.consumeNavigation(navigateRequest.seq);
    navigate.toThread(navigateRequest.threadId);
  }, [navigateRequest, navigate]);

  // Stickies never render on compact viewports; there the button opens the
  // scratchpad in the sheet window instead of flipping invisible flags.
  const compact = useIsCompactViewport();

  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7"
      aria-label="Scratchpad — floats over this thread"
      onClick={async () => {
        try {
          const pad = await notesStore.scratchpad(threadId, projectId);
          if (compact) {
            controller.showWindow(pad.id);
            return;
          }
          // A toggle with feedback: clicking must always visibly do something.
          if (pad.stickyOpen && pad.pinnedThreadId === threadId) {
            await notesStore.updateNote({ id: pad.id, stickyOpen: false });
            toast.success("Scratchpad hidden");
          } else {
            await notesStore.updateNote({
              id: pad.id,
              stickyOpen: true,
              collapsed: false,
              pinnedThreadId: threadId,
            });
            toast.success("Scratchpad floating over this thread");
          }
        } catch (error) {
          toast.error(
            error instanceof Error ? error.message : "Could not open the scratchpad",
          );
        }
      }}
    >
      <Icon name="FileText" className="size-4" aria-label="Thread scratchpad" />
    </Button>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "floating-notes",
    mount({ signal }) {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      root.render(createElement(FloatingNotes));

      signal.addEventListener(
        "abort",
        () => {
          // Unmount off the current task: React refuses to unmount a root
          // while it is rendering, which is exactly when a reload can land.
          queueMicrotask(() => root.unmount());
          container.remove();
        },
        { once: true },
      );
    },
  });

  app.slots.sidebarFooterAction({
    id: "toggle",
    title: "Notes (Ctrl+')",
    icon: "FileText",
    run() {
      controller.toggleWindow();
    },
  });

  app.slots.navPanel({
    id: "notes",
    title: "Notes",
    icon: "FileText",
    path: "notes",
    component: NotesNavPanel,
  });

  app.slots.threadPanelAction({
    id: "thread-notes",
    title: "Notes",
    icon: "FileText",
    layout: "flush",
    component: ({ threadId }) => createElement(ThreadNotesPanel, { threadId }),
  });

  app.slots.experimental_threadHeaderAction({
    id: "scratchpad",
    title: "Scratchpad",
    component: ThreadHeaderNotesButton,
  });

  app.slots.messageAction({
    id: "save-note",
    title: "Save as note",
    icon: "FileText",
    async run({ threadId, message, selectedText }) {
      const body = (selectedText ?? message.text).trim();
      if (body.length === 0) {
        toast.error("Nothing to save from this message");
        return;
      }
      try {
        const note = await notesStore.createNote({
          body,
          originThreadId: threadId,
        });
        toast.success(
          selectedText !== undefined
            ? "Selection saved as a note"
            : "Message saved as a note",
        );
        controller.showWindow(note.id);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not save note");
      }
    },
  });

  // Deliberately ONE message action: bb brands plugin actions with the
  // plugin's logo (per-action icon hints are ignored when branding exists),
  // so a second action renders as an identical twin button. Scratchpad
  // appends live in quick capture (Tab), the thread panel, and the agent tool.

  app.composer.customize({
    id: "notes",
    plusMenu: [
      {
        id: "insert-note",
        label: "Insert note",
        icon: "FileText",
        description: "Paste one of your notes into the draft",
        run({ composer }) {
          controller.openNotePicker({
            insertText(text) {
              const current = composer.text;
              composer.setText(
                current.trim().length === 0 ? text : `${current}\n\n${text}`,
              );
              composer.focus();
            },
          });
        },
      },
    ],
  });
});
