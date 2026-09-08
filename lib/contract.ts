// The RPC contract — single source of truth for the server, the panels, and
// the content script's fetch twin. Pure zod with a type-only SDK import:
// this file is bundled into BOTH the server and the app, and the app build
// cannot resolve the server SDK — `satisfies` gives the same exact typing
// `defineRpcContract` (a typed identity) would, and vanishes at build.
import type { PluginRpcContract } from "@bb/plugin-sdk/app";
import { z } from "zod";

/** Sticky palette slots; actual colors are theme-aware CSS. */
export const noteColorSchema = z.enum([
  "yellow",
  "mint",
  "sky",
  "rose",
  "lavender",
  "peach",
]);
export type NoteColor = z.infer<typeof noteColorSchema>;

export const noteKindSchema = z.enum(["note", "scratchpad", "daily", "inbox"]);
export type NoteKind = z.infer<typeof noteKindSchema>;

export const noteSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  kind: noteKindSchema,
  color: noteColorSchema.nullable(),
  pinned: z.boolean(),
  /** Sticky visible only while this thread is on screen; null = everywhere. */
  pinnedThreadId: z.string().nullable(),
  /** Sticky visible on any thread of this project; null = not project-pinned. */
  pinnedProjectId: z.string().nullable(),
  stickyOpen: z.boolean(),
  collapsed: z.boolean(),
  /** Daily notes only: the YYYY-MM-DD the note is for. */
  dateKey: z.string().nullable(),
  taskTotal: z.number().int(),
  taskDone: z.number().int(),
  trashedAt: z.number().nullable(),
  originProjectId: z.string().nullable(),
  originThreadId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Note = z.infer<typeof noteSchema>;

/** A list row: the note plus an FTS match snippet when a query matched. */
export const listedNoteSchema = noteSchema.extend({
  matchSnippet: z.string().nullable(),
  /**
   * Title of the thread this note is bound to (a scratchpad's thread, a
   * pinned sticky's thread, or a captured note's origin), resolved
   * server-side so every surface can say WHERE a note lives.
   */
  threadTitle: z.string().nullable(),
  /**
   * Name of the project this note belongs to (its origin project, or the
   * project a sticky is pinned to). Null means the note is global — it is
   * not tied to any one project.
   */
  projectName: z.string().nullable(),
});
export type ListedNote = z.infer<typeof listedNoteSchema>;

export const tagCountSchema = z.object({
  name: z.string(),
  count: z.number().int(),
});
export type TagCount = z.infer<typeof tagCountSchema>;

export const rpcContract = {
  listNotes: {
    input: z
      .object({
        query: z.string().optional(),
        tag: z.string().optional(),
        view: z.enum(["active", "trash"]).optional(),
        /** Filter by origin thread (thread panel, scratchpad lookups). */
        threadId: z.string().optional(),
        kinds: z.array(noteKindSchema).optional(),
        /** Only notes whose sticky is open (content-script boot). */
        stickyOpen: z.boolean().optional(),
        sort: z.enum(["updated", "created", "title"]).optional(),
        limit: z.number().int().positive().max(500).optional(),
      })
      .strict(),
    output: z.object({
      notes: z.array(listedNoteSchema),
      tags: z.array(tagCountSchema),
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
        body: z.string().optional(),
        tags: z.array(z.string()).optional(),
        color: noteColorSchema.nullable().optional(),
        pinned: z.boolean().optional(),
        stickyOpen: z.boolean().optional(),
        originProjectId: z.string().nullable().optional(),
        originThreadId: z.string().nullable().optional(),
      })
      .strict(),
    output: z.object({ note: noteSchema }),
  },
  updateNote: {
    // Omitted field = untouched; explicit null = cleared.
    input: z
      .object({
        id: z.string(),
        body: z.string().optional(),
        tags: z.array(z.string()).optional(),
        pinned: z.boolean().optional(),
        color: noteColorSchema.nullable().optional(),
        stickyOpen: z.boolean().optional(),
        collapsed: z.boolean().optional(),
        pinnedThreadId: z.string().nullable().optional(),
        pinnedProjectId: z.string().nullable().optional(),
      })
      .strict(),
    output: z.object({ note: noteSchema }),
  },
  appendToNote: {
    input: z.object({ id: z.string(), text: z.string() }).strict(),
    output: z.object({ note: noteSchema }),
  },
  /** The thread's scratchpad, created on first touch. */
  scratchpad: {
    input: z
      .object({
        threadId: z.string(),
        projectId: z.string().nullable().optional(),
      })
      .strict(),
    output: z.object({ note: noteSchema, created: z.boolean() }),
  },
  dailyNote: {
    input: z.null(),
    output: z.object({ note: noteSchema, created: z.boolean() }),
  },
  /** The single quick-capture inbox note, created on first touch. */
  inboxNote: {
    input: z.null(),
    output: z.object({ note: noteSchema, created: z.boolean() }),
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
  /** Pasted image, stored as a BLOB with the note. ≤4MB decoded. */
  uploadAttachment: {
    input: z
      .object({
        noteId: z.string(),
        mime: z.string(),
        dataBase64: z.string(),
      })
      .strict(),
    output: z.object({ id: z.string() }),
  },
  getAttachment: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({
      attachment: z
        .object({ mime: z.string(), dataBase64: z.string() })
        .nullable(),
    }),
  },
  /** Autosave history: one revision of the pre-edit body every few minutes. */
  listRevisions: {
    input: z.object({ noteId: z.string() }).strict(),
    output: z.object({
      revisions: z.array(
        z.object({
          id: z.string(),
          createdAt: z.number(),
          chars: z.number().int(),
        }),
      ),
    }),
  },
  getRevision: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({
      revision: z
        .object({
          id: z.string(),
          noteId: z.string(),
          body: z.string(),
          createdAt: z.number(),
        })
        .nullable(),
    }),
  },
  /** Sets the note body to the revision (saving the current body first). */
  restoreRevision: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ note: noteSchema }),
  },
  listAttachments: {
    input: z.object({ noteId: z.string() }).strict(),
    output: z.object({
      attachments: z.array(
        z.object({
          id: z.string(),
          mime: z.string(),
          bytes: z.number().int(),
          createdAt: z.number(),
        }),
      ),
    }),
  },
  /** Removes the BLOB and strips its bbnote:// refs from the note body. */
  deleteAttachment: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ note: noteSchema.nullable() }),
  },
  /** Resolved plugin settings the app needs (shortcuts, font, capture). */
  clientConfig: {
    input: z.null(),
    output: z.object({
      shortcutEnabled: z.boolean(),
      captureShortcutEnabled: z.boolean(),
      fontSize: z.string(),
      defaultColor: z.string(),
      captureTarget: z.enum(["inbox", "scratchpad"]),
    }),
  },
} as const satisfies PluginRpcContract;
