# Planner

Plan work beside your chats: collections of items (tasks, bugs, notes, whatever you track) with properties of your own,
seen as boards and tables. Every item opens as a page, at the side or full width, with its properties and a Markdown
body.

Open it with the **Planner** icon on the tool strip at the right, with <kbd>Ctrl/⌘</kbd> <kbd>Shift</kbd> <kbd>D</kbd>, or from the command
palette. Nothing is there until you make it: a new collection starts from a template (Tasks, Bugs, Notes) or empty, and
belongs to the project or shows everywhere. Its settings hold its name, icon, color, a description, what its items are
called (task, note, bug) and its properties.

- Properties: text, number, select, multi-select, date, checkbox, link, created and last edited. A property's type can
  be changed later; its values come along where they can. Options have colors, an order, and one can be the default.
- Views: boards and tables, each with its own filters, sorting, grouping and columns. Everything works with the keyboard
  and by dragging.
- Boards: columns can be added, renamed, colored, moved, folded and hidden; cards show the properties you choose and
  the start of the text.
- Tables: edit in the cells, paste from a spreadsheet, select several rows to change, duplicate or delete them.
- Notes are written as rich text and kept as Markdown: `#`, `-`, `1.`, `[ ]`, `>`, ```` ``` ````, `---`, `**bold**` and
  the like turn into what they mean as you type, `/` opens a menu of blocks (tables too), and pasted Markdown becomes
  formatting. Selected text gets a small bar, <kbd>Ctrl/⌘</kbd> <kbd>B</kbd>, <kbd>I</kbd>, <kbd>E</kbd> and
  <kbd>K</kbd> work, and <kbd>Ctrl/⌘</kbd> <kbd>Enter</kbd> checks a to-do. **Edit as Markdown** in the page's menu shows
  the text itself; text that rich text would change (raw HTML, footnotes) opens that way. What you do not edit stays as
  it was written, and pictures are only named, never fetched.
- **Add to planner** on a chat makes an item linked to that chat; **Start a chat** on an item opens one with its text in
  the composer. Nothing is sent by itself.
- CSV in and out, Markdown out.
- Undo and redo, deletions too.

Collections stay on this computer, in Mango's data folder, and are kept when the plugin is removed unless you ask for
them to go. Nothing is sent anywhere unless you connect a planner server.

## Sharing through a planner server

A [planner server](../../planner-server/README.md) keeps collections for every computer and person connected to one of
its spaces. You run it yourself, and the server's own command line makes the spaces and their access tokens. A token
either edits or only reads.

- Connect in **Settings > Planner server** (or **Connect to a planner server…** in the command palette) with the
  server's address and an access token.
- Each collection lives in one place. **Kept on** in a new collection's dialog chooses this computer or the server, and
  **Move to …** in a collection's menu moves one with all its items. The move can be undone. Moving one off the server
  takes it away from everyone else, so that is asked first. A cloud icon in the collection list marks the server's
  collections.
- Everyone's changes show as they are made. Two people who change different fields of an item both keep their
  change. When two people change the same field, the later change wins.
- When the server cannot be reached, its collections stay in view and changes wait to be sent. They are lost if
  Mango is closed before the server is back.
- Chat links are never sent: an item's linked chats show only on the computer that linked them. A collection that
  belongs to a project is matched on other computers by the project's git remote.

## Building it

Unlike the other official plugins it is built: the source is in `src/` (Vue and TypeScript), `main.js` and `styles.css`
are made from it and committed, as plugins install straight from git.

```bash
pnpm plugins:build            # build (--watch: again on every change)
pnpm plugins:check            # typecheck
pnpm test                     # says so when the built files do not match src/
```

The notes' editor is [TipTap](https://tiptap.dev) (MIT, like the rest that is bundled: `THIRD-PARTY.txt`); Markdown in and
out of it is `src/item/notes/markdown.ts`.

Where documents live is behind `PlannerSource` (`src/data/source.ts`): `local.ts` on this computer, `remote.ts` on a
planner server (its protocol is `planner-server/PROTOCOL.md`), and `routed.ts` puts each collection in one of them.
`src/store.ts` is all the interface uses.
