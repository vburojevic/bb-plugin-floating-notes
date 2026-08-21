import { HighlightStyle } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

/**
 * Editor chrome theme built entirely from bb design tokens (CSS custom
 * properties), so the editor is correct in both light and dark themes
 * without a `.dark` variant — the plugin Tailwind build lacks bb's dark
 * custom-variant, so colors must come from CSS vars (or `light-dark()`).
 *
 * Font size can be tuned by the host via `--bbnotes-editor-font-size`.
 * Decoration classes (headings, chips, checkboxes, …) live in `editor.css`.
 */
export const bbnotesTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--foreground)",
    backgroundColor: "transparent",
    fontFamily: "var(--font-sans, ui-sans-serif, system-ui, sans-serif)",
    fontSize: "var(--bbnotes-editor-font-size, 14px)",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "1.65",
  },
  ".cm-content": {
    padding: "10px 12px",
    caretColor: "var(--primary)",
  },
  ".cm-line": {
    padding: "0",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--primary)",
  },
  ".cm-selectionBackground": {
    background: "color-mix(in srgb, var(--primary) 14%, transparent)",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    background: "color-mix(in srgb, var(--primary) 22%, transparent)",
  },
  ".cm-content ::selection": {
    background: "color-mix(in srgb, var(--primary) 22%, transparent)",
  },
  ".cm-placeholder": {
    color: "var(--muted-foreground)",
  },
});

/**
 * Syntax colors for fenced-code languages, entirely from bb tokens: the
 * `--ansi-0…15` palette bb publishes for terminals (and re-tunes per theme;
 * `--ansi-1` red … `--ansi-6` cyan, `+8` for bright) plus `--muted-foreground`
 * for comments/meta. Apply with `syntaxHighlighting(bbnotesHighlightStyle)`.
 *
 * Deliberately does NOT touch markdown's own tags (heading, emphasis, link,
 * processingInstruction) — the live preview owns prose styling.
 */
export const bbnotesHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: "var(--ansi-5)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--ansi-2)" },
  { tag: t.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--ansi-3)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--ansi-11)" },
  { tag: [t.propertyName, t.attributeName, t.labelName], color: "var(--ansi-1)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--ansi-4)" },
  { tag: t.operator, color: "var(--ansi-6)" },
  { tag: t.meta, color: "var(--muted-foreground)" },
  { tag: t.invalid, color: "var(--ansi-9)" },
]);
