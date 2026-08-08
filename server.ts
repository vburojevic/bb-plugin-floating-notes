// bb-plugin-notes — standalone quick notes: SQLite-backed markdown notes with
// pinning, tags, trash, @note mentions, a `bb notes` CLI, and agent tools.
import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { deriveTitle, localDateKey, normalizeTags } from "./lib/notes";

const noteSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  pinned: z.boolean(),
  trashedAt: z.number().nullable(),
  originProjectId: z.string().nullable(),
  originThreadId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type Note = z.infer<typeof noteSchema>;

export const rpcContract = defineRpcContract({
  listNotes: {
    input: z
      .object({
        query: z.string().optional(),
        tag: z.string().optional(),
        view: z.enum(["active", "trash"]).optional(),
        threadId: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
      })
      .strict(),
    output: z.object({
      notes: z.array(noteSchema),
      tags: z.array(z.object({ name: z.string(), count: z.number().int() })),
      counts: z.object({ active: z.number().int(), trashed: z.number().int() }),
    }),
  },
  getNote: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ note: noteSchema.nullable() }),
  },
  createNote: {
    input: z
      .object({
        body: z.string(),
        tags: z.array(z.string()).optional(),
        originProjectId: z.string().nullable().optional(),
        originThreadId: z.string().nullable().optional(),
      })
      .strict(),
    output: z.object({ note: noteSchema }),
  },
  updateNote: {
    input: z
      .object({
        id: z.string(),
        body: z.string().optional(),
        tags: z.array(z.string()).optional(),
        pinned: z.boolean().optional(),
      })
      .strict(),
    output: z.object({ note: noteSchema }),
  },
  trashNote: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ note: noteSchema }),
  },
  restoreNote: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ note: noteSchema }),
  },
  purgeNote: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ purged: z.boolean() }),
  },
  emptyTrash: {
    input: z.null(),
    output: z.object({ purged: z.number().int() }),
  },
});

