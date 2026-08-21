// Pure note helpers — no SDK imports so they stay unit-testable.
import type { NoteKind } from "./contract";

export function deriveTitle(body: string): string {
  for (const line of body.split("\n")) {
    const cleaned = line
      .trim()
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, "")
      .replace(/^>\s+/, "")
      .trim();
    if (cleaned.length > 0) {
      return cleaned.length > 80 ? `${cleaned.slice(0, 79)}…` : cleaned;
    }
  }
  return "Untitled";
}

/** Preview text from the lines after the title line; "" for one-line notes. */
export function snippetFromBody(body: string): string {
  const lines = body.split("\n");
  const titleIndex = lines.findIndex((line) => line.trim().length > 0);
  if (titleIndex === -1) return "";
  return lines
    .slice(titleIndex + 1)
    .join(" ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 160);
}

/**
 * Split `text` into alternating plain/matched runs for `query`, so a row can
 * mark search hits without dangerous HTML. Odd indices are the matches; an
 * empty or unmatched query yields a single plain run.
 */
export function highlightRuns(text: string, query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [text];
  const haystack = text.toLowerCase();
  const runs: string[] = [];
  let cursor = 0;
  for (;;) {
    const hit = haystack.indexOf(needle, cursor);
    if (hit === -1) break;
    runs.push(text.slice(cursor, hit), text.slice(hit, hit + needle.length));
    cursor = hit + needle.length;
  }
  runs.push(text.slice(cursor));
  return runs;
}

/** The local calendar date as YYYY-MM-DD (daily-note title key). */
export function localDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  for (const tag of tags) {
    const cleaned = tag.trim().replace(/^#/, "").toLowerCase();
    if (cleaned.length > 0) seen.add(cleaned);
  }
  return [...seen].sort();
}

/** Checklist stats over markdown task lines ("- [ ]", "* [x]", "1. [X] …"). */
export function countTasks(body: string): { total: number; done: number } {
  let total = 0;
  let done = 0;
  for (const line of body.split("\n")) {
    // Keep byte-identical semantics with lib/editor/tasks.ts TASK_LINE_RE, or
    // the editor's progress ring and the list's disagree — notably on a
    // freshly typed `- [ ]` with nothing after the box yet.
    const match = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[( |x|X)\](?=[ \t]|$)/.exec(line);
    if (match === null) continue;
    total += 1;
    if (match[1] !== " ") done += 1;
  }
  return { total, done };
}

/**
 * Sanitize raw user input into an FTS5 MATCH expression: every term is quoted
 * (embedded double quotes doubled) and joined with implicit AND, and the last
 * term becomes a prefix query so results keep up while the user types.
 * Returns "" when the input holds no terms.
 */
export function ftsQuery(raw: string): string {
  const terms = raw
    .trim()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  return terms
    .map((term, index) => {
      const quoted = `"${term.replaceAll('"', '""')}"`;
      return index === terms.length - 1 ? `${quoted}*` : quoted;
    })
    .join(" ");
}

/**
 * Inline #hashtags in a body. Requires a letter right after the `#`, so
 * markdown headings (`# Title` — space follows), issue refs (`#123`), and hex
 * colors never match. Tags are 2–32 chars of [a-z0-9_-], lowercased.
 */
export function extractHashtags(body: string): string[] {
  const tags = new Set<string>();
  for (const match of body.matchAll(/(?:^|[\s(])#([a-z][a-z0-9_-]{1,31})\b/gim)) {
    tags.add(match[1]!.toLowerCase());
  }
  return [...tags].sort();
}

/** Append text on its own line, aware of a single trailing newline. */
export function appendToBody(body: string, text: string): string {
  if (body.length === 0) return text;
  return body.endsWith("\n") ? `${body}${text}` : `${body}\n${text}`;
}

/**
 * Attachment ids referenced by `bbnote://attachment/<id>` occurrences in a
 * body (image refs, links, or bare urls), deduped in order of first use.
 * The GC compares this set against the attachments table after body writes.
 */
export function referencedAttachmentIds(body: string): string[] {
  const ids = new Set<string>();
  for (const match of body.matchAll(/bbnote:\/\/attachment\/([A-Za-z0-9_-]+)/g)) {
    ids.add(match[1]!);
  }
  return [...ids];
}

/**
 * Remove every reference to one attachment from a body: markdown image refs
 * (`![alt](bbnote://attachment/<id>)`) and bare `bbnote://attachment/<id>`
 * urls. A line the ref had to itself is dropped entirely rather than left as
 * a stray blank; other attachments' refs (including ids this id prefixes)
 * are untouched.
 */
export function stripAttachmentRefs(body: string, id: string): string {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const imageRe = new RegExp(
    `!\\[[^\\]]*\\]\\(\\s*bbnote://attachment/${escaped}\\s*\\)`,
    "g",
  );
  const bareRe = new RegExp(
    `bbnote://attachment/${escaped}(?![A-Za-z0-9_-])`,
    "g",
  );
  const kept: string[] = [];
  for (const line of body.split("\n")) {
    const stripped = line.replace(imageRe, "").replace(bareRe, "");
    if (
      stripped !== line &&
      stripped.trim().length === 0 &&
      line.trim().length > 0
    ) {
      continue; // The ref was alone on this line — collapse the leftover blank.
    }
    kept.push(stripped);
  }
  return kept.join("\n");
}

/**
 * The unchecked task lines of a body, original indentation preserved, capped
 * at 30 (daily-note carry-over). Same line grammar as countTasks.
 */
export function uncheckedTaskLines(body: string): string[] {
  const lines: string[] = [];
  for (const line of body.split("\n")) {
    const match = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[( |x|X)\](?=[ \t]|$)/.exec(line);
    if (match === null || match[1] !== " ") continue;
    lines.push(line);
    if (lines.length >= 30) break;
  }
  return lines;
}

export interface ParsedSearchQuery {
  /** The free-text remainder after operators are pulled out. */
  text: string;
  tag?: string;
  kinds?: NoteKind[];
  view?: "trash";
  stickyOpen?: true;
  task?: "open" | "done";
  threadRef?: "current";
}

/** `in:` operator values → note kinds (plural forms map to their kind). */
const IN_KIND_TOKENS = new Map<string, NoteKind>([
  ["notes", "note"],
  ["scratchpads", "scratchpad"],
  ["scratchpad", "scratchpad"],
  ["daily", "daily"],
  ["inbox", "inbox"],
]);

/**
 * Parse search-box operators out of a raw query. Whitespace-separated
 * tokens: `tag:x` / whole-token `#x` → tag, `in:<kind>` → kinds,
 * `in:trash` → trash view, `is:sticky` → open stickies, `is:tasks`/`is:open`
 * → open tasks, `is:done` → done tasks, `thread:current` → current thread.
 * Anything else — including unknown `x:y` operators — joins the free text.
 */
export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const result: ParsedSearchQuery = { text: "" };
  const text: string[] = [];
  const kinds: NoteKind[] = [];
  for (const token of raw.split(/\s+/)) {
    if (token.length === 0) continue;
    const lower = token.toLowerCase();
    if (lower.startsWith("tag:") && lower.length > 4) {
      result.tag = lower.slice(4).replace(/^#/, "");
      continue;
    }
    if (lower.startsWith("#") && lower.length > 1) {
      result.tag = lower.slice(1);
      continue;
    }
    if (lower.startsWith("in:")) {
      const value = lower.slice(3);
      if (value === "trash") {
        result.view = "trash";
        continue;
      }
      const kind = IN_KIND_TOKENS.get(value);
      if (kind !== undefined) {
        if (!kinds.includes(kind)) kinds.push(kind);
        continue;
      }
      // Unknown in: value falls through to the free text.
    }
    if (lower === "is:sticky") {
      result.stickyOpen = true;
      continue;
    }
    if (lower === "is:tasks" || lower === "is:open") {
      result.task = "open";
      continue;
    }
    if (lower === "is:done") {
      result.task = "done";
      continue;
    }
    if (lower === "thread:current") {
      result.threadRef = "current";
      continue;
    }
    text.push(token);
  }
  result.text = text.join(" ");
  if (kinds.length > 0) result.kinds = kinds;
  return result;
}

/**
 * Filename-safe slug from a note title (export files): lowercased ASCII with
 * dash separators, diacritics folded, capped at 60 chars, "untitled" when
 * nothing survives.
 */
export function slug(title: string): string {
  const cleaned = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return cleaned.length > 0 ? cleaned : "untitled";
}

/** Align rows into two-space-guttered columns for plain-text CLI tables. */
export function alignColumns(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, index) =>
          index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
