/**
 * Pure markdown-editing helpers shared by the editor component and the
 * wiki-link extension. No CodeMirror imports — everything here is plain
 * string/offset math so it stays unit-testable (same pattern as `tasks.ts`).
 */

/* --- Wiki links ------------------------------------------------------------ */

export interface WikiLinkMatch {
  /** Offset of the opening `[[` within the line. */
  from: number;
  /** Offset just past the closing `]]` within the line. */
  to: number;
  /** Inner text, trimmed. Never empty. */
  target: string;
}

/**
 * Scans a single line of text for `[[Target]]` wiki links. `[[...]]` is not
 * markdown syntax (the lezer tree never contains it), so this regex pass is
 * the source of truth for both decoration and click handling. Matches with a
 * whitespace-only target are skipped.
 */
export function scanWikiLinks(lineText: string): WikiLinkMatch[] {
  const re = /\[\[([^\][\n]+)\]\]/g;
  const matches: WikiLinkMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(lineText)) !== null) {
    const target = match[1].trim();
    if (target === "") continue;
    matches.push({ from: match.index, to: match.index + match[0].length, target });
  }
  return matches;
}

/* --- Bare URLs -------------------------------------------------------------- */

/**
 * True when `text` (ignoring surrounding whitespace, e.g. a clipboard's
 * trailing newline) is a single bare http(s) URL token — no spaces, no extra
 * words. Used to turn "paste URL over selection" into a markdown link.
 */
export function isBareUrl(text: string): boolean {
  return /^https?:\/\/[^\s<>]+$/i.test(text.trim());
}

/* --- Inline-mark wrapping --------------------------------------------------- */

export interface WrapChange {
  from: number;
  to: number;
  insert: string;
}

export interface WrapResult {
  changes: WrapChange[];
  /** Selection after the edit (document offsets, pre-mapping). */
  anchor: number;
  head: number;
}

/**
 * Range math for wrapping/unwrapping `[from, to)` of `text` with an inline
 * marker (`**`, `*`, `~~`). Unwraps when the marker already directly
 * surrounds the selection (outside it) or pads it (inside it); wraps
 * otherwise. Callers feed `changes` to CodeMirror's `changeByRange`.
 */
export function wrapSelectionWith(
  marker: string,
  text: string,
  from: number,
  to: number,
): WrapResult {
  const len = marker.length;
  const selected = text.slice(from, to);
  const before = text.slice(Math.max(0, from - len), from);
  const after = text.slice(to, Math.min(text.length, to + len));
  if (before === marker && after === marker) {
    return {
      changes: [
        { from: from - len, to: from, insert: "" },
        { from: to, to: to + len, insert: "" },
      ],
      anchor: from - len,
      head: to - len,
    };
  }
  if (selected.length >= len * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
    return {
      changes: [
        { from, to: from + len, insert: "" },
        { from: to - len, to, insert: "" },
      ],
      anchor: from,
      head: to - len * 2,
    };
  }
  return {
    changes: [
      { from, to: from, insert: marker },
      { from: to, to, insert: marker },
    ],
    anchor: from + len,
    head: to + len,
  };
}

/* --- Markdown links ---------------------------------------------------------- */

export interface LinkSnippet {
  /** Text that replaces the selection. */
  text: string;
  /** Selection after insert, relative to the insert position. */
  anchor: number;
  head: number;
}

/**
 * Builds the `[label](url)` snippet for the insert-link command. With a
 * selection the caret lands in the url parens (the `url` placeholder is
 * selected so typing replaces it); with an empty selection the caret lands
 * in the empty label.
 */
export function markdownLinkSnippet(selected: string): LinkSnippet {
  if (selected === "") {
    return { text: "[](url)", anchor: 1, head: 1 };
  }
  const urlStart = selected.length + 3; // past `[`, the label, and `](`
  return { text: `[${selected}](url)`, anchor: urlStart, head: urlStart + 3 };
}

/* --- Tables ------------------------------------------------------------------ */

/**
 * True when a line inside a GFM table is the delimiter row (`| --- | :-: |`).
 * Only meaningful for lines already known to be part of a table.
 */
export function isTableDelimiterLine(lineText: string): boolean {
  return lineText.includes("-") && /^[\s|:-]+$/.test(lineText);
}
