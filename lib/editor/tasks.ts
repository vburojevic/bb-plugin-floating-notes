/**
 * Pure task-list helpers shared by the live-preview extension and the host
 * app (task counts, checkbox toggling). No CodeMirror imports — everything
 * here is plain string math so it stays unit-testable.
 *
 * A "task line" is a GFM task list item: optional indentation, a list marker
 * (`-`, `*`, `+`, or a number followed by `.`/`)`), whitespace, then a
 * checkbox `[ ]`, `[x]`, or `[X]` followed by whitespace or end of line.
 *
 * Bodies are assumed to use `\n` line endings (no CRLF).
 */

export interface TaskCounts {
  total: number;
  done: number;
}

/**
 * Matches a task line. Group 1 is everything before the `[`; group 2 is the
 * checkbox character (` `, `x`, or `X`).
 */
const TASK_LINE_RE = /^([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[( |x|X)\](?=[ \t]|$)/;

/**
 * Returns the 0-based column of the checkbox character (the ` `/`x`/`X`
 * between the brackets) in `lineText`, or `null` if the line is not a task
 * list item.
 */
export function findTaskBoxInLine(lineText: string): number | null {
  const match = TASK_LINE_RE.exec(lineText);
  if (!match) return null;
  return match[1].length + 1;
}

/** Counts task list items in `body`, and how many of them are checked. */
export function countTasks(body: string): TaskCounts {
  let total = 0;
  let done = 0;
  for (const line of body.split("\n")) {
    const match = TASK_LINE_RE.exec(line);
    if (!match) continue;
    total += 1;
    if (match[2] !== " ") done += 1;
  }
  return { total, done };
}

/**
 * Toggles the checkbox of the task line starting at `lineStartOffset` in
 * `body`. Returns the new body, or `null` when `lineStartOffset` is not the
 * start of a line or the line is not a task list item. ` ` becomes `x`;
 * `x`/`X` become ` `.
 */
export function toggleTaskAt(body: string, lineStartOffset: number): string | null {
  if (lineStartOffset < 0 || lineStartOffset > body.length) return null;
  if (lineStartOffset > 0 && body.charAt(lineStartOffset - 1) !== "\n") return null;

  const lineEnd = body.indexOf("\n", lineStartOffset);
  const lineText = body.slice(lineStartOffset, lineEnd === -1 ? body.length : lineEnd);
  const column = findTaskBoxInLine(lineText);
  if (column === null) return null;

  const at = lineStartOffset + column;
  const next = lineText.charAt(column) === " " ? "x" : " ";
  return body.slice(0, at) + next + body.slice(at + 1);
}
