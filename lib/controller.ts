// A tiny external store for everything that drives the floating surfaces from
// outside React: the sidebar footer button (host-rendered, no component), the
// global shortcuts, the thread-header bridge, and the composer's plus-menu.
//
// The thread registry is the visibility bridge for pinned stickies and the
// scratchpad target: the thread-header slot mounts once per *visible* thread
// (split panes mean several), registers here, and unregisters on unmount. The
// front of the list is the most recently seen thread — "the" thread for
// capture targeting.

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
}

type Listener = () => void;

let state: ControllerState = {
  windowOpen: false,
  captureOpen: false,
  focusNoteId: null,
  notePickerTarget: null,
  visibleThreads: [],
};

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
  registerThread(threadId: string, projectId: string | null): () => void {
    // One entry PER MOUNT, not per thread: the same thread open in two split
    // panes registers twice, and closing one pane must not evict the other's
    // registration. Readers tolerate duplicates.
    const entry: VisibleThread = { threadId, projectId };
    setState({ visibleThreads: [entry, ...state.visibleThreads] });
    return () => {
      setState({
        visibleThreads: state.visibleThreads.filter((thread) => thread !== entry),
      });
    };
  },
  activeThread(): VisibleThread | null {
    return state.visibleThreads[0] ?? null;
  },
  isThreadVisible(threadId: string): boolean {
    return state.visibleThreads.some((thread) => thread.threadId === threadId);
  },
};
