import { describe, expect, it } from "vitest";
import {
  groupNotesByScope,
  matchesScopeFilter,
  noteScope,
  projectsInNotes,
} from "./scope";
import type { ListedNote } from "./contract";

function note(patch: Partial<ListedNote> = {}): ListedNote {
  return {
    id: "n1",
    title: "Title",
    body: "Body",
    tags: [],
    kind: "note",
    color: null,
    pinned: false,
    pinnedThreadId: null,
    pinnedProjectId: null,
    stickyOpen: false,
    collapsed: false,
    dateKey: null,
    taskTotal: 0,
    taskDone: 0,
    trashedAt: null,
    originProjectId: null,
    originThreadId: null,
    createdAt: 0,
    updatedAt: 0,
    matchSnippet: null,
    threadTitle: null,
    projectName: null,
    ...patch,
  };
}

describe("noteScope", () => {
  it("calls a note with no project and no thread global", () => {
    expect(noteScope(note())).toMatchObject({ kind: "global", label: "Global" });
  });
  it("prefers the project over the thread it was captured from", () => {
    const scope = noteScope(note({ projectName: "Chefsy", threadTitle: "Fix login" }));
    expect(scope).toMatchObject({ kind: "project", label: "Chefsy" });
    expect(scope.groupKey).toBe("project:Chefsy");
  });
  it("files a projectless captured note under its thread", () => {
    expect(noteScope(note({ threadTitle: "Fix login" }))).toMatchObject({
      kind: "thread",
      label: "Fix login",
    });
  });
  it("names a scratchpad for its thread, and falls back when the thread is gone", () => {
    expect(noteScope(note({ kind: "scratchpad", threadTitle: "Ship v2" })).label).toBe("Ship v2");
    expect(noteScope(note({ kind: "scratchpad" })).label).toBe("Thread scratchpad");
  });
  it("describes the singleton kinds by themselves", () => {
    expect(noteScope(note({ kind: "inbox" })).kind).toBe("inbox");
    expect(noteScope(note({ kind: "daily", dateKey: "2026-09-08" })).label).toBe("2026-09-08");
  });
});

describe("groupNotesByScope", () => {
  it("lifts pinned notes out and groups the rest by scope", () => {
    const { pinned, sections } = groupNotesByScope([
      note({ id: "a", pinned: true, projectName: "Chefsy" }),
      note({ id: "b", projectName: "Chefsy" }),
      note({ id: "c" }),
      note({ id: "d", kind: "daily" }),
    ]);
    expect(pinned.map((n) => n.id)).toEqual(["a"]);
    expect(sections.map((s) => s.key)).toEqual(["project:Chefsy", "global", "daily"]);
    expect(sections[0]!.notes.map((n) => n.id)).toEqual(["b"]);
  });
  it("orders projects before global and sorts projects by name", () => {
    const { sections } = groupNotesByScope([
      note({ id: "a" }),
      note({ id: "b", projectName: "Zeta" }),
      note({ id: "c", projectName: "Alpha" }),
    ]);
    expect(sections.map((s) => s.label)).toEqual(["Alpha", "Zeta", "Global notes"]);
  });
  it("preserves server order inside a section", () => {
    const { sections } = groupNotesByScope([
      note({ id: "first" }),
      note({ id: "second" }),
    ]);
    expect(sections[0]!.notes.map((n) => n.id)).toEqual(["first", "second"]);
  });
});

describe("projectsInNotes", () => {
  it("returns distinct project names sorted", () => {
    expect(
      projectsInNotes([
        note({ projectName: "Zeta" }),
        note({ projectName: "Alpha" }),
        note({ projectName: "Zeta" }),
        note(),
      ]),
    ).toEqual(["Alpha", "Zeta"]);
  });
});

describe("matchesScopeFilter", () => {
  it("passes everything for all", () => {
    expect(matchesScopeFilter(note(), { kind: "all" })).toBe(true);
  });
  it("counts the inbox as global", () => {
    expect(matchesScopeFilter(note({ kind: "inbox" }), { kind: "global" })).toBe(true);
    expect(matchesScopeFilter(note({ projectName: "X" }), { kind: "global" })).toBe(false);
  });
  it("matches a project by name only", () => {
    expect(matchesScopeFilter(note({ projectName: "X" }), { kind: "project", name: "X" })).toBe(true);
    expect(matchesScopeFilter(note({ projectName: "Y" }), { kind: "project", name: "X" })).toBe(false);
  });
  it("groups scratchpads with thread notes", () => {
    expect(matchesScopeFilter(note({ kind: "scratchpad" }), { kind: "threads" })).toBe(true);
    expect(matchesScopeFilter(note({ threadTitle: "T" }), { kind: "threads" })).toBe(true);
  });
});
