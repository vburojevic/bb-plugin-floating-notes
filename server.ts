// bb-plugin-notes — server. SQLite-backed floating notes: FTS5 search (LIKE
// fallback), thread scratchpads, daily/inbox notes, image attachments, @note
// mentions, a `bb notes` CLI, and agent tools. The RPC surface lives in
// lib/contract.ts; every mutation runs through a serialize mutex and publishes
// a realtime "changed" signal after commit.
import { randomUUID } from "node:crypto";
// fs/promises, deliberately: export/import walk every note/file in one CLI
// call, and plugins run in-process — a sync loop here blocks the whole bb
// server for its duration (perf-watch traced a 79s handler to exactly that).
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import {
  noteColorSchema,
  noteKindSchema,
  rpcContract,
  type ListedNote,
  type Note,
  type NoteColor,
  type NoteKind,
} from "./lib/contract";
import {
  alignColumns,
  appendToBody,
  countTasks,
  deriveTitle,
  extractHashtags,
  ftsQuery,
  localDateKey,
  normalizeTags,
  referencedAttachmentIds,
  slug,
  snippetFromBody,
  stripAttachmentRefs,
  uncheckedTaskLines,
} from "./lib/notes";

const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
/** Trashed notes older than this are purged at startup. */
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
/** kv flag guarding the one-time FTS index rebuild. */
const FTS_REBUILT_KEY = "fts-rebuilt-v2";
/** A body edit only snapshots a revision when the newest one is older than this. */
const REVISION_MIN_INTERVAL_MS = 4 * 60 * 1000;
/** Newest revisions kept per note; older ones are pruned after each insert. */
const REVISION_KEEP = 20;
/** Unreferenced attachments younger than this survive GC — a just-uploaded
 * image must not be collected before its ref lands via the debounced save. */
const ATTACHMENT_GC_GRACE_MS = 10 * 60 * 1000;

interface NoteRow {
  id: string;
  title: string | null;
  body: string;
  tags: string;
  kind: string;
  color: string | null;
  pinned: number;
  pinned_thread_id: string | null;
  pinned_project_id: string | null;
  sticky_open: number;
  collapsed: number;
  date_key: string | null;
  task_total: number;
  task_done: number;
  trashed_at: number | null;
  origin_project_id: string | null;
  origin_thread_id: string | null;
  created_at: number;
  updated_at: number;
}

interface RevisionRow {
  id: string;
  note_id: string;
  body: string;
  created_at: number;
}

const NOTE_KINDS: readonly string[] = noteKindSchema.options;
const NOTE_COLORS: readonly string[] = noteColorSchema.options;

