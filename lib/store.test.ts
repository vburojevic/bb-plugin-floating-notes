import { beforeEach, expect, it, vi } from "vitest";

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("./rpc", () => ({ createRpcClient: () => ({ call }) }));

beforeEach(() => { vi.resetModules(); call.mockReset(); });

function setup() {
  const list = {
    notes: Array.from({ length: 500 }, (_, i) => ({ id: String(i), body: "body ".repeat(100), tags: ["work"], updatedAt: 1 })),
    tags: [{ name: "work", count: 500 }], counts: { active: 500, trashed: 0 },
  };
  call.mockImplementation(async (method: string) => structuredClone(method === "listNotes" ? list : {
    shortcutEnabled: true, captureShortcutEnabled: true, fontSize: "14", defaultColor: "none", captureTarget: "inbox",
  }));
  return list;
}

it("does not notify 500-note consumers for an unchanged poll", async () => {
  setup();
  const { notesStore } = await import("./store");
  await notesStore.refresh();
  const previous = notesStore.get();
  const listener = vi.fn();
  const unsubscribe = notesStore.subscribe(listener);
  await notesStore.refresh();
  expect(notesStore.get()).toBe(previous);
  expect(listener).not.toHaveBeenCalled();
  unsubscribe();
});

it("publishes edits while retaining unrelated notes and metadata", async () => {
  const list = setup();
  const { notesStore } = await import("./store");
  await notesStore.refresh();
  const previous = notesStore.get();
  const listener = vi.fn();
  const unsubscribe = notesStore.subscribe(listener);
  list.notes[7]!.body = "changed";
  await notesStore.refresh();
  const next = notesStore.get();
  expect(listener).toHaveBeenCalledTimes(1);
  expect(next.notes[7]!.body).toBe("changed");
  expect(next.notes[6]).toBe(previous.notes[6]);
  expect(next.tags).toBe(previous.tags);
  expect(next.config).toBe(previous.config);
  unsubscribe();
});
