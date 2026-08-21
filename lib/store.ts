// The client-side notes store — one cache for every surface.
//
// The floating window, the stickies, the quick-capture bar, and both panels
// all render from this module-level store and mutate through it, so a save
// made in a sticky is on the nav panel's screen the moment the RPC returns.
// Module-level state is safe here: the plugin app bundle is instantiated once
// per bb window, and the server is the source of truth underneath.
import {
  rpcContract,
  type ListedNote,
  type Note,
  type TagCount,
} from "./contract";
import { createRpcClient } from "./rpc";

export const PLUGIN_ID = "notes";

export const rpc = createRpcClient<typeof rpcContract>(PLUGIN_ID);

export interface ClientConfig {
  shortcutEnabled: boolean;
  captureShortcutEnabled: boolean;
  fontSize: string;
  defaultColor: string;
  captureTarget: "inbox" | "scratchpad";
}

const DEFAULT_CONFIG: ClientConfig = {
  shortcutEnabled: true,
  captureShortcutEnabled: true,
  fontSize: "14",
  defaultColor: "none",
  captureTarget: "inbox",
};

export interface NotesState {
  /** Active notes in server order: pinned first, then last-touched. */
  notes: readonly ListedNote[];
  tags: readonly TagCount[];
  counts: { active: number; trashed: number };
  config: ClientConfig;
  loaded: boolean;
  error: string | null;
}

type Listener = () => void;

let state: NotesState = {
  notes: [],
  tags: [],
  counts: { active: 0, trashed: 0 },
  config: DEFAULT_CONFIG,
  loaded: false,
  error: null,
};

const listeners = new Set<Listener>();
let inflight: Promise<void> | null = null;
/** A refresh was requested while one was in flight; run once more after. */
let refreshQueued = false;

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(patch: Partial<NotesState>): void {
  state = { ...state, ...patch };
  emit();
}

/** Local upsert so a mutation's result lands without waiting for a refresh. */
function upsert(note: Note): void {
  const index = state.notes.findIndex((row) => row.id === note.id);
  // Mutations return bare notes; keep the list-only enrichment (the bound
  // thread's title) from the row being replaced until the next refresh.
  const listed: ListedNote = {
    ...note,
    matchSnippet: null,
    threadTitle: index === -1 ? null : state.notes[index]!.threadTitle,
  };
  const next =
    index === -1
      ? [listed, ...state.notes]
      : state.notes.map((row) => (row.id === note.id ? listed : row));
  // Trashed notes leave the active list immediately.
  setState({ notes: next.filter((row) => row.trashedAt === null) });
}

function drop(id: string): void {
  setState({ notes: state.notes.filter((row) => row.id !== id) });
}

async function doRefresh(): Promise<void> {
  try {
    const [list, config] = await Promise.all([
      rpc.call("listNotes", {}),
      rpc.call("clientConfig", null),
    ]);
    setState({
      notes: list.notes,
      tags: list.tags,
      counts: list.counts,
      config: config as ClientConfig,
      loaded: true,
      error: null,
    });
  } catch (error) {
    setState({
      loaded: true,
      error: error instanceof Error ? error.message : "Notes backend unreachable",
    });
  }
}

export const notesStore = {
  get: (): NotesState => state,
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /**
   * Pull the server's view. A call landing while a request is in flight
   * queues ONE follow-up run: the in-flight response predates whatever
   * mutation prompted the new call, so applying it alone would clobber the
   * optimistic upsert with a stale snapshot until the next poll.
   */
  refresh(): Promise<void> {
    if (inflight !== null) {
      refreshQueued = true;
      return inflight;
    }
    inflight = doRefresh().finally(() => {
      inflight = null;
      if (refreshQueued) {
        refreshQueued = false;
        void notesStore.refresh();
      }
    });
    return inflight;
  },

  // ---------------------------------------------------------- mutations
  //
  // Each applies the server's result locally and then re-pulls the list,
  // because tags and counts are computed server-side. Body saves skip the
  // re-pull: they happen on every editor debounce and change neither.

  async createNote(input: {
    body?: string;
    tags?: string[];
    color?: Note["color"];
    stickyOpen?: boolean;
    originProjectId?: string | null;
    originThreadId?: string | null;
  }): Promise<Note> {
    const { note } = await rpc.call("createNote", input);
    upsert(note);
    void this.refresh();
    return note;
  },

  async saveBody(id: string, body: string): Promise<Note> {
    const { note } = await rpc.call("updateNote", { id, body });
    upsert(note);
    return note;
  },

  async updateNote(input: {
    id: string;
    tags?: string[];
    pinned?: boolean;
    color?: Note["color"] | null;
    stickyOpen?: boolean;
    collapsed?: boolean;
    pinnedThreadId?: string | null;
  }): Promise<Note> {
    const { note } = await rpc.call("updateNote", input);
    upsert(note);
    void this.refresh();
    return note;
  },

  async appendToNote(id: string, text: string): Promise<Note> {
    const { note } = await rpc.call("appendToNote", { id, text });
    upsert(note);
    return note;
  },

  async scratchpad(threadId: string, projectId?: string | null): Promise<Note> {
    const { note } = await rpc.call("scratchpad", { threadId, projectId });
    upsert(note);
    return note;
  },

  async dailyNote(): Promise<Note> {
    const { note } = await rpc.call("dailyNote", null);
    upsert(note);
    return note;
  },

  async inboxNote(): Promise<Note> {
    const { note } = await rpc.call("inboxNote", null);
    upsert(note);
    return note;
  },

  async trashNote(id: string): Promise<void> {
    await rpc.call("trashNote", { id });
    drop(id);
    void this.refresh();
  },

  async restoreNote(id: string): Promise<Note> {
    const { note } = await rpc.call("restoreNote", { id });
    upsert(note);
    void this.refresh();
    return note;
  },

  async purgeNote(id: string): Promise<void> {
    await rpc.call("purgeNote", { id });
    drop(id);
    void this.refresh();
  },

  async emptyTrash(): Promise<number> {
    const { purged } = await rpc.call("emptyTrash", null);
    void this.refresh();
    return purged;
  },
};

export function findNote(id: string): ListedNote | null {
  return state.notes.find((row) => row.id === id) ?? null;
}

/** The open stickies, in a stable order (creation time keeps them steady). */
export function openStickies(notes: readonly ListedNote[]): ListedNote[] {
  return notes
    .filter((note) => note.stickyOpen)
    .sort((a, b) => a.createdAt - b.createdAt);
}