function rowToNote(row: NoteRow): Note {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags);
    if (Array.isArray(parsed)) tags = parsed.filter((t) => typeof t === "string");
  } catch {
    // Malformed tag JSON degrades to no tags rather than a dead note.
  }
  return {
    id: row.id,
    title: row.title ?? deriveTitle(row.body),
    body: row.body,
    tags,
    kind: NOTE_KINDS.includes(row.kind) ? (row.kind as NoteKind) : "note",
    color:
      row.color !== null && NOTE_COLORS.includes(row.color)
        ? (row.color as NoteColor)
        : null,
    pinned: row.pinned === 1,
    pinnedThreadId: row.pinned_thread_id,
    pinnedProjectId: row.pinned_project_id,
    stickyOpen: row.sticky_open === 1,
    collapsed: row.collapsed === 1,
    dateKey: row.date_key,
    taskTotal: row.task_total,
    taskDone: row.task_done,
    trashedAt: row.trashed_at,
    originProjectId: row.origin_project_id,
    originThreadId: row.origin_thread_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function newId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 10);
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    shortcutEnabled: {
      type: "boolean",
      label: "Toggle window with Ctrl+'",
      default: true,
    },
    captureShortcutEnabled: {
      type: "boolean",
      label: "Quick capture with Ctrl+Shift+'",
      default: true,
    },
    fontSize: {
      type: "select",
      label: "Font size",
      options: ["12", "13", "14", "16"],
      default: "14",
    },
    defaultColor: {
      type: "select",
      label: "Default sticky color",
      options: ["none", "yellow", "mint", "sky", "rose", "lavender", "peach"],
      default: "none",
    },
    captureTarget: {
      type: "select",
      label: "Quick capture target",
      options: ["inbox", "scratchpad"],
      default: "inbox",
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    // 0–1: the shipped v1 statements. bb.storage.migrate keys migrations by
    // statement index, so these two must stay byte-identical forever.
    `CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      pinned INTEGER NOT NULL DEFAULT 0,
      trashed_at INTEGER,
      origin_project_id TEXT,
      origin_thread_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes (updated_at DESC)`,
    // 2+: the redesign nukes the v1 store (per owner directive — no users, no
    // data to preserve) and rebuilds the full schema from scratch.
    `DROP TABLE IF EXISTS notes`,
    `DROP INDEX IF EXISTS idx_notes_updated`,
    `CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      title TEXT,
      body TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      kind TEXT NOT NULL DEFAULT 'note',
      color TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      pinned_thread_id TEXT,
      sticky_open INTEGER NOT NULL DEFAULT 0,
      collapsed INTEGER NOT NULL DEFAULT 0,
      date_key TEXT,
      task_total INTEGER NOT NULL DEFAULT 0,
      task_done INTEGER NOT NULL DEFAULT 0,
      trashed_at INTEGER,
      origin_project_id TEXT,
      origin_thread_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes (updated_at DESC)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_scratchpad_thread ON notes (origin_thread_id) WHERE kind = 'scratchpad'`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_daily_date ON notes (date_key) WHERE kind = 'daily'`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_inbox ON notes (kind) WHERE kind = 'inbox'`,
    `CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      mime TEXT NOT NULL,
      bytes BLOB NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_attachments_note ON attachments (note_id)`,
    // 11+: project pins and autosave revision history. Append-only — never
    // reorder or edit the statements above.
    `ALTER TABLE notes ADD COLUMN pinned_project_id TEXT`,
    `CREATE TABLE IF NOT EXISTS note_revisions (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_note_revisions_note ON note_revisions (note_id, created_at DESC)`,
  ]);

  // ---- FTS5, outside the migrate list so a missing module can't brick the
  // plugin: external-content index over title/body/tags kept in sync by
  // triggers, with a one-time kv-guarded rebuild. On failure we fall back to
  // LIKE search for the whole process lifetime.
  let ftsAvailable = true;
  try {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, body, tags, content='notes', content_rowid='rowid')`,
    );
    db.exec(`CREATE TRIGGER IF NOT EXISTS notes_fts_after_insert AFTER INSERT ON notes BEGIN
      INSERT INTO notes_fts (rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
    END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS notes_fts_after_delete AFTER DELETE ON notes BEGIN
      INSERT INTO notes_fts (notes_fts, rowid, title, body, tags) VALUES ('delete', old.rowid, old.title, old.body, old.tags);
    END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS notes_fts_after_update AFTER UPDATE ON notes BEGIN
      INSERT INTO notes_fts (notes_fts, rowid, title, body, tags) VALUES ('delete', old.rowid, old.title, old.body, old.tags);
      INSERT INTO notes_fts (rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
    END`);
    if ((await bb.storage.kv.get<boolean>(FTS_REBUILT_KEY)) !== true) {
      db.prepare(`INSERT INTO notes_fts (notes_fts) VALUES ('rebuild')`).run();
      await bb.storage.kv.set(FTS_REBUILT_KEY, true);
    }
  } catch (error) {
    ftsAvailable = false;
    bb.log.warn(
      `FTS5 unavailable, using LIKE search: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const notifyChanged = () => bb.realtime.publish("notes", { kind: "changed" });
  settings.onChange(() => notifyChanged());

  // Trash is a grace period, not an archive: purge anything trashed over 30
  // days ago (attachments and revisions first — no FK cascade in this schema).
  {
    const cutoff = Date.now() - TRASH_RETENTION_MS;
    db.prepare(
      `DELETE FROM attachments WHERE note_id IN (SELECT id FROM notes WHERE trashed_at IS NOT NULL AND trashed_at < ?)`,
    ).run(cutoff);
    db.prepare(
      `DELETE FROM note_revisions WHERE note_id IN (SELECT id FROM notes WHERE trashed_at IS NOT NULL AND trashed_at < ?)`,
    ).run(cutoff);
    const purged = db
      .prepare(`DELETE FROM notes WHERE trashed_at IS NOT NULL AND trashed_at < ?`)
      .run(cutoff).changes;
    if (purged > 0) bb.log.info(`Purged ${purged} note(s) from trash (30-day retention)`);
  }

  // Serializes every mutation (floating-terminal lesson: overlapping
  // read-modify-writes drop writes at remote latencies). Raw ops below never
  // call `serialize` themselves — only the api wrappers do — so the chain can
  // never nest and deadlock.
  let mutations: Promise<unknown> = Promise.resolve();
  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = mutations.then(work, work);
    mutations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // ---- reads ---------------------------------------------------------------

  const getById = (id: string): Note | null => {
    const row = db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as
      | NoteRow
      | undefined;
    return row ? rowToNote(row) : null;
  };

  /** Resolve a full id or unique id prefix (CLI/agent ergonomics). */
  const resolveId = (idOrPrefix: string): Note => {
    const exact = getById(idOrPrefix);
    if (exact) return exact;
    const rows = db
      .prepare("SELECT * FROM notes WHERE id LIKE ? LIMIT 2")
      .all(`${idOrPrefix}%`) as NoteRow[];
    if (rows.length === 0) throw new Error(`No note matching "${idOrPrefix}"`);
    if (rows.length > 1)
      throw new Error(`Ambiguous note id prefix "${idOrPrefix}"`);
    return rowToNote(rows[0]!);
  };

  interface ListFilter {
    query?: string;
    tag?: string;
    view?: "active" | "trash";
    threadId?: string;
    kinds?: NoteKind[];
    stickyOpen?: boolean;
    sort?: "updated" | "created" | "title";
    limit?: number;
  }

  const listNotes = (filter: ListFilter): ListedNote[] => {
    const view = filter.view ?? "active";
    const clauses: string[] = [
      view === "trash"
        ? "notes.trashed_at IS NOT NULL"
        : "notes.trashed_at IS NULL",
    ];
    const params: unknown[] = [];
    if (filter.threadId !== undefined) {
      clauses.push("notes.origin_thread_id = ?");
      params.push(filter.threadId);
    }
    if (filter.kinds !== undefined && filter.kinds.length > 0) {
      clauses.push(`notes.kind IN (${filter.kinds.map(() => "?").join(", ")})`);
      params.push(...filter.kinds);
    }
    if (filter.stickyOpen !== undefined) {
      clauses.push("notes.sticky_open = ?");
      params.push(filter.stickyOpen ? 1 : 0);
    }
    const sort = filter.sort ?? "updated";
    const order =
      view === "trash"
        ? "ORDER BY notes.trashed_at DESC"
        : sort === "created"
          ? "ORDER BY notes.pinned DESC, notes.created_at DESC"
          : sort === "title"
            ? "ORDER BY notes.pinned DESC, notes.title COLLATE NOCASE ASC"
            : "ORDER BY notes.pinned DESC, notes.updated_at DESC";

    const query = filter.query?.trim() ?? "";
    type SearchRow = NoteRow & { match_snippet?: string | null };

    // char(1)/char(2) wrap each hit; the app splits on those sentinels to
    // style matched runs without any HTML.
    const ftsSearch = (): SearchRow[] =>
      db
        .prepare(
          `SELECT notes.*, snippet(notes_fts, 1, char(1), char(2), '…', 12) AS match_snippet
           FROM notes_fts
           JOIN notes ON notes.rowid = notes_fts.rowid
           WHERE notes_fts MATCH ? AND ${clauses.join(" AND ")}
           ${order}`,
        )
        .all(ftsQuery(query), ...params) as SearchRow[];

    const likeSearch = (): SearchRow[] => {
      const like = `%${query}%`;
      return db
        .prepare(
          `SELECT notes.* FROM notes
           WHERE ${clauses.join(" AND ")}
             AND (notes.title LIKE ? OR notes.body LIKE ? OR notes.tags LIKE ?)
           ${order}`,
        )
        .all(...params, like, like, like) as SearchRow[];
    };

    let rows: SearchRow[];
    if (query.length === 0) {
      rows = db
        .prepare(
          `SELECT notes.* FROM notes WHERE ${clauses.join(" AND ")} ${order}`,
        )
        .all(...params) as SearchRow[];
    } else if (ftsAvailable) {
      try {
        rows = ftsSearch();
      } catch {
        rows = likeSearch();
      }
    } else {
      rows = likeSearch();
    }

    let notes = rows.map((row) => ({
      ...rowToNote(row),
      matchSnippet: row.match_snippet ?? null,
      threadTitle: null as string | null,
      projectName: null as string | null,
    }));
    if (filter.tag !== undefined) {
      const tag = filter.tag.toLowerCase();
      notes = notes.filter((note) => note.tags.includes(tag));
    }
    return notes.slice(0, filter.limit ?? 500);
  };

  // ---- thread-title enrichment ---------------------------------------------
  //
  // A scratchpad, a pinned sticky, or a captured note is bound to a thread;
  // the UI has to say WHICH one or every scratchpad reads as "Scratchpad".
  // Titles resolve through bb.sdk.threads.get behind a short cache.

  const THREAD_TITLE_TTL_MS = 60_000;
  const PROJECT_TTL_MS = 5 * 60_000;
  const threadTitleCache = new Map<string, { title: string | null; at: number }>();
  /** id -> name for every project, refreshed as one list call. */
  let projectNameCache = new Map<string, string>();
  let projectsFetchedAt = 0;

  const boundThreadId = (note: ListedNote): string | null =>
    note.kind === "scratchpad"
      ? note.originThreadId
      : (note.pinnedThreadId ?? note.originThreadId);

  /** A note belongs to the project it was pinned to, else the one it came from. */
  const boundProjectId = (note: ListedNote): string | null =>
    note.pinnedProjectId ?? note.originProjectId;

  const refreshProjects = async (now: number): Promise<void> => {
    if (now - projectsFetchedAt < PROJECT_TTL_MS) return;
    try {
      const projects = await bb.sdk.projects.list();
      const next = new Map<string, string>();
      for (const project of projects) next.set(project.id, project.name);
      projectNameCache = next;
      projectsFetchedAt = now;
    } catch {
      // Keep the previous map; a stale name beats no name, and the next
      // list call retries.
      projectsFetchedAt = now;
    }
  };

  /**
   * Stamp every row with where it lives: the bound thread's title and the
   * owning project's name. Both are what the UI groups and labels by, so
   * they are resolved once here rather than guessed per surface.
   */
  const withScope = async (notes: ListedNote[]): Promise<ListedNote[]> => {
    const now = Date.now();
    const wanted = new Set<string>();
    let needsProjects = false;
    for (const note of notes) {
      const threadId = boundThreadId(note);
      if (threadId !== null) {
        const cached = threadTitleCache.get(threadId);
        if (cached === undefined || now - cached.at > THREAD_TITLE_TTL_MS) {
          wanted.add(threadId);
        }
      }
      if (boundProjectId(note) !== null) needsProjects = true;
    }
    await Promise.all([
      needsProjects ? refreshProjects(now) : Promise.resolve(),
      ...[...wanted].map(async (threadId) => {
        try {
          const thread = await bb.sdk.threads.get({ threadId });
          threadTitleCache.set(threadId, { title: thread.title ?? null, at: now });
        } catch {
          // Dead thread: remember the miss so we don't retry every list call.
          threadTitleCache.set(threadId, { title: null, at: now });
        }
      }),
    ]);
    return notes.map((note) => {
      const threadId = boundThreadId(note);
      const projectId = boundProjectId(note);
      return {
        ...note,
        threadTitle:
          threadId === null
            ? null
            : (threadTitleCache.get(threadId)?.title ?? null),
        projectName:
          projectId === null ? null : (projectNameCache.get(projectId) ?? null),
      };
    });
  };

  const tagCounts = (): Array<{ name: string; count: number }> => {
    const rows = db
      .prepare("SELECT tags FROM notes WHERE trashed_at IS NULL")
      .all() as Array<{ tags: string }>;
    const counts = new Map<string, number>();
    for (const row of rows) {
      try {
        for (const tag of JSON.parse(row.tags)) {
          if (typeof tag === "string") counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
      } catch {
        // Skip malformed rows; they already degrade in rowToNote.
      }
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  };

  const noteCounts = (): { active: number; trashed: number } => {
    const active = db
      .prepare("SELECT COUNT(*) AS n FROM notes WHERE trashed_at IS NULL")
      .get() as { n: number };
    const trashed = db
      .prepare("SELECT COUNT(*) AS n FROM notes WHERE trashed_at IS NOT NULL")
      .get() as { n: number };
    return { active: active.n, trashed: trashed.n };
  };

  const getAttachment = (
    id: string,
  ): { mime: string; dataBase64: string } | null => {
    const row = db
      .prepare("SELECT mime, bytes FROM attachments WHERE id = ?")
      .get(id) as { mime: string; bytes: Buffer } | undefined;
    if (row === undefined) return null;
    return { mime: row.mime, dataBase64: Buffer.from(row.bytes).toString("base64") };
  };

  /** Revision metadata, newest first. chars mirrors JS body.length. */
  const listRevisions = (
    noteId: string,
  ): Array<{ id: string; createdAt: number; chars: number }> =>
    (
      db
        .prepare(
          "SELECT id, body, created_at FROM note_revisions WHERE note_id = ? ORDER BY created_at DESC",
        )
        .all(noteId) as Array<{ id: string; body: string; created_at: number }>
    ).map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      chars: row.body.length,
    }));

  const getRevision = (
    id: string,
  ): { id: string; noteId: string; body: string; createdAt: number } | null => {
    const row = db.prepare("SELECT * FROM note_revisions WHERE id = ?").get(id) as
      | RevisionRow
      | undefined;
    if (row === undefined) return null;
    return {
      id: row.id,
      noteId: row.note_id,
      body: row.body,
      createdAt: row.created_at,
    };
  };

  /** Attachment metadata, newest first — sizes via length(bytes), no blobs. */
  const listAttachments = (
    noteId: string,
  ): Array<{ id: string; mime: string; bytes: number; createdAt: number }> =>
    (
      db
        .prepare(
          "SELECT id, mime, length(bytes) AS bytes, created_at FROM attachments WHERE note_id = ? ORDER BY created_at DESC",
        )
        .all(noteId) as Array<{
        id: string;
        mime: string;
        bytes: number;
        created_at: number;
      }>
    ).map((row) => ({
      id: row.id,
      mime: row.mime,
      bytes: row.bytes,
      createdAt: row.created_at,
    }));

  // ---- raw mutations (call only through `api`, which serializes) -----------

  interface CreateInput {
    body?: string;
    tags?: string[];
    color?: NoteColor | null;
    pinned?: boolean;
    stickyOpen?: boolean;
    originProjectId?: string | null;
    originThreadId?: string | null;
    kind?: NoteKind;
    dateKey?: string | null;
  }

  const createNoteRaw = async (input: CreateInput): Promise<Note> => {
    const now = Date.now();
    const id = newId();
    let originProjectId = input.originProjectId ?? null;
    const originThreadId = input.originThreadId ?? null;
    if (originThreadId !== null && originProjectId === null) {
      try {
        const thread = await bb.sdk.threads.get({ threadId: originThreadId });
        originProjectId = thread.projectId ?? null;
      } catch {
        // Origin stamping is best-effort; a dead thread id is not an error.
      }
    }
    const body = input.body ?? "";
    const { total, done } = countTasks(body);
    db.prepare(
      `INSERT INTO notes (id, title, body, tags, kind, color, pinned, pinned_thread_id, sticky_open, collapsed, date_key, task_total, task_done, trashed_at, origin_project_id, origin_thread_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    ).run(
      id,
      deriveTitle(body),
      body,
      // Inline #hashtags tag the note without leaving the editor.
      JSON.stringify(normalizeTags([...(input.tags ?? []), ...extractHashtags(body)])),
      input.kind ?? "note",
      input.color ?? null,
      input.pinned === true ? 1 : 0,
      input.stickyOpen === true ? 1 : 0,
      input.dateKey ?? null,
      total,
      done,
      originProjectId,
      originThreadId,
      now,
      now,
    );
    notifyChanged();
    return getById(id)!;
  };

  /**
   * Snapshot `previousBody` into note_revisions ahead of a body write.
   * Skipped when the newest revision for the note is younger than 4 minutes
   * (autosave churn would flood the table) unless `force` — restoreRevision
   * must never lose the present state. Empty previous bodies are never worth
   * a revision; every insert prunes the note down to the newest 20.
   */
  const snapshotRevisionRaw = (
    noteId: string,
    previousBody: string,
    force = false,
  ): void => {
    if (previousBody.length === 0) return;
    const now = Date.now();
    if (!force) {
      const newest = db
        .prepare(
          "SELECT created_at FROM note_revisions WHERE note_id = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(noteId) as { created_at: number } | undefined;
      if (newest !== undefined && now - newest.created_at < REVISION_MIN_INTERVAL_MS) {
        return;
      }
    }
    db.prepare(
      "INSERT INTO note_revisions (id, note_id, body, created_at) VALUES (?, ?, ?, ?)",
    ).run(newId(), noteId, previousBody, now);
    db.prepare(
      `DELETE FROM note_revisions WHERE note_id = ? AND id NOT IN (
         SELECT id FROM note_revisions WHERE note_id = ? ORDER BY created_at DESC LIMIT ?
       )`,
    ).run(noteId, noteId, REVISION_KEEP);
  };

  /**
   * After a body write, drop this note's attachments the new body no longer
   * references — except those younger than the 10-minute grace period, so a
   * just-uploaded image isn't collected before its ref lands via the
   * debounced save.
   */
  const gcAttachmentsRaw = (noteId: string, body: string): void => {
    const referenced = new Set(referencedAttachmentIds(body));
    const candidates = db
      .prepare("SELECT id FROM attachments WHERE note_id = ? AND created_at < ?")
      .all(noteId, Date.now() - ATTACHMENT_GC_GRACE_MS) as Array<{ id: string }>;
    for (const row of candidates) {
      if (!referenced.has(row.id)) {
        db.prepare("DELETE FROM attachments WHERE id = ?").run(row.id);
      }
    }
  };

  interface UpdateInput {
    id: string;
    body?: string;
    tags?: string[];
    pinned?: boolean;
    color?: NoteColor | null;
    stickyOpen?: boolean;
    collapsed?: boolean;
    pinnedThreadId?: string | null;
    pinnedProjectId?: string | null;
  }

  /** Omitted field = untouched; explicit null clears (color, pinnedThreadId,
   * pinnedProjectId). Thread and project pins are independent — setting one
   * never clears the other; which stickies show where is the client's call. */
  const updateNoteRaw = (input: UpdateInput): Note => {
    const note = resolveId(input.id);
    const body = input.body ?? note.body;
    const bodyChanged = body !== note.body;
    if (bodyChanged) snapshotRevisionRaw(note.id, note.body);
    // Inline #hashtags union into the stored tags; explicit removals happen
    // through the tags input (CLI/tools), body edits only ever add.
    const tags = normalizeTags([
      ...(input.tags !== undefined ? input.tags : note.tags),
      ...extractHashtags(body),
    ]);
    const contentChanged =
      bodyChanged || JSON.stringify(tags) !== JSON.stringify(note.tags);
    const { total, done } = countTasks(body);
    db.prepare(
      `UPDATE notes SET body = ?, title = ?, tags = ?, task_total = ?, task_done = ?, pinned = ?, color = ?, sticky_open = ?, collapsed = ?, pinned_thread_id = ?, pinned_project_id = ?, updated_at = ? WHERE id = ?`,
    ).run(
      body,
      deriveTitle(body),
      JSON.stringify(tags),
      total,
      done,
      (input.pinned ?? note.pinned) ? 1 : 0,
      input.color !== undefined ? input.color : note.color,
      (input.stickyOpen ?? note.stickyOpen) ? 1 : 0,
      (input.collapsed ?? note.collapsed) ? 1 : 0,
      input.pinnedThreadId !== undefined ? input.pinnedThreadId : note.pinnedThreadId,
      input.pinnedProjectId !== undefined ? input.pinnedProjectId : note.pinnedProjectId,
      // Metadata-only writes (pin, color, sticky, collapse) keep updated_at so
      // toggles never reorder the recency-sorted list.
      contentChanged ? Date.now() : note.updatedAt,
      note.id,
    );
    if (bodyChanged) gcAttachmentsRaw(note.id, body);
    notifyChanged();
    return getById(note.id)!;
  };

  /** Body-only write: recomputes title/tags/task stats, touches nothing else. */
  const appendRaw = (idOrPrefix: string, text: string): Note => {
    const note = resolveId(idOrPrefix);
    const body = appendToBody(note.body, text);
    const bodyChanged = body !== note.body;
    if (bodyChanged) snapshotRevisionRaw(note.id, note.body);
    const { total, done } = countTasks(body);
    const tags = normalizeTags([...note.tags, ...extractHashtags(body)]);
    db.prepare(
      "UPDATE notes SET body = ?, title = ?, tags = ?, task_total = ?, task_done = ?, updated_at = ? WHERE id = ?",
    ).run(body, deriveTitle(body), JSON.stringify(tags), total, done, Date.now(), note.id);
    if (bodyChanged) gcAttachmentsRaw(note.id, body);
    notifyChanged();
    return getById(note.id)!;
  };

  /**
   * Get-or-create for the singleton kinds. When the existing row sits in the
   * trash it is restored instead of duplicated — the partial unique indexes
   * make a second live row impossible anyway.
   */
  const getOrCreateRaw = async (
    where: { clause: string; params: unknown[] },
    create: CreateInput,
  ): Promise<{ note: Note; created: boolean }> => {
    const row = db
      .prepare(`SELECT * FROM notes WHERE ${where.clause}`)
      .get(...where.params) as NoteRow | undefined;
    if (row !== undefined) {
      if (row.trashed_at !== null) {
        db.prepare("UPDATE notes SET trashed_at = NULL WHERE id = ?").run(row.id);
        notifyChanged();
        return { note: getById(row.id)!, created: false };
      }
      return { note: rowToNote(row), created: false };
    }
    return { note: await createNoteRaw(create), created: true };
  };

  const scratchpadRaw = (input: {
    threadId: string;
    projectId?: string | null;
  }): Promise<{ note: Note; created: boolean }> =>
    getOrCreateRaw(
      {
        clause: "kind = 'scratchpad' AND origin_thread_id = ?",
        params: [input.threadId],
      },
      {
        body: "# Scratchpad\n\n",
        kind: "scratchpad",
        originThreadId: input.threadId,
        originProjectId: input.projectId ?? null,
      },
    );

  const dailyRaw = (): Promise<{ note: Note; created: boolean }> => {
    const key = localDateKey(new Date());
    // Carry-over is decided before the get-or-create: only a genuinely new
    // daily note seeds its body with the previous daily's unfinished tasks.
    // Any row for today — even a trashed one getOrCreateRaw will restore —
    // means no carry-over.
    let body = `# ${key}\n\n`;
    const existing = db
      .prepare("SELECT id FROM notes WHERE kind = 'daily' AND date_key = ?")
      .get(key) as { id: string } | undefined;
    if (existing === undefined) {
      const previous = db
        .prepare(
          "SELECT body FROM notes WHERE kind = 'daily' AND trashed_at IS NULL AND date_key IS NOT NULL AND date_key != ? ORDER BY date_key DESC LIMIT 1",
        )
        .get(key) as { body: string } | undefined;
      const carried =
        previous !== undefined ? uncheckedTaskLines(previous.body) : [];
      if (carried.length > 0) {
        body = `# ${key}\n\n## Carried over\n${carried.join("\n")}\n\n`;
      }
    }
    return getOrCreateRaw(
      { clause: "kind = 'daily' AND date_key = ?", params: [key] },
      { body, kind: "daily", dateKey: key },
    );
  };

  const inboxRaw = (): Promise<{ note: Note; created: boolean }> =>
    getOrCreateRaw(
      { clause: "kind = 'inbox'", params: [] },
      { body: "# Inbox\n\n", kind: "inbox" },
    );

  const setTrashedRaw = (idOrPrefix: string, trashed: boolean): Note => {
    const note = resolveId(idOrPrefix);
    if (trashed) {
      // Trash clears everything that would keep the note on screen.
      db.prepare(
        "UPDATE notes SET trashed_at = ?, pinned = 0, sticky_open = 0, pinned_thread_id = NULL, pinned_project_id = NULL WHERE id = ?",
      ).run(Date.now(), note.id);
    } else {
      db.prepare("UPDATE notes SET trashed_at = NULL WHERE id = ?").run(note.id);
    }
    notifyChanged();
    return getById(note.id)!;
  };

  const purgeRaw = (idOrPrefix: string): boolean => {
    const note = resolveId(idOrPrefix);
    if (note.trashedAt === null) {
      throw new Error("Only trashed notes can be purged — trash it first");
    }
    db.transaction((noteId: string) => {
      db.prepare("DELETE FROM attachments WHERE note_id = ?").run(noteId);
      db.prepare("DELETE FROM note_revisions WHERE note_id = ?").run(noteId);
      db.prepare("DELETE FROM notes WHERE id = ?").run(noteId);
    })(note.id);
    notifyChanged();
    return true;
  };

  const emptyTrashRaw = (): number => {
    const purged = db.transaction((): number => {
      db.prepare(
        "DELETE FROM attachments WHERE note_id IN (SELECT id FROM notes WHERE trashed_at IS NOT NULL)",
      ).run();
      db.prepare(
        "DELETE FROM note_revisions WHERE note_id IN (SELECT id FROM notes WHERE trashed_at IS NOT NULL)",
      ).run();
      return db.prepare("DELETE FROM notes WHERE trashed_at IS NOT NULL").run()
        .changes;
    })();
    if (purged > 0) notifyChanged();
    return purged;
  };

  const uploadAttachmentRaw = (input: {
    noteId: string;
    mime: string;
    dataBase64: string;
  }): string => {
    if (!input.mime.startsWith("image/")) {
      throw new Error("Only image attachments are supported");
    }
    if (
      input.dataBase64.length === 0 ||
      input.dataBase64.length % 4 !== 0 ||
      !BASE64_RE.test(input.dataBase64)
    ) {
      throw new Error("Attachment payload is not valid base64");
    }
    const bytes = Buffer.from(input.dataBase64, "base64");
    if (bytes.byteLength === 0) throw new Error("Attachment is empty");
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error("Attachment exceeds the 4MB limit");
    }
    const note = getById(input.noteId);
    if (note === null) throw new Error(`No note matching "${input.noteId}"`);
    const id = newId();
    db.prepare(
      "INSERT INTO attachments (id, note_id, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, note.id, input.mime, bytes, Date.now());
    notifyChanged();
    return id;
  };

  /**
   * Set a note's body to a stored revision — after snapshotting the CURRENT
   * body unconditionally (restoring must never lose the present state), and
   * recomputing title/tags-union/task stats exactly like any body write.
   */
  const restoreRevisionRaw = (revisionId: string): Note => {
    const revision = db
      .prepare("SELECT * FROM note_revisions WHERE id = ?")
      .get(revisionId) as RevisionRow | undefined;
    if (revision === undefined) {
      throw new Error(`No revision matching "${revisionId}"`);
    }
    const note = getById(revision.note_id);
    if (note === null) {
      throw new Error(`Revision "${revisionId}" belongs to a deleted note`);
    }
    snapshotRevisionRaw(note.id, note.body, true);
    const body = revision.body;
    const { total, done } = countTasks(body);
    const tags = normalizeTags([...note.tags, ...extractHashtags(body)]);
    db.prepare(
      "UPDATE notes SET body = ?, title = ?, tags = ?, task_total = ?, task_done = ?, updated_at = ? WHERE id = ?",
    ).run(body, deriveTitle(body), JSON.stringify(tags), total, done, Date.now(), note.id);
    gcAttachmentsRaw(note.id, body);
    notifyChanged();
    return getById(note.id)!;
  };

  /**
   * Remove an attachment and strip its bbnote:// refs from the owning note's
   * body (derived fields recomputed). Null when the attachment didn't exist
   * (or its note is already gone).
   */
  const deleteAttachmentRaw = (id: string): Note | null => {
    const row = db
      .prepare("SELECT id, note_id FROM attachments WHERE id = ?")
      .get(id) as { id: string; note_id: string } | undefined;
    if (row === undefined) return null;
    db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
    const note = getById(row.note_id);
    if (note === null) {
      // Orphaned blob (note purged out from under it): nothing to strip.
      notifyChanged();
      return null;
    }
    const body = stripAttachmentRefs(note.body, row.id);
    if (body !== note.body) {
      const { total, done } = countTasks(body);
      const tags = normalizeTags([...note.tags, ...extractHashtags(body)]);
      db.prepare(
        "UPDATE notes SET body = ?, title = ?, tags = ?, task_total = ?, task_done = ?, updated_at = ? WHERE id = ?",
      ).run(body, deriveTitle(body), JSON.stringify(tags), total, done, Date.now(), note.id);
    }
    notifyChanged();
    return getById(note.id);
  };

  // ---- serialized mutation api (RPC, CLI, and agent tools all use this) ----

  const api = {
    createNote: (input: CreateInput) => serialize(() => createNoteRaw(input)),
    updateNote: (input: UpdateInput) =>
      serialize(async () => updateNoteRaw(input)),
    appendToNote: (id: string, text: string) =>
      serialize(async () => appendRaw(id, text)),
    scratchpad: (input: { threadId: string; projectId?: string | null }) =>
      serialize(() => scratchpadRaw(input)),
    dailyNote: () => serialize(() => dailyRaw()),
    inboxNote: () => serialize(() => inboxRaw()),
    setTrashed: (id: string, trashed: boolean) =>
      serialize(async () => setTrashedRaw(id, trashed)),
    purgeNote: (id: string) => serialize(async () => purgeRaw(id)),
    emptyTrash: () => serialize(async () => emptyTrashRaw()),
    uploadAttachment: (input: {
      noteId: string;
      mime: string;
      dataBase64: string;
    }) => serialize(async () => uploadAttachmentRaw(input)),
    restoreRevision: (id: string) =>
      serialize(async () => restoreRevisionRaw(id)),
    deleteAttachment: (id: string) =>
      serialize(async () => deleteAttachmentRaw(id)),
  };

  // ---- RPC -----------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    listNotes: async (input) => ({
      notes: await withScope(listNotes(input)),
      tags: tagCounts(),
      counts: noteCounts(),
    }),
    getNote: ({ id }) => ({ note: getById(id) }),
    createNote: async (input) => ({ note: await api.createNote(input) }),
    updateNote: async (input) => ({ note: await api.updateNote(input) }),
    appendToNote: async ({ id, text }) => ({
      note: await api.appendToNote(id, text),
    }),
    scratchpad: (input) => api.scratchpad(input),
    dailyNote: () => api.dailyNote(),
    inboxNote: () => api.inboxNote(),
    trashNote: async ({ id }) => ({ note: await api.setTrashed(id, true) }),
    restoreNote: async ({ id }) => ({ note: await api.setTrashed(id, false) }),
    purgeNote: async ({ id }) => ({ purged: await api.purgeNote(id) }),
    emptyTrash: async () => ({ purged: await api.emptyTrash() }),
    uploadAttachment: async (input) => ({
      id: await api.uploadAttachment(input),
    }),
    getAttachment: ({ id }) => ({ attachment: getAttachment(id) }),
    listRevisions: ({ noteId }) => ({ revisions: listRevisions(noteId) }),
    getRevision: ({ id }) => ({ revision: getRevision(id) }),
    restoreRevision: async ({ id }) => ({
      note: await api.restoreRevision(id),
    }),
    listAttachments: ({ noteId }) => ({ attachments: listAttachments(noteId) }),
    deleteAttachment: async ({ id }) => ({
      note: await api.deleteAttachment(id),
    }),
    clientConfig: async () => {
      const values = await settings.get();
      return {
        shortcutEnabled: values.shortcutEnabled,
        captureShortcutEnabled: values.captureShortcutEnabled,
        fontSize: values.fontSize,
        defaultColor: values.defaultColor,
        captureTarget:
          values.captureTarget === "scratchpad"
            ? ("scratchpad" as const)
            : ("inbox" as const),
      };
    },
  });

  // ---- @note mentions: FTS-backed search, body-as-markdown context ---------

  bb.ui.registerMentionProvider({
    id: "note",
    label: "Notes",
    search({ query }) {
      const trimmed = query.trim();
      return listNotes({
        query: trimmed.length > 0 ? trimmed : undefined,
        limit: 8,
      }).map((note) => ({
        id: note.id,
        title: note.title,
        subtitle:
          note.tags.length > 0
            ? note.tags.map((t) => `#${t}`).join(" ")
            : undefined,
      }));
    },
    resolve(itemId) {
      const note = getById(itemId);
      if (!note) throw new Error("Note no longer exists");
      return { context: note.body };
    },
  });

  // ---- bb notes CLI --------------------------------------------------------

  const noteTable = (notes: ListedNote[], withSnippet = false): string =>
    alignColumns(
      notes.map((note) => {
        const cells = [
          note.id,
          note.pinned ? "*" : "",
          note.title.length > 48 ? `${note.title.slice(0, 47)}…` : note.title,
          note.tags.map((t) => `#${t}`).join(" "),
          new Date(note.updatedAt).toISOString().slice(0, 10),
        ];
        if (withSnippet) {
          const snippet = (note.matchSnippet ?? snippetFromBody(note.body))
            .replace(/[\u0001\u0002]/g, "")
            .replace(/\s+/g, " ")
            .trim();
          cells.push(snippet.length > 60 ? `${snippet.slice(0, 59)}…` : snippet);
        }
        return cells;
      }),
    );

  const showNote = (note: Note): string => {
    const meta = [
      `id: ${note.id}${note.pinned ? "  (pinned)" : ""}${note.trashedAt !== null ? "  (in trash)" : ""}`,
      note.kind !== "note" ? `kind: ${note.kind}` : null,
      note.tags.length > 0 ? `tags: ${note.tags.join(", ")}` : null,
      note.taskTotal > 0 ? `tasks: ${note.taskDone}/${note.taskTotal}` : null,
      `updated: ${new Date(note.updatedAt).toISOString()}`,
    ]
      .filter(Boolean)
      .join("\n");
    return `${meta}\n\n${note.body}`;
  };

  // ---- export/import helpers ----

  /** One exported note file: hand-rolled YAML front-matter, then the body. */
  const exportMarkdown = (note: Note): string =>
    [
      "---",
      `id: ${note.id}`,
      `kind: ${note.kind}`,
      `tags: ${JSON.stringify(note.tags)}`,
      `color: ${note.color ?? "null"}`,
      `pinned: ${note.pinned}`,
      `dateKey: ${note.dateKey ?? "null"}`,
      `originThreadId: ${note.originThreadId ?? "null"}`,
      `createdAt: ${new Date(note.createdAt).toISOString()}`,
      `updatedAt: ${new Date(note.updatedAt).toISOString()}`,
      "---",
      note.body,
    ].join("\n");

  const EXTENSION_BY_MIME: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/avif": "avif",
    "image/heic": "heic",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
  };

  const extFromMime = (mime: string): string => {
    const known = EXTENSION_BY_MIME[mime];
    if (known !== undefined) return known;
    const subtype = (mime.split("/")[1] ?? "")
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase();
    return subtype.length > 0 ? subtype : "bin";
  };

  /**
   * Hand-rolled front-matter split: a `---` fence on the first line, then
   * `key: value` lines until the closing `---`. Returns null when a fence
   * opens but never closes (malformed); a file with no fence is all body.
   */
  const splitFrontMatter = (
    raw: string,
  ): { meta: Record<string, string>; body: string } | null => {
    const lines = raw.split("\n");
    if (lines[0]?.trim() !== "---") return { meta: {}, body: raw };
    const meta: Record<string, string> = {};
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === "---") {
        return { meta, body: lines.slice(i + 1).join("\n") };
      }
      const colon = line.indexOf(":");
      if (colon === -1) continue; // Tolerate stray lines between known keys.
      meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
    return null;
  };

  /** Front-matter tags value: a JSON array or a comma list. */
  const parseTagsValue = (value: string | undefined): string[] | undefined => {
    if (value === undefined || value.length === 0) return undefined;
    if (value.startsWith("[")) {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          return parsed.filter((t): t is string => typeof t === "string");
        }
      } catch {
        // Fall through to the comma list.
      }
    }
    return value
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  };

  const cliUsage = [
    "Usage: bb notes <command>",
    "  list [--tag t] [--trash] [--limit n]    List notes (pinned first)",
    "  search <query>                          Full-text search",
    "  show <id>                               Print a note (id prefixes ok)",
    "  add <text…> [--tags a,b]                Create a note (-- before literal text)",
    "  append <id> <text…>                     Append a line to a note",
    "  tag <id> <+tag|-tag>…                   Add/remove tags",
    "  pin <id>                                Toggle pinned",
    "  trash <id> / restore <id> / purge <id>  Soft-delete lifecycle",
    "  empty-trash                             Purge everything in the trash",
    "  daily                                   Today's daily note (created on demand)",
    "  scratchpad [threadId]                   The thread's scratchpad note",
    "  export <dir>                            Write notes as markdown files with front-matter",
    "  import <dir>                            Create/update notes from markdown files",
  ].join("\n");

  bb.cli.register({
    name: "notes",
    summary:
      "Floating markdown notes (list, search, add, append, tag, pin, trash, daily, scratchpad)",
    commands: [
      { name: "list", summary: "List notes (pinned first)", usage: "bb notes list [--tag t] [--trash] [--limit n]" },
      { name: "search", summary: "Full-text search over notes", usage: "bb notes search <query>" },
      { name: "show", summary: "Print one note's body and metadata", usage: "bb notes show <id>" },
      { name: "add", summary: "Create a note from the given text", usage: "bb notes add <text…> [--tags a,b]" },
      { name: "append", summary: "Append text to an existing note", usage: "bb notes append <id> <text…>" },
      { name: "tag", summary: "Add (+tag) or remove (-tag) tags on a note", usage: "bb notes tag <id> <+tag|-tag>…" },
      { name: "pin", summary: "Toggle a note's pinned state", usage: "bb notes pin <id>" },
      { name: "trash", summary: "Move a note to the trash (recoverable)", usage: "bb notes trash <id>" },
      { name: "restore", summary: "Restore a note from the trash", usage: "bb notes restore <id>" },
      { name: "purge", summary: "Permanently delete a trashed note", usage: "bb notes purge <id>" },
      { name: "empty-trash", summary: "Permanently delete everything in the trash", usage: "bb notes empty-trash" },
      { name: "daily", summary: "Print today's daily note (created on demand)", usage: "bb notes daily" },
      { name: "scratchpad", summary: "Print a thread's scratchpad note (created on demand)", usage: "bb notes scratchpad [threadId]" },
      { name: "export", summary: "Write every non-trashed note (and attachments) to a directory as markdown", usage: "bb notes export <dir>" },
      { name: "import", summary: "Create or update notes from a directory of markdown files", usage: "bb notes import <dir>" },
    ],
    async run(argv, ctx) {
      const [command, ...rest] = argv;
      const takeFlag = (name: string): string | undefined => {
        const index = rest.indexOf(`--${name}`);
        if (index === -1) return undefined;
        const value = rest[index + 1];
        rest.splice(index, value === undefined ? 1 : 2);
        return value;
      };
      const hasFlag = (name: string): boolean => {
        const index = rest.indexOf(`--${name}`);
        if (index === -1) return false;
        rest.splice(index, 1);
        return true;
      };
      try {
        switch (command) {
          case "list": {
            const tag = takeFlag("tag");
            const trash = hasFlag("trash");
            const limit = Number(takeFlag("limit") ?? "50");
            const notes = listNotes({
              tag,
              view: trash ? "trash" : "active",
              limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
            });
            return {
              exitCode: 0,
              stdout: notes.length > 0 ? noteTable(notes) : "No notes.",
            };
          }
          case "search": {
            const query = rest.join(" ").trim();
            if (!query)
              return { exitCode: 1, stderr: "Usage: bb notes search <query>" };
            const notes = listNotes({ query, limit: 50 });
            return {
              exitCode: 0,
              stdout: notes.length > 0 ? noteTable(notes, true) : "No matches.",
            };
          }
          case "show": {
            if (!rest[0])
              return { exitCode: 1, stderr: "Usage: bb notes show <id>" };
            return { exitCode: 0, stdout: showNote(resolveId(rest[0])) };
          }
          case "add": {
            const tags = (takeFlag("tags") ?? "").split(",");
            // "--" marks the rest as literal text (there is no stdin in the
            // plugin CLI bridge), so text may start with dashes.
            const words = rest[0] === "--" ? rest.slice(1) : rest;
            const body = words.join(" ").trim();
            if (!body)
              return {
                exitCode: 1,
                stderr: "Usage: bb notes add <text…> [--tags a,b]",
              };
            const note = await api.createNote({
              body,
              tags,
              originProjectId: ctx.projectId ?? null,
              originThreadId: ctx.threadId ?? null,
            });
            return { exitCode: 0, stdout: `Created ${note.id}: ${note.title}` };
          }
          case "append": {
            const [id, ...words] = rest;
            const text = words.join(" ").trim();
            if (!id || !text)
              return {
                exitCode: 1,
                stderr: "Usage: bb notes append <id> <text…>",
              };
            const note = await api.appendToNote(id, text);
            return { exitCode: 0, stdout: `Appended to ${note.id}: ${note.title}` };
          }
          case "tag": {
            const [id, ...ops] = rest;
            if (!id || ops.length === 0 || ops.some((op) => !/^[+-]./.test(op)))
              return {
                exitCode: 1,
                stderr: "Usage: bb notes tag <id> <+tag|-tag>…",
              };
            const note = resolveId(id);
            let tags = [...note.tags];
            for (const op of ops) {
              const name = op.slice(1).trim().replace(/^#/, "").toLowerCase();
              if (name.length === 0) continue;
              if (op.startsWith("+")) tags.push(name);
              else tags = tags.filter((t) => t !== name);
            }
            const updated = await api.updateNote({ id: note.id, tags });
            return {
              exitCode: 0,
              stdout: `${updated.id} tags: ${updated.tags.map((t) => `#${t}`).join(" ") || "(none)"}`,
            };
          }
          case "pin": {
            if (!rest[0])
              return { exitCode: 1, stderr: "Usage: bb notes pin <id>" };
            const note = resolveId(rest[0]);
            const updated = await api.updateNote({
              id: note.id,
              pinned: !note.pinned,
            });
            return {
              exitCode: 0,
              stdout: `${updated.pinned ? "Pinned" : "Unpinned"} ${updated.id}: ${updated.title}`,
            };
          }
          case "trash":
          case "restore": {
            if (!rest[0])
              return { exitCode: 1, stderr: `Usage: bb notes ${command} <id>` };
            const note = await api.setTrashed(rest[0], command === "trash");
            return {
              exitCode: 0,
              stdout: `${command === "trash" ? "Trashed" : "Restored"} ${note.id}: ${note.title}`,
            };
          }
          case "purge": {
            if (!rest[0])
              return { exitCode: 1, stderr: "Usage: bb notes purge <id>" };
            const note = resolveId(rest[0]);
            await api.purgeNote(note.id);
            return { exitCode: 0, stdout: `Purged ${note.id} permanently.` };
          }
          case "empty-trash": {
            const purged = await api.emptyTrash();
            return {
              exitCode: 0,
              stdout:
                purged === 0
                  ? "Trash is already empty."
                  : `Purged ${purged} note${purged === 1 ? "" : "s"}.`,
            };
          }
          case "daily": {
            const { note, created } = await api.dailyNote();
            return {
              exitCode: 0,
              stdout: `${created ? "(created) " : ""}${showNote(note)}`,
            };
          }
          case "scratchpad": {
            const threadId = rest[0] ?? ctx.threadId;
            if (!threadId)
              return {
                exitCode: 1,
                stderr:
                  "Usage: bb notes scratchpad <threadId> (no thread in this context)",
              };
            const { note, created } = await api.scratchpad({
              threadId,
              projectId: ctx.projectId ?? null,
            });
            return {
              exitCode: 0,
              stdout: `${created ? "(created) " : ""}${showNote(note)}`,
            };
          }
          case "export": {
            const dirArg = rest[0];
            if (!dirArg)
              return { exitCode: 1, stderr: "Usage: bb notes export <dir>" };
            const dir = isAbsolute(dirArg)
              ? dirArg
              : resolve(ctx.cwd ?? process.cwd(), dirArg);
            const rows = db
              .prepare(
                "SELECT * FROM notes WHERE trashed_at IS NULL ORDER BY created_at ASC",
              )
              .all() as NoteRow[];
            await mkdir(dir, { recursive: true });
            const attachmentsDir = join(dir, "_attachments");
            let attachmentsDirMade = false;
            let attachmentCount = 0;
            for (const row of rows) {
              const note = rowToNote(row);
              await writeFile(
                join(dir, `${slug(note.title)}-${note.id.slice(0, 8)}.md`),
                exportMarkdown(note),
              );
              const blobs = db
                .prepare(
                  "SELECT id, mime, bytes FROM attachments WHERE note_id = ?",
                )
                .all(note.id) as Array<{ id: string; mime: string; bytes: Buffer }>;
              for (const blob of blobs) {
                if (!attachmentsDirMade) {
                  await mkdir(attachmentsDir, { recursive: true });
                  attachmentsDirMade = true;
                }
                await writeFile(
                  join(attachmentsDir, `${blob.id}.${extFromMime(blob.mime)}`),
                  blob.bytes,
                );
                attachmentCount += 1;
              }
            }
            return {
              exitCode: 0,
              stdout: `Exported ${rows.length} note${rows.length === 1 ? "" : "s"} and ${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"} to ${dir}`,
            };
          }
          case "import": {
            const dirArg = rest[0];
            if (!dirArg)
              return { exitCode: 1, stderr: "Usage: bb notes import <dir>" };
            const dir = isAbsolute(dirArg)
              ? dirArg
              : resolve(ctx.cwd ?? process.cwd(), dirArg);
            let names: string[];
            try {
              names = (await readdir(dir)).filter((name) => name.endsWith(".md"));
            } catch (error) {
              return {
                exitCode: 1,
                stderr: `Cannot read ${dir}: ${error instanceof Error ? error.message : String(error)}`,
              };
            }
            let createdCount = 0;
            let updatedCount = 0;
            const warnings: string[] = [];
            for (const name of names.sort()) {
              let raw: string;
              try {
                raw = await readFile(join(dir, name), "utf8");
              } catch {
                warnings.push(`Skipped ${name}: unreadable`);
                continue;
              }
              const parsed = splitFrontMatter(raw);
              if (parsed === null) {
                warnings.push(`Skipped ${name}: unterminated front-matter`);
                continue;
              }
              const { meta, body } = parsed;
              const tags = parseTagsValue(meta.tags);
              // color: absent = untouched on update, unset on create;
              // "null" clears; anything not in the palette is ignored.
              const color: NoteColor | null | undefined =
                meta.color === undefined
                  ? undefined
                  : meta.color === "null" || meta.color === ""
                    ? null
                    : NOTE_COLORS.includes(meta.color)
                      ? (meta.color as NoteColor)
                      : undefined;
              const existing =
                meta.id !== undefined && meta.id.length > 0
                  ? getById(meta.id)
                  : null;
              if (existing !== null) {
                await api.updateNote({ id: existing.id, body, tags, color });
                updatedCount += 1;
              } else {
                // Unknown/missing id: create as a plain note — importing a
                // second daily/inbox/scratchpad would trip the singleton
                // indexes, so kind is not carried over.
                await api.createNote({ body, tags, color });
                createdCount += 1;
              }
            }
            return {
              exitCode: 0,
              stdout: `Imported: ${createdCount} created, ${updatedCount} updated.`,
              stderr: warnings.length > 0 ? warnings.join("\n") : undefined,
            };
          }
          default:
            return { exitCode: command ? 1 : 0, stdout: cliUsage };
        }
      } catch (error) {
        return {
          exitCode: 1,
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  // ---- Agent tools ---------------------------------------------------------

  const stripSentinels = (text: string): string =>
    text.replace(/[\u0001\u0002]/g, "");

  bb.agents.registerTool({
    name: "notes_search",
    description:
      "Search the user's notes. Returns matches as JSON (id, title, snippet, tags, updatedAt). Omit query to list recent notes.",
    instructions:
      "The user keeps personal notes in the Notes plugin. Use notes_search/notes_read to consult them when relevant, notes_write to capture or update a note when asked, and notes_scratchpad to leave findings on the current thread's scratchpad.",
    parameters: z.object({
      query: z
        .string()
        .optional()
        .describe("Full-text search terms; omit to list recent notes"),
      tag: z.string().optional().describe("Only notes carrying this tag"),
      limit: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe("Max results (default 20)"),
    }),
    execute({ query, tag, limit }) {
      const notes = listNotes({ query, tag, view: "active", limit: limit ?? 20 });
      if (notes.length === 0) return "No matching notes.";
      return JSON.stringify(
        notes.map((note) => ({
          id: note.id,
          title: note.title,
          snippet: stripSentinels(note.matchSnippet ?? snippetFromBody(note.body)),
          tags: note.tags,
          updatedAt: new Date(note.updatedAt).toISOString(),
        })),
      );
    },
  });

  bb.agents.registerTool({
    name: "notes_read",
    description:
      "Read one of the user's notes in full by id (unique id prefixes accepted). Returns JSON.",
    parameters: z.object({ id: z.string().min(1) }),
    execute({ id }) {
      const note = resolveId(id);
      return JSON.stringify({
        id: note.id,
        title: note.title,
        kind: note.kind,
        tags: note.tags,
        pinned: note.pinned,
        taskTotal: note.taskTotal,
        taskDone: note.taskDone,
        updatedAt: new Date(note.updatedAt).toISOString(),
        body: note.body,
      });
    },
  });

  bb.agents.registerTool({
    name: "notes_write",
    description:
      "Create or update one of the user's notes. Omit id to create (body required). With id: body replaces the note, or is appended when append=true; tags replaces the tag set; pinned toggles pinning.",
    parameters: z.object({
      id: z
        .string()
        .optional()
        .describe("Existing note id to update (prefixes ok); omit to create"),
      body: z
        .string()
        .optional()
        .describe(
          "Markdown text: the full body when creating or replacing, the text to add when append=true",
        ),
      append: z
        .boolean()
        .optional()
        .describe("Append body to the note instead of replacing it"),
      tags: z.array(z.string()).optional().describe("Replacement tag set"),
      pinned: z.boolean().optional(),
    }),
    async execute({ id, body, append, tags, pinned }, { threadId, projectId }) {
      if (id === undefined) {
        if (body === undefined) {
          return {
            content: [{ type: "text", text: "body is required to create a note" }],
            isError: true,
          };
        }
        const note = await api.createNote({
          body,
          tags,
          originProjectId: projectId,
          originThreadId: threadId,
        });
        return JSON.stringify({ created: true, id: note.id, title: note.title });
      }
      const existing = resolveId(id);
      let note: Note;
      if (append === true) {
        if (body === undefined) {
          return {
            content: [
              { type: "text", text: "body is required when append is true" },
            ],
            isError: true,
          };
        }
        note = await api.appendToNote(existing.id, body);
        if (tags !== undefined || pinned !== undefined) {
          note = await api.updateNote({ id: existing.id, tags, pinned });
        }
      } else {
        note = await api.updateNote({ id: existing.id, body, tags, pinned });
      }
      return JSON.stringify({ updated: true, id: note.id, title: note.title });
    },
  });

  bb.agents.registerTool({
    name: "notes_trash",
    description:
      "Move one of the user's notes to the trash (recoverable). Never permanently deletes.",
    parameters: z.object({ id: z.string().min(1) }),
    async execute({ id }) {
      const note = await api.setTrashed(id, true);
      return JSON.stringify({ trashed: true, id: note.id, title: note.title });
    },
  });

  bb.agents.registerTool({
    name: "notes_scratchpad",
    description:
      "Read the thread's scratchpad note, or append text to it when append is provided. Defaults to the current thread.",
    parameters: z.object({
      threadId: z
        .string()
        .optional()
        .describe("Thread whose scratchpad to use; defaults to this thread"),
      append: z
        .string()
        .optional()
        .describe("Markdown text to append to the scratchpad"),
    }),
    async execute({ threadId, append }, ctx) {
      const target = threadId ?? (ctx.threadId || undefined);
      if (target === undefined) {
        return {
          content: [{ type: "text", text: "threadId is required" }],
          isError: true,
        };
      }
      const { note } = await api.scratchpad({
        threadId: target,
        projectId: ctx.projectId || null,
      });
      if (append !== undefined && append.length > 0) {
        const updated = await api.appendToNote(note.id, append);
        return JSON.stringify({
          appended: true,
          id: updated.id,
          threadId: target,
        });
      }
      return JSON.stringify({ id: note.id, threadId: target, body: note.body });
    },
  });

  bb.log.info("notes plugin loaded");
}
