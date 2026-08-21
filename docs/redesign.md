# Notes — full redesign: the floating notes plugin

A ground-up rewrite of bb-plugin-notes. The nav-panel notes app becomes a
floating notes system in the spirit of bb-plugin-floating-terminal: a
draggable window over bb, pop-out stickies, a quick-capture bar, and
thread-aware scratchpads — on top of the same SQLite store, which is
preserved and migrated in place. Plugin id stays `notes`; existing notes,
@note mentions, `bb notes` CLI, and agent tools all survive (rewritten).

## Surfaces

1. **Main floating window** — content script mounts a React root into
   `document.body` (no bb React context; RPC via fetch twin). Draggable,
   resizable from any edge, geometry persisted client-side; below the compact
   breakpoint it becomes a full sheet driven by `visualViewport` (both ported
   from floating-terminal). Opened from a sidebar-footer button or `Ctrl+'`.
   Layout: note list left (search, tag chips, pinned first, trash view),
   editor right, `⌘K` palette over everything.
2. **Stickies** — any note pops out into its own small floating card: just a
   title bar + editor. Six theme-aware colors, double-click title bar to
   collapse to the bar, drag anywhere. A sticky can be **pinned to a thread**:
   it is only visible while that thread is on screen (the thread-header slot
   is the visibility bridge). Open-sticky state lives on the note row
   (`sticky_open`), geometry client-side.
3. **Quick capture** — `Ctrl+Shift+'` opens a centered one-line bar over
   everything: type, `Enter`, saved, gone. `Tab` flips the target between the
   Inbox note and the current thread's scratchpad. `Shift+Enter` for
   multi-line.
4. **Thread scratchpad** — every thread lazily gets one `kind=scratchpad`
   note. A thread-header button opens it as a sticky pinned to that thread.
   Agents can read/append via a tool, so the agent can leave findings on the
   pad you're staring at.
5. **Nav panel** (rewritten) — the full-page browser: search, tag filter,
   editor, trash. Same components as the floating window's list + editor.
6. **Thread panel** (rewritten) — scratchpad on top, then notes captured from
   this thread.
7. **Message action** (kept, improved) — save message/selection as a note or
   append to the thread scratchpad; toast confirms.
8. **Composer `+` menu** — "Insert note" opens a picker; inserts the note's
   markdown into the draft via `PluginComposerApi.insertText`.
9. **@note mentions** (kept) — FTS-backed search.
10. **CLI** (rewritten) — `bb notes list|search|show|add|append|tag|pin|trash|
    restore|purge|daily|scratchpad`.
11. **Agent tools** (rewritten) — `notes_search` (FTS), `notes_read`,
    `notes_write` (create/update/append), `notes_trash`,
    `notes_scratchpad` (read/append a thread's pad).

## Data model

SQLite via `bb.storage.database()` + `bb.storage.migrate` (append-only).
Existing `notes` table is migrated, never dropped.

- `notes` — existing columns plus:
  - `title TEXT` (cached `deriveTitle(body)`, recomputed on write)
  - `kind TEXT NOT NULL DEFAULT 'note'` — `note | scratchpad | daily | inbox`
  - `color TEXT` — palette slot name or NULL
  - `pinned_thread_id TEXT` — sticky visible only on this thread
  - `sticky_open INTEGER NOT NULL DEFAULT 0`
  - `collapsed INTEGER NOT NULL DEFAULT 0`
  - `date_key TEXT` — daily notes, `YYYY-MM-DD`, unique among `kind='daily'`
  - `task_total INTEGER NOT NULL DEFAULT 0`, `task_done INTEGER NOT NULL
    DEFAULT 0` (cached checklist stats, recomputed on write)
- Unique partial indexes: one scratchpad per thread, one daily per date, one
  inbox row.
- `attachments` — `id, note_id, mime, bytes BLOB, created_at`; purged with
  the note.
- `notes_fts` — FTS5 (`title`, `body`, `tags`), content=notes, kept in sync
  by triggers; search falls back to LIKE if FTS5 is unavailable.

## RPC contract (`lib/contract.ts`)

Single source of truth, shared by server, panels, and the fetch twin.
`listNotes` returns full notes (personal scale) plus `matchSnippet` when an
FTS query matched. Mutations: `createNote`, `updateNote` (body/tags/pinned/
color/stickyOpen/collapsed/pinnedThreadId), `appendToNote`, `scratchpad`,
`dailyNote`, `inboxNote`, trash lifecycle, `uploadAttachment`/`getAttachment`
(base64 over JSON, ≤4MB). Server publishes `bb.realtime.publish("notes",
{kind:"changed"})` on every mutation (available to future subscribers); the
client currently syncs by polling — every surface shares one store that
re-fetches on focus/visibility, every 20 s while visible, and after its own
writes, with a queued follow-up when a refresh lands during a mutation.

## Editor (`lib/editor/`)

CodeMirror 6 live markdown, Obsidian-style: formatting marks hidden outside
the active line; headings sized; bold/italic/strikethrough/inline-code
rendered; task checkboxes are clickable widgets; links `⌘`-clickable; list
bullets and blockquote bars drawn; fenced code gets a quiet block background
(no per-language highlight in v1); pasted images upload as attachments and
render inline (`bbnote://attachment/<id>` resolved through a callback).
Autosave debounced 500 ms, flushed on blur/unmount. The component is
self-contained and RPC-free: callbacks only (`onDocChange`, `onPasteImage`,
`resolveAttachment`). Theme from bb CSS variables; `light-dark()` for
anything theme-dependent (bb plugin CSS rule).

## Delights

- Checklist progress ring on note rows and sticky title bars; a tiny
  hand-rolled canvas confetti burst when a checklist reaches 100%.
- Origin chip on captured notes (thread it came from).
- Copy-as-markdown everywhere; word/task count in the editor footer.
- Empty states that teach the shortcuts.

## Settings (`bb.settings.define`)

`shortcutEnabled`, `captureShortcutEnabled`, `fontSize`, `defaultColor`,
`captureTarget` (inbox | scratchpad).

## Architecture notes

- Ported from floating-terminal: `lib/frame.ts` (+tests), `lib/viewport.ts`,
  `lib/rpc.ts` (fetch twin typed off the contract), the external-controller
  pattern (`lib/controller.ts`) so the sidebar button, shortcuts, header
  bridge, and content script cooperate without bb context.
- The thread-header slot mounts once per visible thread (`threadId` prop) and
  reports mount/unmount to the controller — that set drives pinned-sticky
  visibility and the scratchpad target. Split panes mean N mounts; the
  controller keeps a Set, "active" = most recent.
- Server mutations run through a `serialize` mutex (floating-terminal
  lesson: overlapping read-modify-writes drop writes at remote latencies).
- All runtime deps in `dependencies`, never `devDependencies` (git installs
  run `npm --omit=dev`).

## Non-goals (v1)

Manual drag-sort, per-language code highlight, collaborative editing,
encryption, multi-machine store federation.
