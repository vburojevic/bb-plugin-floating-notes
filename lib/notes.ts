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
