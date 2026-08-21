/**
 * Self-contained CodeMirror 6 live-markdown editor for bb-plugin-notes.
 *
 * Owns exactly one EditorView for its lifetime: prop-identical re-renders
 * never touch it, `readOnly`/`placeholder` reconfigure via compartments, and
 * a `noteId` change flushes the pending save for the OLD note (callbacks are
 * captured in refs so the flush hits the right note) before resetting doc,
 * history, and selection for the new one.
 *
 * RPC-free by design — persistence, attachment upload/resolution, and link
 * opening all flow through callbacks.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  type StateCommand,
} from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  keymap,
  placeholder as placeholderExtension,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { KeyBinding } from "@codemirror/view";
import { livePreview } from "./live-preview";
import { isBareUrl, markdownLinkSnippet, wrapSelectionWith } from "./markdown-utils";
import { bbnotesHighlightStyle, bbnotesTheme } from "./theme";
import { wikiLinks } from "./wiki-links";
import "./editor.css";

export interface MarkdownEditorProps {
  /** Note identity; remounting state (doc, history, selection) when it changes. */
  noteId: string;
  /** Body the editor initializes with for the current `noteId`. */
  initialBody: string;
  /** Debounced (500 ms) + flushed on blur/unmount/noteId change. */
  onSave: (body: string) => void;
  /** Fires on every doc change (dirty indicators, live task counts). */
  onChange?: (body: string) => void;
  /** Paste/drop of an image file → resolves to an attachment id. */
  onPasteImage?: (file: File) => Promise<string>;
  /** Resolve `bbnote://attachment/<id>` to a data: URI for inline render. */
  resolveAttachment?: (id: string) => Promise<string | null>;
  /** ⌘/Ctrl+click on a link. */
  onOpenLink?: (href: string) => void;
  /**
   * Note titles offered by the `[[` wiki-link autocomplete. Empty/undefined
   * keeps the completion inert. Read lazily via a facet — updates apply
   * without recreating (or even reconfiguring) the view.
   */
  wikiCompletions?: readonly string[];
  /** Click (pill on an inactive line) or ⌘/Ctrl+click on a `[[wiki link]]`. */
  onOpenWikiLink?: (target: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  readOnly?: boolean;
  className?: string;
}

export interface MarkdownEditorHandle {
  focus: () => void;
  /** Immediately runs any pending debounced save. */
  flush: () => void;
  /** Inserts text at the current selection (replacing it). */
  insertText: (text: string) => void;
  getBody: () => string;
}

const SAVE_DEBOUNCE_MS = 500;

/* --- Formatting commands ---------------------------------------------------- */

/**
 * Wraps/unwraps every selection range with an inline marker (`**`, `*`, `~~`).
 * Unwraps when the marker already directly surrounds (or pads) the selection.
 * Range math lives in `wrapSelectionWith` (markdown-utils) so it's testable.
 */
function toggleInlineMark(marker: string): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    const text = state.doc.toString();
    const changes = state.changeByRange((range) => {
      const result = wrapSelectionWith(marker, text, range.from, range.to);
      return {
        changes: result.changes,
        range: EditorSelection.range(result.anchor, result.head),
      };
    });
    dispatch(state.update(changes, { scrollIntoView: true, userEvent: "input" }));
    return true;
  };
}

/**
 * `[selection](url)` with the `url` placeholder selected for overtyping;
 * `[](url)` with the caret in the empty label when nothing is selected.
 */
const insertMarkdownLink: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const changes = state.changeByRange((range) => {
    const snippet = markdownLinkSnippet(state.sliceDoc(range.from, range.to));
    return {
      changes: { from: range.from, to: range.to, insert: snippet.text },
      range: EditorSelection.range(range.from + snippet.anchor, range.from + snippet.head),
    };
  });
  dispatch(state.update(changes, { scrollIntoView: true, userEvent: "input" }));
  return true;
};

const formattingKeymap: readonly KeyBinding[] = [
  { key: "Mod-b", run: toggleInlineMark("**") },
  { key: "Mod-i", run: toggleInlineMark("*") },
  { key: "Mod-Shift-x", run: toggleInlineMark("~~") },
  // Shadows defaultKeymap's deleteLine — the link snippet wins here.
  { key: "Mod-Shift-k", run: insertMarkdownLink },
];

/**
 * Pasting a bare http(s) URL over a non-empty, single-line, single-range
 * selection linkifies it: `[selection](url)`, caret after the `)`.
 */
