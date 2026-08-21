/**
 * Obsidian-style live markdown preview for CodeMirror 6.
 *
 * A ViewPlugin walks the syntax tree over the visible ranges only and builds
 * decorations that hide formatting marks (`**`, `#`, link urls, …) on every
 * line NOT touched by a selection cursor; on active lines the raw markdown
 * shows. Headings, quotes, tasks, and fenced code get line classes; tasks get
 * a clickable checkbox widget; bullets become dots; images render inline
 * through an async, per-view-cached resolver.
 *
 * Everything is callback-driven via a facet (`livePreview(config)`) — no
 * fetch/RPC in this module. All classes are defined in `editor.css` and
 * prefixed `bbnotes-`.
 */
import { syntaxTree } from "@codemirror/language";
import { Facet, type Extension, type Range, type Text } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common";
import { isTableDelimiterLine } from "./markdown-utils";
import { findTaskBoxInLine } from "./tasks";

export interface LivePreviewConfig {
  /** Called when the user ⌘/Ctrl-clicks a link. */
  onOpenLink?: (href: string) => void;
  /** Resolves a `bbnote://attachment/<id>` reference to a data: URI (or null). */
  resolveAttachment?: (id: string) => Promise<string | null>;
}

const livePreviewConfig = Facet.define<LivePreviewConfig, LivePreviewConfig>({
  combine: (values) => values[0] ?? {},
});

/** `bbnote://attachment/<id>` — group 1 is the attachment id. */
const ATTACHMENT_URL_RE = /^bbnote:\/\/attachment\/(.+)$/;

interface ImageCache {
  /** attachment id → resolved data: URI, or null when resolution failed. */
  readonly resolved: Map<string, string | null>;
  readonly pending: Map<string, Promise<string | null>>;
}

/* --- Widgets --------------------------------------------------------------- */

class CheckboxWidget extends WidgetType {
  constructor(private readonly checked: boolean) {
    super();
  }

  override eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }

  override toDOM(): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "bbnotes-task-checkbox";
    box.checked = this.checked;
    box.setAttribute(
      "aria-label",
      this.checked ? "Completed task (click to reopen)" : "Open task (click to complete)",
    );
    return box;
  }

  /** Let the editor see events so the plugin's mousedown handler can toggle. */
  override ignoreEvent(): boolean {
    return false;
  }
}

class BulletWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }

  override toDOM(): HTMLElement {
    const dot = document.createElement("span");
    dot.className = "bbnotes-bullet";
    dot.textContent = "•";
    return dot;
  }
}

class HrWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }

  override toDOM(): HTMLElement {
    const rule = document.createElement("span");
    rule.className = "bbnotes-hr";
    return rule;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    private readonly src: string,
    private readonly alt: string,
    private readonly cache: ImageCache,
    private readonly resolveAttachment: ((id: string) => Promise<string | null>) | undefined,
  ) {
    super();
  }

  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "bbnotes-image";
    const img = document.createElement("img");
    img.alt = this.alt;
    img.draggable = false;
    wrap.appendChild(img);

    const match = ATTACHMENT_URL_RE.exec(this.src);
    if (!match) {
      // Plain http(s) (or other) URL: let the browser load it directly.
      img.src = this.src;
      return wrap;
    }

    const id = match[1];
    const cached = this.cache.resolved.get(id);
    if (cached !== undefined) {
      if (cached === null) wrap.classList.add("bbnotes-image-broken");
      else img.src = cached;
      return wrap;
    }
    if (!this.resolveAttachment) {
      wrap.classList.add("bbnotes-image-broken");
      return wrap;
    }

    wrap.classList.add("bbnotes-image-pending");
    let pending = this.cache.pending.get(id);
    if (!pending) {
      pending = this.resolveAttachment(id).catch(() => null);
      this.cache.pending.set(id, pending);
    }
    void pending.then((uri) => {
      this.cache.resolved.set(id, uri);
      this.cache.pending.delete(id);
      wrap.classList.remove("bbnotes-image-pending");
      if (uri === null) wrap.classList.add("bbnotes-image-broken");
      else img.src = uri;
    });
    return wrap;
  }
}

