// Pure note helpers — no SDK imports so they stay unit-testable.

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