function pasteUrlOverSelection(event: ClipboardEvent, view: EditorView): boolean {
  const pasted = event.clipboardData?.getData("text/plain") ?? "";
  if (!isBareUrl(pasted)) return false;
  const { state } = view;
  if (state.selection.ranges.length !== 1) return false;
  const range = state.selection.main;
  if (range.empty) return false;
  if (state.doc.lineAt(range.from).number !== state.doc.lineAt(range.to).number) return false;
  const insert = `[${state.sliceDoc(range.from, range.to)}](${pasted.trim()})`;
  event.preventDefault();
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: range.from + insert.length },
    scrollIntoView: true,
    userEvent: "input.paste",
  });
  return true;
}

/* --- Image paste/drop helpers ------------------------------------------------ */

function imageFiles(list: FileList | null | undefined): File[] {
  if (!list) return [];
  const files: File[] = [];
  for (let i = 0; i < list.length; i++) {
    const file = list.item(i);
    if (file && file.type.startsWith("image/")) files.push(file);
  }
  return files;
}

function altTextFor(file: File): string {
  const base = file.name.replace(/\.[^.]+$/, "");
  const cleaned = base.replace(/[[\]()\n]/g, " ").trim();
  return cleaned === "" ? "image" : cleaned;
}

function readOnlyExtensions(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

/* --- Component ---------------------------------------------------------------- */

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor(
    {
      noteId,
      initialBody,
      onSave,
      onChange,
      onPasteImage,
      resolveAttachment,
      onOpenLink,
      wikiCompletions,
      onOpenWikiLink,
      placeholder,
      autoFocus,
      readOnly,
      className,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const [compartments] = useState(() => ({
      readOnly: new Compartment(),
      placeholder: new Compartment(),
    }));

    // Latest props/callbacks, synced in an effect. Effect cleanups run BEFORE
    // the sync effect of the next commit, so the noteId-change flush below
    // still sees the previous note's onSave.
    const callbacksRef = useRef({
      onSave,
      onChange,
      onPasteImage,
      resolveAttachment,
      onOpenLink,
      onOpenWikiLink,
    });
    const propsRef = useRef({
      initialBody,
      placeholder,
      readOnly: readOnly ?? false,
      autoFocus: autoFocus ?? false,
      wikiCompletions,
    });
    const noteIdRef = useRef(noteId);
    useEffect(() => {
      callbacksRef.current = {
        onSave,
        onChange,
        onPasteImage,
        resolveAttachment,
        onOpenLink,
        onOpenWikiLink,
      };
      propsRef.current = {
        initialBody,
        placeholder,
        readOnly: readOnly ?? false,
        autoFocus: autoFocus ?? false,
        wikiCompletions,
      };
    });

    const saveRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; dirty: boolean }>({
      timer: null,
      dirty: false,
    });

    const flush = useCallback(() => {
      const save = saveRef.current;
      if (save.timer !== null) {
        clearTimeout(save.timer);
        save.timer = null;
      }
      const view = viewRef.current;
      if (!view || !save.dirty) return;
      save.dirty = false;
      callbacksRef.current.onSave(view.state.doc.toString());
    }, []);

    const insertImages = useCallback((view: EditorView, files: File[], pos: number) => {
      const upload = callbacksRef.current.onPasteImage;
      if (!upload) return;
      const forNote = noteIdRef.current;
      void Promise.allSettled(
        files.map((file) => upload(file).then((id) => ({ file, id }))),
      ).then((results) => {
        const snippets: string[] = [];
        for (const result of results) {
          if (result.status === "fulfilled") {
            const { file, id } = result.value;
            snippets.push(`![${altTextFor(file)}](bbnote://attachment/${id})`);
          }
        }
        const current = viewRef.current;
        if (snippets.length === 0 || current !== view || noteIdRef.current !== forNote) return;
        const text = snippets.join("\n");
        const at = Math.min(pos, current.state.doc.length);
        current.dispatch({
          changes: { from: at, insert: text },
          selection: { anchor: at + text.length },
          scrollIntoView: true,
          userEvent: "input",
        });
      });
    }, []);

    const buildState = useCallback(
      (body: string): EditorState => {
        const props = propsRef.current;
        return EditorState.create({
          doc: body,
          extensions: [
            history(),
            drawSelection(),
            dropCursor(),
            EditorView.lineWrapping,
            compartments.readOnly.of(readOnlyExtensions(props.readOnly)),
            compartments.placeholder.of(
              props.placeholder !== undefined && props.placeholder !== ""
                ? placeholderExtension(props.placeholder)
                : [],
            ),
            // Auto-close only `(`, `[`, and backtick — quote pairing is
            // hostile to prose apostrophes. Registered as markdown language
            // data ahead of markdown() so it beats the closeBrackets defaults
            // (fenced-code sub-languages still supply their own sets).
            markdownLanguage.data.of({ closeBrackets: { brackets: ["(", "[", "`"] } }),
            markdown({ base: markdownLanguage, codeLanguages: languages }),
            syntaxHighlighting(bbnotesHighlightStyle),
            closeBrackets(),
            // indentWithTab keeps the standard escape hatch: Escape, then Tab,
            // moves focus out of the editor (built into @codemirror/view).
            keymap.of([
              ...formattingKeymap,
              indentWithTab,
              ...closeBracketsKeymap,
              ...defaultKeymap,
              ...historyKeymap,
            ]),
            bbnotesTheme,
            // Before livePreview so wiki-pill mousedown wins over generic
            // link handling. Callbacks read refs — prop updates need no
            // reconfiguration and never recreate the view.
            wikiLinks({
              completions: () => propsRef.current.wikiCompletions ?? [],
              onOpen: (target) => {
                const open = callbacksRef.current.onOpenWikiLink;
                if (!open) return false;
                open(target);
                return true;
              },
            }),
            livePreview({
              onOpenLink: (href) => callbacksRef.current.onOpenLink?.(href),
              resolveAttachment: (id) =>
                callbacksRef.current.resolveAttachment?.(id) ?? Promise.resolve(null),
            }),
            EditorView.updateListener.of((update) => {
              if (!update.docChanged) return;
              const nextBody = update.state.doc.toString();
              callbacksRef.current.onChange?.(nextBody);
              const save = saveRef.current;
              save.dirty = true;
              if (save.timer !== null) clearTimeout(save.timer);
              save.timer = setTimeout(() => {
                save.timer = null;
                flush();
              }, SAVE_DEBOUNCE_MS);
            }),
            EditorView.domEventHandlers({
              blur: () => {
                flush();
                return false;
              },
              paste: (event, view) => {
                if (view.state.readOnly) return false;
                if (callbacksRef.current.onPasteImage) {
                  const files = imageFiles(event.clipboardData?.files);
                  if (files.length > 0) {
                    event.preventDefault();
                    insertImages(view, files, view.state.selection.main.head);
                    return true;
                  }
                }
                return pasteUrlOverSelection(event, view);
              },
              drop: (event, view) => {
                if (!callbacksRef.current.onPasteImage || view.state.readOnly) return false;
                const files = imageFiles(event.dataTransfer?.files);
                if (files.length === 0) return false;
                event.preventDefault();
                const pos =
                  view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
                  view.state.selection.main.head;
                insertImages(view, files, pos);
                return true;
              },
            }),
            EditorView.contentAttributes.of({ "aria-label": "Note editor" }),
          ],
        });
      },
      [compartments, flush, insertImages],
    );

    // One EditorView for the component's lifetime.
    useEffect(() => {
      const parent = containerRef.current;
      if (!parent) return;
      const view = new EditorView({ state: buildState(propsRef.current.initialBody), parent });
      viewRef.current = view;
      if (propsRef.current.autoFocus) view.focus();
      return () => {
        flush();
        viewRef.current = null;
        view.destroy();
      };
      // Mount-only: buildState/flush are stable.
    }, [buildState, flush]);

    // Note switch: the cleanup flushes the OLD note (old callbacks still in
    // the refs), then the effect body resets state for the new one.
    const mountedNoteRef = useRef<string | null>(null);
    useEffect(() => {
      const view = viewRef.current;
      if (view && mountedNoteRef.current !== null && mountedNoteRef.current !== noteId) {
        view.setState(buildState(propsRef.current.initialBody));
        saveRef.current.dirty = false;
        if (propsRef.current.autoFocus) view.focus();
      }
      mountedNoteRef.current = noteId;
      noteIdRef.current = noteId;
      return () => {
        flush();
      };
    }, [noteId, buildState, flush]);

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: compartments.readOnly.reconfigure(readOnlyExtensions(readOnly ?? false)),
      });
    }, [readOnly, compartments]);

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: compartments.placeholder.reconfigure(
          placeholder !== undefined && placeholder !== ""
            ? placeholderExtension(placeholder)
            : [],
        ),
      });
    }, [placeholder, compartments]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          viewRef.current?.focus();
        },
        flush: () => {
          flush();
        },
        insertText: (text: string) => {
          const view = viewRef.current;
          if (!view || view.state.readOnly) return;
          view.dispatch({
            ...view.state.replaceSelection(text),
            scrollIntoView: true,
            userEvent: "input",
          });
        },
        getBody: () => viewRef.current?.state.doc.toString() ?? "",
      }),
      [flush],
    );

    return (
      <div
        ref={containerRef}
        className={className ? `bbnotes-editor ${className}` : "bbnotes-editor"}
      />
    );
  },
);
