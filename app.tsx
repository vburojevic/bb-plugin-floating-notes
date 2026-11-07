// bb-plugin-notes — frontend entry.
//
// Registrations: a content script that mounts the floating surfaces (window,
// stickies, capture bar, note picker) into document.body; an app overlay that
// is the content script's bridge into bb's React tree; the sidebar footer
// toggle; the thread-header Scratchpad button (whose data hook doubles as the
// visible-thread bridge for pinned stickies); the "Save as note" message
// action; the composer's "Insert note" plus-menu item; and the nav panel and
// thread tab. Everything drives the same external controller and store, so
// the order the pieces mount in never matters.
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useSdk,
  type PluginThreadActionDataInput,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { FloatingNotes } from "@/components/floating-notes";
import { NotesNavPanel } from "@/components/nav-panel";
import { ThreadNotesPanel } from "@/components/thread-panel";
import { controller, type VisibleThread } from "@/lib/controller";
import { useControllerState, useNotesState } from "@/lib/hooks";
import { notesStore, setPluginId } from "@/lib/store";
import "./styles.css";

/**
 * The content script's bridge into bb's React tree, mounted once per app
 * window. It relays the server's realtime "changed" signal into the shared
 * store (so CLI and agent edits show up on every surface without polling),
 * catches up after a realtime reconnect, and executes thread-navigation
 * requests the floating surfaces cannot make themselves.
 */
function NotesBridge() {
  useRealtime(
    "notes",
    useCallback(() => void notesStore.refresh(), []),
  );

  // Signals published while the socket was down are lost: re-pull once it
  // comes back.
  const connection = useRealtimeConnectionState();
  const wasConnected = useRef(connection === "connected");
  useEffect(() => {
    if (connection === "connected" && !wasConnected.current) {
      void notesStore.refresh();
    }
    wasConnected.current = connection === "connected";
  }, [connection]);

  const navigate = useBbNavigate();
  const { navigateRequest } = useControllerState();
  useEffect(() => controller.registerNavigator(), []);
  useEffect(() => {
    if (navigateRequest === null) return;
    controller.consumeNavigation(navigateRequest.seq);
    navigate.toThread(navigateRequest.threadId);
  }, [navigateRequest, navigate]);

  return null;
}

/** Thread → project, resolved once per thread for project-pinned stickies. */
const threadProjects = new Map<string, string | null>();

interface HeaderData {
  /** Threads whose scratchpad currently floats over them. */
  floating: ReadonlySet<string>;
  compact: boolean;
}

/**
 * The Scratchpad header button's data hook, called once for the whole app
 * with the ids of every thread whose header is on screen. It publishes that
 * set (with each thread's project) to the controller, which is what pinned
 * stickies and quick capture target.
 */
function useHeaderData({ threadIds }: PluginThreadActionDataInput): HeaderData {
  const sdk = useSdk();
  const { threadId: focusedThreadId } = useBbContext();
  const [resolved, setResolved] = useState(0);

  useEffect(() => {
    const missing = threadIds.filter((id) => !threadProjects.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(
      missing.map(async (threadId) => {
        try {
          const thread = await sdk.threads.get({ threadId });
          threadProjects.set(threadId, thread.projectId ?? null);
        } catch {
          threadProjects.set(threadId, null);
        }
      }),
    ).then(() => {
      if (!cancelled) setResolved((count) => count + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [threadIds, sdk]);

  useEffect(() => {
    const visible: VisibleThread[] = threadIds.map((threadId) => ({
      threadId,
      projectId: threadProjects.get(threadId) ?? null,
    }));
    controller.setVisibleThreads(visible, focusedThreadId);
  }, [threadIds, focusedThreadId, resolved]);

  useEffect(() => () => controller.setVisibleThreads([]), []);

  const { notes } = useNotesState();
  const floating = useMemo(
    () =>
      new Set(
        notes
          .filter(
            (note) =>
              note.kind === "scratchpad" &&
              note.stickyOpen &&
              note.pinnedThreadId !== null &&
              note.pinnedThreadId === note.originThreadId,
          )
          .map((note) => note.pinnedThreadId!),
      ),
    [notes],
  );
  // Stickies never render on compact viewports; there the button opens the
  // scratchpad in the sheet window instead of flipping invisible flags.
  const compact = useIsCompactViewport();
  return useMemo(() => ({ floating, compact }), [floating, compact]);
}

async function toggleScratchpad(
  threadId: string,
  projectId: string,
  compact: boolean,
): Promise<void> {
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
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "floating-notes",
    mount({ signal, pluginId }) {
      // Route every RPC at the id bb actually installed us under.
      setPluginId(pluginId);
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

  app.slots.experimental_appOverlay({ id: "bridge", component: NotesBridge });

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

  // Same tab id as the retired threadPanelAction registration, so tabs
  // users already have open survive the move.
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "thread-notes",
    title: "Notes",
    icon: "FileText",
    layout: "flush",
    component: ({ threadId }) => createElement(ThreadNotesPanel, { threadId }),
  });

  app.slots.experimental_threadAction<HeaderData>({
    id: "scratchpad",
    title: "Scratchpad",
    icon: "FileText",
    group: "notes",
    placement: "header",
    useData: useHeaderData,
    item: ({ thread, data }) => {
      const floating = !data.compact && data.floating.has(thread.id);
      return {
        label: floating ? "Hide scratchpad" : "Scratchpad",
        icon: "FileText",
        run: () => toggleScratchpad(thread.id, thread.projectId, data.compact),
      };
    },
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
              // Its own paragraph after the draft; an empty draft takes it as is.
              composer.insert(text, { at: "end", block: true });
              composer.focus();
            },
          });
        },
      },
    ],
  });
});