/* --- Decoration building --------------------------------------------------- */

/**
 * `[[Target]]` wiki links (owned by `wiki-links.ts`) confuse the markdown
 * parser: it sees the inner `[Target]` as a shortcut-reference Link. Detect
 * that shape — a URL-less Link directly wrapped in one more bracket pair —
 * so both decoration and ⌘-click link resolution can leave it alone.
 */
function isWikiWrappedLink(doc: Text, node: SyntaxNode): boolean {
  if (node.getChild("URL")) return false;
  return (
    doc.sliceString(Math.max(0, node.from - 1), node.from) === "[" &&
    doc.sliceString(node.to, Math.min(doc.length, node.to + 1)) === "]"
  );
}

const HEADING_LINE_CLASS: Record<string, string> = {
  ATXHeading1: "bbnotes-h1",
  ATXHeading2: "bbnotes-h2",
  ATXHeading3: "bbnotes-h3",
  ATXHeading4: "bbnotes-h4",
  ATXHeading5: "bbnotes-h5",
  ATXHeading6: "bbnotes-h6",
};

function buildDecorations(view: EditorView, images: ImageCache): DecorationSet {
  const { state } = view;
  const { doc } = state;
  const config = state.facet(livePreviewConfig);

  // Lines touched by any selection cursor keep their raw markdown visible.
  const activeLines = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = doc.lineAt(range.from).number;
    const last = doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) activeLines.add(n);
  }
  const lineIsActive = (pos: number): boolean => activeLines.has(doc.lineAt(pos).number);

  const decorations: Range<Decoration>[] = [];
  // line start offset → classes; deduped so nested nodes don't double-apply.
  const lineClasses = new Map<number, Set<string>>();
  const addLineClass = (pos: number, cls: string): void => {
    const lineFrom = doc.lineAt(pos).from;
    let set = lineClasses.get(lineFrom);
    if (!set) {
      set = new Set();
      lineClasses.set(lineFrom, set);
    }
    set.add(cls);
  };
  /** Adds a line class to every visible line spanned by [from, to]. */
  const addLineClassRange = (
    from: number,
    to: number,
    visibleFrom: number,
    visibleTo: number,
    cls: (lineNumber: number, firstNumber: number, lastNumber: number) => string[],
  ): void => {
    const firstNumber = doc.lineAt(from).number;
    const lastNumber = doc.lineAt(to).number;
    const clampFirst = doc.lineAt(Math.max(from, visibleFrom)).number;
    const clampLast = doc.lineAt(Math.min(to, visibleTo)).number;
    for (let n = clampFirst; n <= clampLast; n++) {
      const line = doc.line(n);
      for (const name of cls(n, firstNumber, lastNumber)) addLineClass(line.from, name);
    }
  };
  const hide = (from: number, to: number): void => {
    if (to > from) decorations.push(Decoration.replace({}).range(from, to));
  };
  /** Hides a mark plus a single following space, if present. */
  const hideWithSpace = (from: number, to: number): void => {
    hide(from, doc.sliceString(to, to + 1) === " " ? to + 1 : to);
  };
  const mark = (from: number, to: number, cls: string): void => {
    if (to > from) decorations.push(Decoration.mark({ class: cls }).range(from, to));
  };
  const replaceWith = (from: number, to: number, widget: WidgetType): void => {
    decorations.push(Decoration.replace({ widget }).range(from, to));
  };

  const enterNode = (node: SyntaxNodeRef, visibleFrom: number, visibleTo: number): boolean | void => {
    const name = node.name;

    const headingClass = HEADING_LINE_CLASS[name];
    if (headingClass !== undefined) {
      addLineClass(node.from, headingClass);
      return;
    }

    switch (name) {
      case "HeaderMark": {
        const parent = node.node.parent;
        if (parent && parent.name.startsWith("ATXHeading") && !lineIsActive(node.from)) {
          hideWithSpace(node.from, node.to);
        }
        return;
      }

      case "Emphasis":
        mark(node.from, node.to, "bbnotes-em");
        return;
      case "StrongEmphasis":
        mark(node.from, node.to, "bbnotes-strong");
        return;
      case "Strikethrough":
        mark(node.from, node.to, "bbnotes-strike");
        return;
      case "InlineCode":
        mark(node.from, node.to, "bbnotes-inline-code");
        return;
      case "EmphasisMark":
      case "StrikethroughMark":
      case "CodeMark":
      case "CodeInfo":
        if (!lineIsActive(node.from)) hide(node.from, node.to);
        return;

      case "FencedCode":
      case "CodeBlock":
        addLineClassRange(node.from, node.to, visibleFrom, visibleTo, (n, first, last) => {
          const classes = ["bbnotes-codeblock"];
          if (n === first) classes.push("bbnotes-codeblock-first");
          if (n === last) classes.push("bbnotes-codeblock-last");
          return classes;
        });
        return;

      case "Table":
        // Legible, not gridded: mono line class keeps pipes aligned; the
        // `|---|` delimiter row is dimmed. True grid rendering is out of scope.
        addLineClassRange(node.from, node.to, visibleFrom, visibleTo, (n) => {
          const classes = ["bbnotes-table-row"];
          if (isTableDelimiterLine(doc.line(n).text)) classes.push("bbnotes-table-delimiter");
          return classes;
        });
        return;

      case "Blockquote":
        addLineClassRange(node.from, node.to, visibleFrom, visibleTo, () => ["bbnotes-quote"]);
        return;
      case "QuoteMark":
        if (!lineIsActive(node.from)) hideWithSpace(node.from, node.to);
        return;

      case "ListMark": {
        const item = node.node.parent;
        if (!item || item.name !== "ListItem") return;
        if (item.getChild("Task")) return; // handled by TaskMarker
        if (item.parent?.name === "OrderedList") return; // numbers stay visible
        if (!lineIsActive(node.from)) replaceWith(node.from, node.to, new BulletWidget());
        return;
      }

      case "Task": {
        addLineClass(node.from, "bbnotes-task");
        const marker = node.node.getChild("TaskMarker");
        if (marker && /x/i.test(doc.sliceString(marker.from + 1, marker.to - 1))) {
          addLineClass(node.from, "bbnotes-task-done");
        }
        return;
      }

      case "TaskMarker": {
        if (lineIsActive(node.from)) return;
        const checked = /x/i.test(doc.sliceString(node.from + 1, node.to - 1));
        const item = node.node.parent?.parent ?? null; // TaskMarker → Task → ListItem
        const listMark = item?.getChild("ListMark") ?? null;
        const ordered = item?.parent?.name === "OrderedList";
        // For bullet tasks swallow the list marker too ("- [ ]" → checkbox);
        // for numbered tasks the number stays and only "[ ]" is replaced.
        const from = listMark && !ordered ? listMark.from : node.from;
        replaceWith(from, node.to, new CheckboxWidget(checked));
        return;
      }

      case "Link":
      case "Autolink":
        // Wiki-link shape: skip node AND children (no link mark, no
        // LinkMark hiding) — wiki-links.ts renders the pill.
        if (name === "Link" && isWikiWrappedLink(doc, node.node)) return false;
        mark(node.from, node.to, "bbnotes-link");
        return;
      case "LinkMark":
        if (!lineIsActive(node.from)) hide(node.from, node.to);
        return;
      case "LinkTitle":
        if (!lineIsActive(node.from)) hide(node.from, node.to);
        return;
      case "URL": {
        const parent = node.node.parent?.name;
        if (parent === "Link" || parent === "Image") {
          if (!lineIsActive(node.from)) hide(node.from, node.to);
        } else if (parent !== "Autolink") {
          // Bare GFM autolink (URL directly in a paragraph).
          mark(node.from, node.to, "bbnotes-link");
        }
        return;
      }

      case "Image": {
        const line = doc.lineAt(node.from);
        if (node.to > line.to) return false; // multi-line syntax: leave raw
        if (lineIsActive(node.from)) return false;
        const urlNode = node.node.getChild("URL");
        if (!urlNode) return false;
        const src = doc.sliceString(urlNode.from, urlNode.to);
        const marks = node.node.getChildren("LinkMark");
        const altEnd = marks.length >= 2 ? marks[1].from : urlNode.from;
        const alt = doc.sliceString(node.from + 2, Math.max(node.from + 2, altEnd));
        replaceWith(node.from, node.to, new ImageWidget(src, alt, images, config.resolveAttachment));
        return false;
      }

      case "HorizontalRule":
        if (!lineIsActive(node.from)) replaceWith(node.from, node.to, new HrWidget());
        return;

      default:
        return;
    }
  };

  const tree = syntaxTree(state);
  for (const visible of view.visibleRanges) {
    tree.iterate({
      from: visible.from,
      to: visible.to,
      enter: (node) => enterNode(node, visible.from, visible.to),
    });
  }

  for (const [lineFrom, classes] of lineClasses) {
    decorations.push(Decoration.line({ class: [...classes].join(" ") }).range(lineFrom));
  }
  return Decoration.set(decorations, true);
}

