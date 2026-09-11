<div align="center">

# Floating Notes

**Sticky notes that float over your agents.**

A notes window one keystroke away, stickies that pin to the thread or project
they belong to, a scratchpad for every conversation, and a markdown editor
that behaves like one.

</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/vburojevic/bb-plugin-floating-notes/main/docs/media/dark/hero.png">
  <img alt="The Floating Notes window and three stickies over a bb thread" src="https://raw.githubusercontent.com/vburojevic/bb-plugin-floating-notes/main/docs/media/light/hero.png">
</picture>

*One window, three stickies, and the thread you are actually working on.*

## Install

From the bb plugin catalog — open **Extensions**, search for **Floating Notes**, install.

Or from a shell:

```sh
bb plugin install git:https://github.com/vburojevic/bb-plugin-floating-notes
```

Requires bb 0.42 or newer. No account, no API key, nothing leaves your machine:
notes live in a SQLite database inside bb's own data directory.

## Every note knows where it lives

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/vburojevic/bb-plugin-floating-notes/main/docs/media/dark/scopes.png">
  <img alt="The note list grouped into project, global, scratchpad and daily sections" src="https://raw.githubusercontent.com/vburojevic/bb-plugin-floating-notes/main/docs/media/light/scopes.png">
</picture>

A flat pile of notes stops being useful at about thirty. The list groups by
**scope** instead: one section per project, by name, then global notes, thread
scratchpads and daily notes. Every row carries a glyph and a tinted left edge
for its scope — and the note's sticky card wears the same colour, so a card on
screen and its row in the list read as the same object.

The chips across the top narrow the list to one project, to global notes, or to
threads. Search understands operators too: `tag:api`, `in:scratchpads`,
`is:open`, `thread:current`.

## Notes that follow the work

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/vburojevic/bb-plugin-floating-notes/main/docs/media/dark/stickies.png">
  <img alt="Three stickies over a thread: one global, one pinned to a project, one pinned to the thread" src="https://raw.githubusercontent.com/vburojevic/bb-plugin-floating-notes/main/docs/media/light/stickies.png">
</picture>

Pop any note out as a sticky. Drag it anywhere, snap it to an edge, collapse it
to its title bar, or drop it into **reference mode** — translucent and
click-through until you hover it, so a checklist can sit over an agent's output
without getting in the way.

A sticky can **pin to a thread** or to a **whole project**, and then it only
appears while you are looking at that work. Every thread also gets a
scratchpad, reachable from the thread header and the thread's side panel, that
agents can append to while they work.

## A real markdown editor

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/vburojevic/bb-plugin-floating-notes/main/docs/media/dark/editor.png">
  <img alt="The editor showing a highlighted code fence and a wiki link" src="https://raw.githubusercontent.com/vburojevic/bb-plugin-floating-notes/main/docs/media/light/editor.png">
</picture>

Formatting marks hide as you leave a line. Headings size themselves, checkboxes
are clickable and roll up into a progress ring on the row, code fences get real
syntax highlighting from your bb theme, and tables stay readable.
`[[Wiki links]]` autocomplete across your notes — follow one to a note that
does not exist and it gets created. Paste an image and it is stored with the
note. Type `#tag` anywhere and it becomes a filterable tag.

Edits keep a revision history you can restore from the footer, trash holds
deleted notes for 30 days, and images that lose their last reference are
collected automatically.

## Capture without leaving the thread

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/vburojevic/bb-plugin-floating-notes/main/docs/media/dark/capture.png">
  <img alt="The quick capture bar over a thread" src="https://raw.githubusercontent.com/vburojevic/bb-plugin-floating-notes/main/docs/media/light/capture.png">
</picture>

`Ctrl+Shift+'` opens a one-line bar over whatever you are doing. Type, press
Enter, it is saved and gone. `Tab` switches between your Inbox and the current
thread's scratchpad.

From the timeline, **Save as note** keeps a message or a selection with a link
back to the conversation it came from. The composer's `+` menu inserts a note
into the draft, and `@note` mentions resolve fresh at send time.

## On a phone it becomes a sheet

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/vburojevic/bb-plugin-floating-notes/main/docs/media/dark/mobile.png">
  <img alt="The notes sheet on a phone" src="https://raw.githubusercontent.com/vburojevic/bb-plugin-floating-notes/main/docs/media/light/mobile.png" width="320">
</picture>

Below bb's compact breakpoint the window stops pretending to be a window: it
fills the viewport minus one even inset, measured from the safe area, and
tracks `visualViewport` so the software keyboard never covers what you are
typing.

## Keyboard

| Shortcut | Does |
| --- | --- |
| `Ctrl+'` | Toggle the notes window |
| `Ctrl+Shift+'` | Quick capture |
| `⌘K` | Command palette, inside the window |
| `⌘N` | New note |
| `⌘F` | Jump to search |
| `⌘B` `⌘I` `⌘⇧X` | Bold, italic, strikethrough |
| `⌘⇧K` | Insert a link |

## Agents and the command line

Five tools let an agent keep notes current while it works: `notes_search`,
`notes_read`, `notes_write`, `notes_trash`, and `notes_scratchpad` — so
findings land on the pad you are already watching.

The same ground from a shell:

```sh
bb notes list                  # every note, newest first
bb notes search "coupon"       # full-text search
bb notes add "Ship the v2.4 announcement"
bb notes scratchpad <thread>   # read or append a thread's pad
bb notes export ./notes-backup # markdown files with front matter
bb notes import ./notes-backup
```

## Settings

**bb → Extensions → Notes**: both shortcuts, editor font size, default sticky
colour, and whether quick capture defaults to the Inbox or the current
thread's scratchpad.

## How it fits together

```
app.tsx                       registrations: content script, sidebar button,
                              nav + thread panels, message action, composer menu
lib/contract.ts               the RPC contract, shared by server and app
server.ts                     SQLite + FTS5, RPC, mentions, CLI, agent tools
lib/scope.ts                  where a note lives: grouping and filtering
lib/store.ts                  one client cache for every surface
lib/frame.ts                  drag, resize, clamp and persistence for N windows
lib/editor/                   the CodeMirror 6 live-markdown editor
components/floating-notes.tsx the content-script root
```

Four things worth knowing before changing it:

- **There is no bb React context in the content script.** `lib/rpc.ts` speaks
  the plugin RPC wire format directly, typed off the same contract.
- **The server owns the notes; the client caches.** Every surface renders from
  `lib/store.ts` and mutates through it. Server mutations run behind a mutex.
- **Theme-aware colour is `light-dark()` or bb tokens only** — this plugin's
  Tailwind build has no `.dark` variant wired to bb's theme.
- **Do not trust a Tailwind utility bb does not use itself.** Our utilities
  compile into `@layer utilities`, and layered CSS loses to bb's unlayered app
  CSS. `w-60` once computed to the container width and pushed the whole editor
  off-screen; `size-2.5` collapsed a colour swatch to a 2px speck. Anything
  load-bearing lives in `styles.css` under an unlayered `.bb-fn-*` class.
  Measure the computed value in the running app rather than trusting the class.

## Development

```sh
npm install
npm run typecheck
npm test
bb plugin build
bb plugin dev      # watch: rebuild and reload on every save
```

## License

[MIT](LICENSE)
