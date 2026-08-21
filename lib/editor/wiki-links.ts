/**
 * `[[Target Note Title]]` wiki links for the live-markdown editor.
 *
 * `[[...]]` is not markdown syntax — the lezer tree never parses it — so a
 * ViewPlugin regex-scans the visible lines (via `scanWikiLinks`) and builds
 * decorations itself: the inner title renders as a link-styled pill
 * (`bbnotes-wikilink`) and the brackets are hidden except on lines touched
 * by the selection, mirroring the live-preview rule. Matches inside code
 * (fenced, indented, or inline) are left alone.
 *
 * Wiki links are internal, so a PLAIN click on a pill opens it — but only
 * when the pill's line is not part of the selection, so clicking into a line
 * to place the caret still works; ⌘/Ctrl-click opens from anywhere.
 *
 * Autocomplete: typing `[[` opens a completion listing the note titles the
 * host provides (case-insensitive substring match). Accepting inserts
 * `Title]]`, reusing any `]`/`]]` already ahead of the caret (closeBrackets
 * auto-inserts them) instead of doubling it. The whole extension is inert —
 * source returns null — while the host provides no titles.
 *
 * Config is callback-driven via a facet; the host passes stable functions
 * that read the latest props from refs, so prop updates never reconfigure
 * (let alone recreate) the view.
 */
import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  pickedCompletion,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { Facet, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { scanWikiLinks } from "./markdown-utils";

export interface WikiLinkConfig {
  /** Lazily read the current completion titles (empty ⇒ autocomplete inert). */
  completions?: () => readonly string[];
  /**
   * Open a wiki link. Returns whether a consumer actually handled it, so an
   * unhandled click can fall through to normal caret placement.
   */
  onOpen?: (target: string) => boolean;
}

const wikiLinkConfig = Facet.define<WikiLinkConfig, WikiLinkConfig>({
  combine: (values) => values[0] ?? {},
});

/* --- Decorations ------------------------------------------------------------ */

const CODE_NODES = new Set(["FencedCode", "CodeBlock", "InlineCode", "CodeText"]);

/** True when `pos` sits inside markdown code (top-level tree only). */
function inCode(state: EditorView["state"], pos: number): boolean {
  // `resolve` (not `resolveInner`) stays in the markdown tree, so a loaded
  // code-fence sub-language doesn't hide the FencedCode ancestor.
  let node: SyntaxNode | null = syntaxTree(state).resolve(pos, 1);
  for (; node; node = node.parent) {
    if (CODE_NODES.has(node.name)) return true;
  }
  return false;
}

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const { doc } = state;

  const activeLines = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = doc.lineAt(range.from).number;
    const last = doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) activeLines.add(n);
  }

  const decorations: Range<Decoration>[] = [];
  for (const visible of view.visibleRanges) {
    for (let pos = visible.from; pos <= visible.to; ) {
      const line = doc.lineAt(pos);
      for (const match of scanWikiLinks(line.text)) {
        const from = line.from + match.from;
        const to = line.from + match.to;
        if (inCode(state, from + 1)) continue;
        if (activeLines.has(line.number)) {
          // Active line: raw brackets stay visible, still styled as a pill.
          decorations.push(Decoration.mark({ class: "bbnotes-wikilink" }).range(from, to));
        } else {
          decorations.push(Decoration.replace({}).range(from, from + 2));
          decorations.push(Decoration.mark({ class: "bbnotes-wikilink" }).range(from + 2, to - 2));
          decorations.push(Decoration.replace({}).range(to - 2, to));
        }
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(decorations, true);
}

/* --- Click handling ---------------------------------------------------------- */

function handleMousedown(event: MouseEvent, view: EditorView): boolean {
  const config = view.state.facet(wikiLinkConfig);
  if (!config.onOpen) return false;
  const pill =
    event.target instanceof HTMLElement ? event.target.closest(".bbnotes-wikilink") : null;
  if (!pill || !view.dom.contains(pill)) return false;

  const pos = view.posAtDOM(pill);
  if (pos < 0 || pos > view.state.doc.length) return false;
  const line = view.state.doc.lineAt(pos);
  const match = scanWikiLinks(line.text).find(
    (m) => pos >= line.from + m.from && pos < line.from + m.to,
  );
  if (!match) return false;

  const mod = event.metaKey || event.ctrlKey;
  if (!mod) {
    // Plain click only opens when the pill's line is NOT part of the
    // selection; otherwise the click is caret placement in raw markdown.
    for (const range of view.state.selection.ranges) {
      if (range.to >= line.from && range.from <= line.to) return false;
    }
  }
  if (!config.onOpen(match.target)) return false;
  event.preventDefault();
  return true;
}

const wikiLinkPlugin = ViewPlugin.fromClass(
  class WikiLinkView {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    eventHandlers: {
      mousedown(event, view) {
        return handleMousedown(event, view);
      },
    },
  },
);

/* --- Autocomplete ------------------------------------------------------------ */

function applyWikiCompletion(
  view: EditorView,
  completion: Completion,
  from: number,
  to: number,
): void {
  const doc = view.state.doc;
  const ahead = doc.sliceString(to, Math.min(doc.length, to + 2));
  // closeBrackets (or the user) may already have typed the closing `]]`.
  const closing = ahead.startsWith("]]") ? "" : ahead.startsWith("]") ? "]" : "]]";
  view.dispatch({
    changes: { from, to, insert: completion.label + closing },
    selection: { anchor: from + completion.label.length + 2 },
    userEvent: "input.complete",
    annotations: pickedCompletion.of(completion),
  });
}

function wikiCompletionSource(context: CompletionContext): CompletionResult | null {
  const titles = context.state.facet(wikiLinkConfig).completions?.() ?? [];
  if (titles.length === 0) return null; // inert without titles
  const open = context.matchBefore(/\[\[[^\][]*$/);
  if (!open) return null;
  const from = open.from + 2;
  const query = context.state.sliceDoc(from, context.pos).toLowerCase();
  const options: Completion[] = [];
  for (const title of titles) {
    if (query !== "" && !title.toLowerCase().includes(query)) continue;
    options.push({ label: title, type: "text", apply: applyWikiCompletion });
  }
  if (options.length === 0) return null;
  // filter: false — matching is our case-insensitive substring test above;
  // the source is cheap, so CodeMirror just re-queries as the user types.
  return { from, to: context.pos, options, filter: false };
}

/* --- Extension ---------------------------------------------------------------- */

/**
 * The wiki-link extension: pill decorations + click-to-open + `[[` note-title
 * autocomplete. Pass stable callbacks (wrap refs in the host). Place BEFORE
 * `livePreview()` so wiki clicks win over generic link handling.
 */
export function wikiLinks(config: WikiLinkConfig = {}): Extension {
  return [
    wikiLinkConfig.of(config),
    wikiLinkPlugin,
    autocompletion({ override: [wikiCompletionSource] }),
  ];
}
