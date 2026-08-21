// Transient smoke test for server.ts against an in-memory SQLite database.
// Not part of the suite — deleted after the run.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

vi.mock("@bb/plugin-sdk", () => ({}));

import plugin from "./server";

async function boot() {
  const db = new Database(":memory:");
  const kv = new Map<string, unknown>();
  const rpc: Record<string, (input: unknown) => unknown> = {};
  let cli: { run: (argv: string[], ctx: Record<string, unknown>) => Promise<{ exitCode: number; stdout?: string; stderr?: string }> } | null = null;
  const bb = {
    settings: {
      define: () => ({
        get: async () => ({
          shortcutEnabled: true,
          captureShortcutEnabled: true,
          fontSize: "14",
          defaultColor: "none",
          captureTarget: "inbox",
        }),
        onChange: () => {},
      }),
    },
    storage: {
      database: () => db,
      migrate: (d: InstanceType<typeof Database>, statements: string[]) => {
        for (const statement of statements) d.exec(statement);
      },
      kv: {
        get: async (key: string) => kv.get(key),
        set: async (key: string, value: unknown) => {
          kv.set(key, value);
        },
      },
    },
    realtime: { publish: () => {} },
    log: { info: () => {}, warn: () => {} },
    sdk: {
      threads: {
        get: async () => {
          throw new Error("no thread");
        },
      },
    },
    rpc: {
      register: (_contract: unknown, handlers: Record<string, (input: unknown) => unknown>) => {
        Object.assign(rpc, handlers);
      },
    },
    ui: { registerMentionProvider: () => {} },
    cli: { register: (registration: never) => { cli = registration; } },
    agents: { registerTool: () => {} },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await plugin(bb as any);
  return { db, rpc, cli: cli! };
}

describe("server smoke", () => {
  it("migrates, snapshots revisions with the 4-minute rule, and restores", async () => {
    const { db, rpc } = await boot();
    const { note } = (await rpc.createNote({ body: "v1 body" })) as { note: { id: string } };
    // First body change snapshots the previous body.
    await rpc.updateNote({ id: note.id, body: "v2 body" });
    let { revisions } = (await rpc.listRevisions({ noteId: note.id })) as {
      revisions: Array<{ id: string; chars: number; createdAt: number }>;
    };
    expect(revisions.length).toBe(1);
    expect(revisions[0]!.chars).toBe("v1 body".length);
    // Second change within 4 minutes: no new snapshot.
    await rpc.updateNote({ id: note.id, body: "v3 body" });
    revisions = ((await rpc.listRevisions({ noteId: note.id })) as { revisions: [] }).revisions;
    expect(revisions.length).toBe(1);
    // Metadata-only update: never snapshots.
    await rpc.updateNote({ id: note.id, pinned: true });
    expect(
      ((await rpc.listRevisions({ noteId: note.id })) as { revisions: [] }).revisions.length,
    ).toBe(1);
    // Age the newest revision past 4 minutes: next body change snapshots.
    db.prepare("UPDATE note_revisions SET created_at = created_at - 300000").run();
    await rpc.updateNote({ id: note.id, body: "v4 body" });
    const list = (await rpc.listRevisions({ noteId: note.id })) as {
      revisions: Array<{ id: string; chars: number }>;
    };
    expect(list.revisions.length).toBe(2);
    expect(list.revisions[0]!.chars).toBe("v3 body".length); // newest first
    // getRevision round-trips the full row.
    const { revision } = (await rpc.getRevision({ id: list.revisions[0]!.id })) as {
      revision: { body: string; noteId: string };
    };
    expect(revision.body).toBe("v3 body");
    expect(revision.noteId).toBe(note.id);
    // restoreRevision snapshots the current body unconditionally, then restores.
    const restored = (await rpc.restoreRevision({ id: list.revisions[0]!.id })) as {
      note: { body: string; title: string };
    };
    expect(restored.note.body).toBe("v3 body");
    const after = (await rpc.listRevisions({ noteId: note.id })) as {
      revisions: Array<{ chars: number }>;
    };
    expect(after.revisions.length).toBe(3);
    expect(after.revisions[0]!.chars).toBe("v4 body".length);
    expect((await rpc.getRevision({ id: "nope" }) as { revision: null }).revision).toBeNull();
  });

  it("prunes revisions past 20 and deletes them on purge", async () => {
    const { db, rpc } = await boot();
    const { note } = (await rpc.createNote({ body: "start" })) as { note: { id: string } };
    for (let i = 0; i < 25; i++) {
      await rpc.updateNote({ id: note.id, body: `body ${i}` });
      db.prepare("UPDATE note_revisions SET created_at = created_at - 300000").run();
    }
    const { revisions } = (await rpc.listRevisions({ noteId: note.id })) as {
      revisions: unknown[];
    };
    expect(revisions.length).toBe(20);
    await rpc.trashNote({ id: note.id });
    await rpc.purgeNote({ id: note.id });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM note_revisions").get() as { n: number }).n,
    ).toBe(0);
  });

  it("keeps pinnedProjectId and pinnedThreadId independent; trash clears both", async () => {
    const { rpc } = await boot();
    const { note } = (await rpc.createNote({ body: "sticky" })) as { note: { id: string } };
    let updated = (await rpc.updateNote({ id: note.id, pinnedThreadId: "t1" })) as {
      note: { pinnedThreadId: string | null; pinnedProjectId: string | null };
    };
    updated = (await rpc.updateNote({ id: note.id, pinnedProjectId: "p1" })) as typeof updated;
    expect(updated.note.pinnedThreadId).toBe("t1");
    expect(updated.note.pinnedProjectId).toBe("p1");
    updated = (await rpc.updateNote({ id: note.id, pinnedThreadId: null })) as typeof updated;
    expect(updated.note.pinnedThreadId).toBeNull();
    expect(updated.note.pinnedProjectId).toBe("p1");
    const trashed = (await rpc.trashNote({ id: note.id })) as {
      note: { pinnedProjectId: string | null; pinnedThreadId: string | null };
    };
    expect(trashed.note.pinnedProjectId).toBeNull();
    expect(trashed.note.pinnedThreadId).toBeNull();
  });

  it("garbage-collects unreferenced attachments past the grace period", async () => {
    const { db, rpc } = await boot();
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    const { note } = (await rpc.createNote({ body: "with image" })) as { note: { id: string } };
    const { id: oldId } = (await rpc.uploadAttachment({
      noteId: note.id,
      mime: "image/png",
      dataBase64: png,
    })) as { id: string };
    const { id: freshId } = (await rpc.uploadAttachment({
      noteId: note.id,
      mime: "image/png",
      dataBase64: png,
    })) as { id: string };
    const { id: keptId } = (await rpc.uploadAttachment({
      noteId: note.id,
      mime: "image/png",
      dataBase64: png,
    })) as { id: string };
    // Age two of them past the 10-minute grace; keep one referenced.
    db.prepare("UPDATE attachments SET created_at = created_at - 700000 WHERE id IN (?, ?)").run(
      oldId,
      keptId,
    );
    await rpc.updateNote({
      id: note.id,
      body: `still here ![img](bbnote://attachment/${keptId})`,
    });
    const remaining = (await rpc.listAttachments({ noteId: note.id })) as {
      attachments: Array<{ id: string; bytes: number }>;
    };
    const ids = remaining.attachments.map((a) => a.id).sort();
    expect(ids).toEqual([freshId, keptId].sort()); // old unreferenced GC'd, fresh survives grace
    expect(remaining.attachments.every((a) => a.bytes === 8)).toBe(true);
  });

  it("deleteAttachment strips refs, collapses the line, and returns the note", async () => {
    const { rpc } = await boot();
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    const { note } = (await rpc.createNote({ body: "title line" })) as { note: { id: string } };
    const { id } = (await rpc.uploadAttachment({
      noteId: note.id,
      mime: "image/png",
      dataBase64: png,
    })) as { id: string };
    await rpc.updateNote({
      id: note.id,
      body: `title line\n![shot](bbnote://attachment/${id})\ntail`,
    });
    const result = (await rpc.deleteAttachment({ id })) as { note: { body: string } | null };
    expect(result.note?.body).toBe("title line\ntail");
    expect(
      ((await rpc.listAttachments({ noteId: note.id })) as { attachments: [] }).attachments.length,
    ).toBe(0);
    expect(((await rpc.deleteAttachment({ id: "missing" })) as { note: null }).note).toBeNull();
  });

  it("carries unchecked tasks into a freshly created daily note", async () => {
    const { db, rpc } = await boot();
    db.prepare(
      `INSERT INTO notes (id, title, body, tags, kind, color, pinned, sticky_open, collapsed, date_key, task_total, task_done, created_at, updated_at)
       VALUES ('prevdaily1', '2000-01-01', '# 2000-01-01\n\n- [ ] pay rent\n  - [ ] nested chore\n- [x] done thing\n', '[]', 'daily', NULL, 0, 0, 0, '2000-01-01', 3, 1, 1, 1)`,
    ).run();
    const { note, created } = (await rpc.dailyNote(null)) as {
      note: { body: string; kind: string };
      created: boolean;
    };
    expect(created).toBe(true);
    expect(note.body).toContain("## Carried over\n- [ ] pay rent\n  - [ ] nested chore\n");
    expect(note.body).not.toContain("done thing");
    // Second call: existing note, no re-seed.
    const again = (await rpc.dailyNote(null)) as { created: boolean; note: { body: string } };
    expect(again.created).toBe(false);
    expect(again.note.body).toBe(note.body);
  });

  it("exports and imports notes through the CLI", async () => {
    const first = await boot();
    await first.rpc.createNote({ body: "# Export me\n\nhello", tags: ["work"] });
    const trashedNote = (await first.rpc.createNote({ body: "trashed" })) as {
      note: { id: string };
    };
    await first.rpc.trashNote({ id: trashedNote.note.id });
    const dir = mkdtempSync(join(tmpdir(), "bb-notes-smoke-"));
    try {
      const exported = await first.cli.run(["export", dir], {});
      expect(exported.exitCode).toBe(0);
      expect(exported.stdout).toContain("Exported 1 note");
      const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
      expect(files.length).toBe(1);
      expect(files[0]!.startsWith("export-me-")).toBe(true);
      const raw = readFileSync(join(dir, files[0]!), "utf8");
      expect(raw.startsWith("---\nid: ")).toBe(true);
      expect(raw).toContain('tags: ["work"]');
      expect(raw.endsWith("# Export me\n\nhello")).toBe(true);
      // Malformed file: fence never closes.
      writeFileSync(join(dir, "broken.md"), "---\nid: zzz\nno closing fence");
      // Import into a fresh instance: unknown id creates; then re-import updates.
      const second = await boot();
      let imported = await second.cli.run(["import", dir], {});
      expect(imported.exitCode).toBe(0);
      expect(imported.stdout).toBe("Imported: 1 created, 0 updated.");
      expect(imported.stderr).toContain("broken.md");
      const listed = (await second.rpc.listNotes({})) as {
        notes: Array<{ id: string; title: string; tags: string[]; body: string }>;
      };
      expect(listed.notes.length).toBe(1);
      expect(listed.notes[0]!.title).toBe("Export me");
      expect(listed.notes[0]!.tags).toEqual(["work"]);
      // Export from the second instance, tweak, re-import: updates in place.
      const dir2 = mkdtempSync(join(tmpdir(), "bb-notes-smoke2-"));
      try {
        await second.cli.run(["export", dir2], {});
        const name = readdirSync(dir2).find((f) => f.endsWith(".md"))!;
        const content = readFileSync(join(dir2, name), "utf8");
        writeFileSync(join(dir2, name), content.replace("hello", "hello again"));
        imported = await second.cli.run(["import", dir2], {});
        expect(imported.stdout).toBe("Imported: 0 created, 1 updated.");
        const relisted = (await second.rpc.listNotes({})) as {
          notes: Array<{ body: string }>;
        };
        expect(relisted.notes.length).toBe(1);
        expect(relisted.notes[0]!.body).toContain("hello again");
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
