// Where a note lives.
//
// Scope is the plugin's core organising idea: every note belongs to exactly
// one place — a project, a thread, one of the singletons, or nowhere in
// particular ("global"). The list groups by it, rows are tinted by it, and
// the editor names it, so a note's reach is never a guess. Pure and
// SDK-free so the rules stay unit-testable.
import type { ListedNote } from "./contract";

export type ScopeKind =
  | "inbox"
  | "daily"
  | "scratchpad"
  | "thread"
  | "project"
  | "global";

export interface NoteScope {
  kind: ScopeKind;
  /** The specific place: a project name, a thread title, or the family name. */
  label: string;
  /** Stable key for grouping rows into sections. */
  groupKey: string;
  /** Section heading for that group. */
  groupLabel: string;
  /** Sort rank of the section (lower first). */
  order: number;
}

const GLOBAL_ORDER = 20;
const PROJECT_ORDER = 10;
const SCRATCHPAD_ORDER = 30;
const DAILY_ORDER = 40;
const SINGLETON_ORDER = 0;

/**
 * Resolve a note's scope. Precedence matters: the singleton kinds describe
 * themselves, a scratchpad belongs to its thread, and an ordinary note
 * belongs to its project when it has one — otherwise to the thread it was
 * captured from, otherwise nowhere (global).
 */
export function noteScope(note: ListedNote): NoteScope {
  if (note.kind === "inbox") {
    return {
      kind: "inbox",
      label: "Inbox",
      groupKey: "inbox",
      groupLabel: "Inbox",
      order: SINGLETON_ORDER,
    };
  }
  if (note.kind === "daily") {
    return {
      kind: "daily",
      label: note.dateKey ?? "Daily note",
      groupKey: "daily",
      groupLabel: "Daily notes",
      order: DAILY_ORDER,
    };
  }
  if (note.kind === "scratchpad") {
    return {
      kind: "scratchpad",
      label: note.threadTitle ?? "Thread scratchpad",
      groupKey: "scratchpads",
      groupLabel: "Thread scratchpads",
      order: SCRATCHPAD_ORDER,
    };
  }
  if (note.projectName !== null) {
    return {
      kind: "project",
      label: note.projectName,
      groupKey: `project:${note.projectName}`,
      groupLabel: note.projectName,
      order: PROJECT_ORDER,
    };
  }
  if (note.threadTitle !== null) {
    return {
      kind: "thread",
      label: note.threadTitle,
      groupKey: "threads",
      groupLabel: "From threads",
      order: GLOBAL_ORDER + 1,
    };
  }
  return {
    kind: "global",
    label: "Global",
    groupKey: "global",
    groupLabel: "Global notes",
    order: GLOBAL_ORDER,
  };
}

export interface NoteSection {
  key: string;
  label: string;
  kind: ScopeKind;
  notes: ListedNote[];
}

/**
 * Group notes into display sections: pinned notes rise into their own
 * section (a pin is a promise the note stays reachable), everything else
 * falls under its scope. Section order is scope order, then name; note
 * order inside a section is preserved from the server.
 */
export function groupNotesByScope(notes: readonly ListedNote[]): {
  pinned: ListedNote[];
  sections: NoteSection[];
} {
  const pinned: ListedNote[] = [];
  const byKey = new Map<string, NoteSection & { order: number }>();
  for (const note of notes) {
    if (note.pinned) {
      pinned.push(note);
      continue;
    }
    const scope = noteScope(note);
    const existing = byKey.get(scope.groupKey);
    if (existing === undefined) {
      byKey.set(scope.groupKey, {
        key: scope.groupKey,
        label: scope.groupLabel,
        kind: scope.kind,
        order: scope.order,
        notes: [note],
      });
    } else {
      existing.notes.push(note);
    }
  }
  const sections = [...byKey.values()]
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
    .map(({ order: _order, ...section }) => section);
  return { pinned, sections };
}

/** The distinct projects present in a note list, for the filter row. */
export function projectsInNotes(notes: readonly ListedNote[]): string[] {
  const names = new Set<string>();
  for (const note of notes) {
    if (note.projectName !== null) names.add(note.projectName);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export type ScopeFilter =
  | { kind: "all" }
  | { kind: "global" }
  | { kind: "project"; name: string }
  | { kind: "threads" }
  | { kind: "daily" };

export function matchesScopeFilter(
  note: ListedNote,
  filter: ScopeFilter,
): boolean {
  if (filter.kind === "all") return true;
  const scope = noteScope(note);
  switch (filter.kind) {
    case "global":
      return scope.kind === "global" || scope.kind === "inbox";
    case "project":
      return scope.kind === "project" && scope.label === filter.name;
    case "threads":
      return scope.kind === "thread" || scope.kind === "scratchpad";
    case "daily":
      return scope.kind === "daily";
  }
}