interface NoteRow {
  id: string;
  body: string;
  tags: string;
  pinned: number;
  trashed_at: number | null;
  origin_project_id: string | null;
  origin_thread_id: string | null;
  created_at: number;
  updated_at: number;
}

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
    title: deriveTitle(row.body),
    body: row.body,
    tags,
    pinned: row.pinned === 1,
    trashedAt: row.trashed_at,
    originProjectId: row.origin_project_id,
    originThreadId: row.origin_thread_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
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
  ]);

  const notifyChanged = () => bb.realtime.publish("notes", { kind: "changed" });

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

  const listNotes = (filter: {
    query?: string;
    tag?: string;
    view?: "active" | "trash";
    threadId?: string;
    limit?: number;
  }): Note[] => {
    const view = filter.view ?? "active";
    const clauses: string[] = [
      view === "trash" ? "trashed_at IS NOT NULL" : "trashed_at IS NULL",
    ];
    const params: unknown[] = [];
    if (filter.query && filter.query.trim().length > 0) {
      clauses.push("body LIKE ?");
      params.push(`%${filter.query.trim()}%`);
    }
    if (filter.threadId) {
      clauses.push("origin_thread_id = ?");
      params.push(filter.threadId);
    }
    const order =
      view === "trash"
        ? "ORDER BY trashed_at DESC"
        : "ORDER BY pinned DESC, updated_at DESC";
    const rows = db
      .prepare(`SELECT * FROM notes WHERE ${clauses.join(" AND ")} ${order}`)
      .all(...params) as NoteRow[];
    let notes = rows.map(rowToNote);
    if (filter.tag) {
      const tag = filter.tag.toLowerCase();
      notes = notes.filter((note) => note.tags.includes(tag));
    }
    return notes.slice(0, filter.limit ?? 500);
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

  const createNote = async (input: {
    body: string;
    tags?: string[];
    originProjectId?: string | null;
    originThreadId?: string | null;
  }): Promise<Note> => {
    const now = Date.now();
    const id = randomUUID().replace(/-/g, "").slice(0, 10);
    let originProjectId = input.originProjectId ?? null;
    const originThreadId = input.originThreadId ?? null;
    if (originThreadId && !originProjectId) {
      try {
        const thread = await bb.sdk.threads.get({ threadId: originThreadId });
        originProjectId = thread.projectId ?? null;
      } catch {
        // Origin stamping is best-effort; a dead thread id is not an error.
      }
    }
    db.prepare(
      `INSERT INTO notes (id, body, tags, pinned, trashed_at, origin_project_id, origin_thread_id, created_at, updated_at)
       VALUES (?, ?, ?, 0, NULL, ?, ?, ?, ?)`,
    ).run(
      id,
      input.body,
      JSON.stringify(normalizeTags(input.tags ?? [])),
      originProjectId,
      originThreadId,
      now,
      now,
    );
    notifyChanged();
    return getById(id)!;
  };

  const updateNote = (input: {
    id: string;
    body?: string;
    tags?: string[];
    pinned?: boolean;
  }): Note => {
    const note = resolveId(input.id);
    const body = input.body ?? note.body;
    const tags = input.tags ? normalizeTags(input.tags) : note.tags;
    const pinned = input.pinned ?? note.pinned;
    const contentChanged = body !== note.body || JSON.stringify(tags) !== JSON.stringify(note.tags);
    db.prepare("UPDATE notes SET body = ?, tags = ?, pinned = ?, updated_at = ? WHERE id = ?").run(
      body,
      JSON.stringify(tags),
      pinned ? 1 : 0,
      contentChanged ? Date.now() : note.updatedAt,
      note.id,
    );
    notifyChanged();
    return getById(note.id)!;
  };

  const setTrashed = (id: string, trashed: boolean): Note => {
    const note = resolveId(id);
    db.prepare("UPDATE notes SET trashed_at = ?, pinned = ? WHERE id = ?").run(
      trashed ? Date.now() : null,
      trashed ? 0 : note.pinned ? 1 : 0,
      note.id,
    );
    notifyChanged();
    return getById(note.id)!;
  };

  const purgeNote = (id: string): boolean => {
    const note = getById(id) ?? resolveId(id);
    if (note.trashedAt === null) {
      throw new Error("Only trashed notes can be purged — trash it first");
    }
    db.prepare("DELETE FROM notes WHERE id = ?").run(note.id);
    notifyChanged();
    return true;
  };

  /** Today's daily note (tagged "daily", titled YYYY-MM-DD), created on demand. */
  const getOrCreateDaily = async (origin: {
    projectId?: string | null;
    threadId?: string | null;
  }): Promise<Note> => {
    const key = localDateKey(new Date());
    const existing = listNotes({ tag: "daily" }).find((note) => note.title === key);
    if (existing) return existing;
    return createNote({
      body: `# ${key}\n`,
      tags: ["daily"],
      originProjectId: origin.projectId ?? null,
      originThreadId: origin.threadId ?? null,
    });
  };

  bb.rpc.register(rpcContract, {
    listNotes: (input) => ({ notes: listNotes(input), tags: tagCounts(), counts: noteCounts() }),
    getNote: ({ id }) => ({ note: getById(id) }),
    createNote: async (input) => ({ note: await createNote(input) }),
    updateNote: (input) => ({ note: updateNote(input) }),
    trashNote: ({ id }) => ({ note: setTrashed(id, true) }),
    restoreNote: ({ id }) => ({ note: setTrashed(id, false) }),
    purgeNote: ({ id }) => ({ purged: purgeNote(id) }),
    emptyTrash: () => {
      const result = db
        .prepare("DELETE FROM notes WHERE trashed_at IS NOT NULL")
        .run();
      notifyChanged();
      return { purged: result.changes };
    },
  });

  // ---- @note mentions: attach a note's markdown as agent context ----------
  bb.ui.registerMentionProvider({
    id: "note",
    label: "Notes",
    search({ query }) {
      const q = query.trim().toLowerCase();
      return listNotes({})
        .filter(
          (note) =>
            q.length === 0 ||
            note.title.toLowerCase().includes(q) ||
            note.body.toLowerCase().includes(q) ||
            note.tags.some((tag) => tag.includes(q)),
        )
        .slice(0, 8)
        .map((note) => ({
          id: note.id,
          title: note.title,
          subtitle: note.tags.length > 0 ? note.tags.map((t) => `#${t}`).join(" ") : undefined,
        }));
    },
    resolve(itemId) {
      const note = getById(itemId);
      if (!note) throw new Error("Note no longer exists");
      const tagLine = note.tags.length > 0 ? `\nTags: ${note.tags.join(", ")}` : "";
      return {
        context: `# Note: ${note.title} (id ${note.id})${tagLine}\n\n${note.body}`,
      };
    },
  });

  // ---- bb notes CLI --------------------------------------------------------
  const formatLine = (note: Note): string => {
    const marks = `${note.pinned ? "📌" : "  "}`;
    const tags = note.tags.length > 0 ? `  [${note.tags.join(",")}]` : "";
    const date = new Date(note.updatedAt).toISOString().slice(0, 10);
    return `${note.id}  ${marks} ${note.title}${tags}  (${date})`;
  };

  const cliUsage = [
    "Usage: bb notes <command>",
    "  list [--tag <tag>] [--trash] [--limit <n>]   List notes (pinned first)",
    "  search <query>                               Full-text search",
    "  read <id>                                    Print a note (id prefixes ok)",
    "  add <text…> [--tags a,b]                     Create a note",
    "  daily [text…]                                Open today's daily note (append text)",
    "  append <id> <text…>                          Append a line to a note",
    "  edit <id> <text…>                            Replace a note's body",
    "  tag <id> <add|rm> <tag>                      Add or remove a tag",
    "  pin <id> [--off]                             Pin or unpin",
    "  trash <id> / restore <id> / purge <id>       Soft-delete lifecycle",
  ].join("\n");

  bb.cli.register({
    name: "notes",
    summary: "Quick markdown notes (list, search, add, edit, tag, pin, trash)",
    commands: [
      { name: "list", summary: "List notes (pinned first); --tag, --trash, --limit", usage: "bb notes list [--tag t] [--trash] [--limit n]" },
      { name: "search", summary: "Full-text search over note bodies", usage: "bb notes search <query>" },
      { name: "read", summary: "Print one note's body and metadata", usage: "bb notes read <id>" },
      { name: "add", summary: "Create a note from the given text", usage: "bb notes add <text…> [--tags a,b]" },
      { name: "daily", summary: "Print today's daily note (created on demand); with text, append it as a bullet", usage: "bb notes daily [text…]" },
      { name: "append", summary: "Append text to an existing note", usage: "bb notes append <id> <text…>" },
      { name: "edit", summary: "Replace a note's body with the given text", usage: "bb notes edit <id> <text…>" },
      { name: "tag", summary: "Add or remove a tag on a note", usage: "bb notes tag <id> <add|rm> <tag>" },
      { name: "pin", summary: "Pin a note to the top (--off to unpin)", usage: "bb notes pin <id> [--off]" },
      { name: "trash", summary: "Move a note to the trash (recoverable)", usage: "bb notes trash <id>" },
      { name: "restore", summary: "Restore a note from the trash", usage: "bb notes restore <id>" },
      { name: "purge", summary: "Permanently delete a trashed note", usage: "bb notes purge <id>" },
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
            const notes = listNotes({ tag, view: trash ? "trash" : "active", limit });
            return {
              exitCode: 0,
              stdout: notes.length > 0 ? notes.map(formatLine).join("\n") : "No notes.",
            };
          }
          case "search": {
            const query = rest.join(" ").trim();
            if (!query) return { exitCode: 1, stderr: "Usage: bb notes search <query>" };
            const notes = listNotes({ query, limit: 50 });
            return {
              exitCode: 0,
              stdout: notes.length > 0 ? notes.map(formatLine).join("\n") : "No matches.",
            };
          }
          case "read": {
            if (!rest[0]) return { exitCode: 1, stderr: "Usage: bb notes read <id>" };
            const note = resolveId(rest[0]);
            const meta = [
              `id: ${note.id}${note.pinned ? "  (pinned)" : ""}${note.trashedAt ? "  (in trash)" : ""}`,
              note.tags.length > 0 ? `tags: ${note.tags.join(", ")}` : null,
              `updated: ${new Date(note.updatedAt).toISOString()}`,
            ]
              .filter(Boolean)
              .join("\n");
            return { exitCode: 0, stdout: `${meta}\n\n${note.body}` };
          }
          case "add": {
            const tags = (takeFlag("tags") ?? "").split(",");
            const body = rest.join(" ").trim();
            if (!body) return { exitCode: 1, stderr: "Usage: bb notes add <text…> [--tags a,b]" };
            const note = await createNote({
              body,
              tags,
              originProjectId: ctx.projectId ?? null,
              originThreadId: ctx.threadId ?? null,
            });
            return { exitCode: 0, stdout: `Created ${note.id}: ${note.title}` };
          }
          case "daily": {
            const note = await getOrCreateDaily({
              projectId: ctx.projectId ?? null,
              threadId: ctx.threadId ?? null,
            });
            const text = rest.join(" ").trim();
            if (text) {
              const updated = updateNote({ id: note.id, body: `${note.body.replace(/\n+$/, "")}\n- ${text}` });
              return { exitCode: 0, stdout: `Added to ${updated.id} (${updated.title}): ${text}` };
            }
            return { exitCode: 0, stdout: `id: ${note.id}\n\n${note.body}` };
          }
          case "append": {
            const [id, ...words] = rest;
            const text = words.join(" ").trim();
            if (!id || !text) return { exitCode: 1, stderr: "Usage: bb notes append <id> <text…>" };
            const note = resolveId(id);
            const updated = updateNote({ id: note.id, body: `${note.body}\n${text}` });
            return { exitCode: 0, stdout: `Appended to ${updated.id}: ${updated.title}` };
          }
          case "edit": {
            const [id, ...words] = rest;
            const text = words.join(" ").trim();
            if (!id || !text) return { exitCode: 1, stderr: "Usage: bb notes edit <id> <text…>" };
            const updated = updateNote({ id, body: text });
            return { exitCode: 0, stdout: `Updated ${updated.id}: ${updated.title}` };
          }
          case "tag": {
            const [id, op, tag] = rest;
            if (!id || !tag || (op !== "add" && op !== "rm")) {
              return { exitCode: 1, stderr: "Usage: bb notes tag <id> <add|rm> <tag>" };
            }
            const note = resolveId(id);
            const tags =
              op === "add"
                ? [...note.tags, tag]
                : note.tags.filter((t) => t !== tag.trim().replace(/^#/, "").toLowerCase());
            const updated = updateNote({ id: note.id, tags });
            return {
              exitCode: 0,
              stdout: `${updated.id} tags: ${updated.tags.join(", ") || "(none)"}`,
            };
          }
          case "pin": {
            if (!rest[0]) return { exitCode: 1, stderr: "Usage: bb notes pin <id> [--off]" };
            const off = hasFlag("off");
            const updated = updateNote({ id: rest[0], pinned: !off });
            return { exitCode: 0, stdout: `${off ? "Unpinned" : "Pinned"} ${updated.id}` };
          }
          case "trash":
          case "restore": {
            if (!rest[0]) return { exitCode: 1, stderr: `Usage: bb notes ${command} <id>` };
            const note = setTrashed(rest[0], command === "trash");
            return {
              exitCode: 0,
              stdout: `${command === "trash" ? "Trashed" : "Restored"} ${note.id}: ${note.title}`,
            };
          }
          case "purge": {
            if (!rest[0]) return { exitCode: 1, stderr: "Usage: bb notes purge <id>" };
            const note = resolveId(rest[0]);
            purgeNote(note.id);
            return { exitCode: 0, stdout: `Purged ${note.id} permanently.` };
          }
          default:
            return { exitCode: command ? 1 : 0, stdout: cliUsage };
        }
      } catch (error) {
        return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  // ---- Agent tools: full CRUD where delete only ever means trash ----------
  bb.agents.registerTool({
    name: "notes_search",
    description:
      "Search the user's personal notes (Notes plugin). Returns matching note ids, titles, and tags. Empty query lists recent notes.",
    instructions:
      "The user keeps personal notes in the Notes plugin. Use notes_search/notes_read to consult them when relevant, and notes_write to capture or update a note when asked to take notes.",
    parameters: z.object({
      query: z.string().optional().describe("Full-text search over note bodies; omit to list recent notes"),
      tag: z.string().optional().describe("Only notes carrying this tag"),
      includeTrashed: z.boolean().optional().describe("Search the trash instead of active notes"),
    }),
    execute({ query, tag, includeTrashed }) {
      const notes = listNotes({
        query,
        tag,
        view: includeTrashed ? "trash" : "active",
        limit: 25,
      });
      if (notes.length === 0) return "No matching notes.";
      return notes
        .map(
          (note) =>
            `${note.id} | ${note.title}${note.pinned ? " | pinned" : ""}${note.tags.length > 0 ? ` | tags: ${note.tags.join(",")}` : ""} | updated ${new Date(note.updatedAt).toISOString().slice(0, 10)}`,
        )
        .join("\n");
    },
  });

  bb.agents.registerTool({
    name: "notes_read",
    description: "Read one of the user's notes in full by id (unique prefixes accepted).",
    parameters: z.object({ id: z.string().min(1) }),
    execute({ id }) {
      const note = resolveId(id);
      const tagLine = note.tags.length > 0 ? `\nTags: ${note.tags.join(", ")}` : "";
      return `# ${note.title} (id ${note.id})${tagLine}\n\n${note.body}`;
    },
  });

  bb.agents.registerTool({
    name: "notes_write",
    description:
      "Create or update one of the user's notes. Omit id to create (body required). With id: body replaces, append adds to the end, tags replaces the tag set, pinned toggles pinning.",
    parameters: z.object({
      id: z.string().optional().describe("Existing note id to update; omit to create a new note"),
      body: z.string().optional().describe("Full markdown body (required when creating; replaces when updating)"),
      append: z.string().optional().describe("Text appended to the existing body on its own line"),
      tags: z.array(z.string()).optional().describe("Replacement tag set"),
      pinned: z.boolean().optional(),
    }),
    async execute({ id, body, append, tags, pinned }, { threadId, projectId }) {
      if (!id) {
        if (!body) return { content: [{ type: "text", text: "body is required to create a note" }], isError: true };
        const note = await createNote({
          body,
          tags,
          originProjectId: projectId,
          originThreadId: threadId,
        });
        return `Created note ${note.id}: ${note.title}`;
      }
      const existing = resolveId(id);
      const nextBody =
        append !== undefined
          ? `${body ?? existing.body}\n${append}`
          : body;
      const note = updateNote({ id: existing.id, body: nextBody, tags, pinned });
      return `Updated note ${note.id}: ${note.title}`;
    },
  });

  bb.agents.registerTool({
    name: "notes_trash",
    description:
      "Move one of the user's notes to the trash (recoverable), or restore it with restore=true. Never permanently deletes.",
    parameters: z.object({
      id: z.string().min(1),
      restore: z.boolean().optional(),
    }),
    execute({ id, restore }) {
      const note = setTrashed(id, !restore);
      return `${restore ? "Restored" : "Trashed"} note ${note.id}: ${note.title}`;
    },
  });

  bb.log.info("notes plugin loaded");
}
