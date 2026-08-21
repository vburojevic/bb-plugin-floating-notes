import { EditorView } from "@codemirror/view";

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
