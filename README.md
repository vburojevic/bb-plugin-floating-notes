# Notes — floating notes for bb

Sticky notes that float over your agents. One draggable window with every
note, pop-out stickies you can pin to a thread, a quick-capture bar, and a
scratchpad per thread — plus @note mentions, a `bb notes` CLI, and agent
tools, all on one SQLite store.

Open the window from the sidebar footer or `Ctrl+'`. Capture from anywhere
with `Ctrl+Shift+'`.

## What it does

- **A floating notes window.** Draggable, resizable from any edge, position
  remembered, resting in the bottom-right corner (the floating terminal gets
  the other one). Note list with FTS5 search-as-you-type, tag chips, and
  trash; live-markdown editor on the right; `⌘K` command palette over both.
  On a phone it becomes a sheet that stays above the software keyboard.
- **Stickies.** Pop any note out into its own small card. Six theme-aware
  colors, double-click the bar to collapse it, drag it anywhere. **Pin a
  sticky to a thread** and it only shows while that thread is on screen —
  notes that live where the work is.
- **Quick capture.** `Ctrl+Shift+'`, type, `Enter`, gone. `Tab` flips the
  target between your Inbox and the current thread's scratchpad.
- **A scratchpad per thread.** The thread header's notes button floats the
  thread's scratchpad over it. Agents can read and append to it via the
  `notes_scratchpad` tool, so findings land on the pad you're looking at.
- **Inline hashtags.** Type `#tag` anywhere in a note and it becomes a
  real tag — filterable chips in every list, no tag UI to visit. Markdown
  headings and `#123` refs are left alone. Trash empties itself after 30
  days.
- **Live markdown.** Obsidian-style: syntax shows only on the active line,
  checkboxes are clickable, headings size themselves, links `⌘`-click, pasted
  images upload into the note and render inline. Checklists get a progress
  ring — and a small confetti burst when the last box is ticked.
- **Chat both ways.** "Save as note" / "Add to scratchpad" on every message
  (and on selected text); "Insert note" in the composer's `+` menu pastes a
  note into the draft; `@note` mentions resolve fresh at send time.
- **CLI and agent tools.** `bb notes list|search|show|add|append|tag|pin|
  trash|restore|purge|daily|scratchpad` — and `notes_search`, `notes_read`,
  `notes_write`, `notes_trash`, `notes_scratchpad` for agents. FTS5-backed
  search everywhere (LIKE fallback when unavailable).

## Install

```sh
bb plugin install .
bb plugin reload notes   # after editing sources
```

## Settings

**bb → Extensions → Notes**: window shortcut, capture shortcut, editor font
size, default note color, and the default capture target.

## How it fits together

```
app.tsx                          registrations: content script, sidebar button,
                                 nav + thread panels, thread-header bridge,
                                 message actions, composer plus-menu
lib/contract.ts                  the RPC contract (shared, single source of truth)
server.ts                        SQLite (WAL) + FTS5, RPC, mentions, CLI, tools
lib/store.ts                     one client cache for every surface
lib/controller.ts                open state, visible threads, picker plumbing
lib/frame.ts                     drag/resize/clamp/persist for N windows
lib/editor/                      CodeMirror 6 live-markdown editor (self-contained)
components/floating-notes.tsx    the content-script root
components/notes-window.tsx      the main window
components/sticky-note.tsx       one sticky
components/capture-bar.tsx       quick capture
docs/redesign.md                 the design doc this rewrite was built from
```

Three things worth knowing before changing it (inherited from the floating
terminal, still true here):

- **There is no bb React context in the content script.** `lib/rpc.ts` speaks
  the plugin RPC wire format directly, typed off the same contract.
- **The server owns the notes; the client caches.** Every surface renders
  from `lib/store.ts` and mutates through it; the store re-pulls after
  structural changes and on focus. Server mutations run through a mutex.
- **Theme-aware color is `light-dark()` or bb tokens only** — the plugin's
  Tailwind build has no `.dark` variant wired to bb's theme.

## Development

```sh
npm install
npm run typecheck
npm test
bb plugin build
bb plugin dev      # watch: rebuild + reload on every save
```

`components/ui/` is vendored source you own (the shadcn model). React,
`react-dom/client`, the radix portal primitives, and `sonner` come from the
bb app at runtime; everything else (CodeMirror, zod, hugeicons) bundles from
`node_modules`. Ship `dist/` so consumers never need npm.
