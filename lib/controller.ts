// A tiny external store for everything that drives the floating surfaces from
// outside React: the sidebar footer button (host-rendered, no component), the
// global shortcuts, the bb-tree bridge, and the composer's plus-menu.
//
// The thread registry is the visibility bridge for pinned stickies and the
// scratchpad target: the thread-header action's data hook receives the ids of
// every thread whose header is on screen (split panes mean several) and
// publishes them here. The front of the list is the focused thread, then the
// most recently seen one: "the" thread for capture targeting.

export interface VisibleThread {
  threadId: string;
  projectId: string | null;
}

/** The slice of PluginComposerApi the note picker needs. */
export interface ComposerInsertTarget {
  insertText(text: string): void;
}

export interface ControllerState {
  windowOpen: boolean;
  captureOpen: boolean;
  /** Set when something asked the window to reveal a specific note. */
  focusNoteId: string | null;
  /** Non-null while the composer's "Insert note" picker is up. */
  notePickerTarget: ComposerInsertTarget | null;
  /** Most recently seen first. */
  visibleThreads: readonly VisibleThread[];
  /**
   * A thread the user asked to jump to. The content script cannot call
   * useBbNavigate, so it posts the request here and the mounted bb-tree
   * bridge (the app overlay) executes and consumes it.
   */
  navigateRequest: { threadId: string; seq: number } | null;
}

type Listener = () => void;

let state: ControllerState = {
  windowOpen: false,
  captureOpen: false,
  focusNoteId: null,
  notePickerTarget: null,
  visibleThreads: [],
  navigateRequest: null,
};

let navigateSeq = 0;
/** Mounted bb-tree bridges able to execute a navigation request. */
let navigators = 0;

const listeners = new Set<Listener>();

function setState(patch: Partial<ControllerState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export const controller = {
  get: (): ControllerState => state,
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  // ------------------------------------------------------------- window
  showWindow(focusNoteId?: string): void {
    setState({ windowOpen: true, focusNoteId: focusNoteId ?? state.focusNoteId });
  },
  hideWindow(): void {
    setState({ windowOpen: false });
  },
  toggleWindow(): void {
    setState({ windowOpen: !state.windowOpen });
  },
  /** The window consumed the reveal request. */
  clearFocusNote(): void {
    if (state.focusNoteId !== null) setState({ focusNoteId: null });
  },

  // ------------------------------------------------------------ capture
  openCapture(): void {
    setState({ captureOpen: true });
  },
  closeCapture(): void {
    setState({ captureOpen: false });
  },

  // -------------------------------------------------------- note picker
  openNotePicker(target: ComposerInsertTarget): void {
    setState({ notePickerTarget: target });
  },
  closeNotePicker(): void {
    setState({ notePickerTarget: null });
  },

  // ------------------------------------------------------------ threads
  /**
   * Replace the on-screen thread set. `focusedThreadId` (bb's current route
   * thread) goes first; the rest keep the order they were first seen in,
   * newest first, so capture targets the thread the user just opened.
   */
  setVisibleThreads(
    threads: readonly VisibleThread[],
    focusedThreadId: string | null = null,
  ): void {
    const incoming = new Map(threads.map((thread) => [thread.threadId, thread]));
    const kept = state.visibleThreads
      .filter((thread) => incoming.has(thread.threadId))
      .map((thread) => incoming.get(thread.threadId)!);
    const keptIds = new Set(kept.map((thread) => thread.threadId));
    const added = threads.filter((thread) => !keptIds.has(thread.threadId));
    let next = [...added, ...kept];
    const focused = next.find((thread) => thread.threadId === focusedThreadId);
    if (focused !== undefined) {
      next = [focused, ...next.filter((thread) => thread !== focused)];
    }
    const same =
      next.length === state.visibleThreads.length &&
      next.every(
        (thread, index) =>
          thread.threadId === state.visibleThreads[index]!.threadId &&
          thread.projectId === state.visibleThreads[index]!.projectId,
      );
    if (!same) setState({ visibleThreads: next });
  },
  activeThread(): VisibleThread | null {
    return state.visibleThreads[0] ?? null;
  },
  isThreadVisible(threadId: string): boolean {
    return state.visibleThreads.some((thread) => thread.threadId === threadId);
  },

  // --------------------------------------------------------- navigation
  /** A bb-tree bridge mounted; it executes navigation requests until disposed. */
  registerNavigator(): () => void {
    navigators += 1;
    return () => {
      navigators -= 1;
    };
  },
  /** Jump to a thread from anywhere; hard-navigates when no bridge exists. */
  openThread(threadId: string): void {
    if (navigators > 0) {
      setState({ navigateRequest: { threadId, seq: ++navigateSeq } });
      return;
    }
    window.location.assign(`/threads/${encodeURIComponent(threadId)}`);
  },
  consumeNavigation(seq: number): void {
    if (state.navigateRequest?.seq === seq) setState({ navigateRequest: null });
  },
};