/* --- Event handling -------------------------------------------------------- */

function toggleCheckbox(view: EditorView, target: HTMLElement, event: MouseEvent): boolean {
  event.preventDefault();
  if (view.state.readOnly) return true;
  const pos = view.posAtDOM(target);
  if (pos < 0 || pos > view.state.doc.length) return true;
  const line = view.state.doc.lineAt(pos);
  const column = findTaskBoxInLine(line.text);
  if (column === null) return true;
  const at = line.from + column;
  view.dispatch({
    changes: { from: at, to: at + 1, insert: line.text.charAt(column) === " " ? "x" : " " },
    userEvent: "input",
  });
  return true;
}

function cleanHref(raw: string): string {
  const href = raw.trim();
  if (href.startsWith("<") && href.endsWith(">")) return href.slice(1, -1);
  return href;
}

function linkHrefAt(view: EditorView, pos: number): string | null {
  let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, 0);
  for (; node; node = node.parent) {
    if (node.name === "Link" && isWikiWrappedLink(view.state.doc, node)) continue;
    if (node.name === "Link" || node.name === "Image" || node.name === "Autolink") {
      const url = node.getChild("URL");
      const raw = url
        ? view.state.sliceDoc(url.from, url.to)
        : view.state.sliceDoc(node.from, node.to);
      return cleanHref(raw);
    }
    if (node.name === "URL") {
      return cleanHref(view.state.sliceDoc(node.from, node.to));
    }
  }
  return null;
}

function openLinkAt(view: EditorView, event: MouseEvent): boolean {
  const open = view.state.facet(livePreviewConfig).onOpenLink;
  if (!open) return false;
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos === null) return false;
  const href = linkHrefAt(view, pos);
  if (href === null || href === "") return false;
  event.preventDefault();
  open(href);
  return true;
}

function handleMousedown(event: MouseEvent, view: EditorView): boolean {
  const target = event.target;
  if (target instanceof HTMLElement && target.classList.contains("bbnotes-task-checkbox")) {
    return toggleCheckbox(view, target, event);
  }
  if (event.metaKey || event.ctrlKey) return openLinkAt(view, event);
  return false;
}

/* --- Plugin ----------------------------------------------------------------- */

const livePreviewPlugin = ViewPlugin.fromClass(
  class LivePreviewView {
    decorations: DecorationSet;
    private readonly images: ImageCache = { resolved: new Map(), pending: new Map() };

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view, this.images);
    }

    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      ) {
        this.decorations = buildDecorations(update.view, this.images);
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

/** The live-preview extension. Pass stable callbacks (wrap refs in the host). */
export function livePreview(config: LivePreviewConfig = {}): Extension {
  return [livePreviewConfig.of(config), livePreviewPlugin];
}
