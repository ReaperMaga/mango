# Planner

Plan work beside your chats: collections of items (tasks, bugs, notes, whatever you track) with properties of your own,
seen as boards and tables. Every item opens as a page, at the side or full width, with its properties and a Markdown
body.

Open it with **Planner** in the sidebar, with <kbd>Ctrl/⌘</kbd> <kbd>Shift</kbd> <kbd>D</kbd>, or from the command
palette. Nothing is there until you make it: a new collection starts from a template (Tasks, Bugs, Notes) or empty, and
belongs to the project or shows everywhere. Its settings hold its name, icon, colour, a description, what its items are
called (task, note, bug) and its properties.

- Properties: text, number, select, multi-select, date, checkbox, link, created and last edited. A property's type can
  be changed later; its values come along where they can. Options have colours, an order, and one can be the default.
- Views: boards and tables, each with its own filters, sorting, grouping and columns. Everything works with the keyboard
  and by dragging.
- Boards: columns can be added, renamed, coloured, moved, folded and hidden; cards show the properties you choose and
  the start of the text.
- Tables: edit in the cells, paste from a spreadsheet, select several rows to change, duplicate or delete them.
- **Add to planner** on a chat makes an item linked to that chat; **Start a chat** on an item opens one with its text in
  the composer. Nothing is sent by itself.
- CSV in and out, Markdown out.
- Undo and redo, deletions too.

Everything stays on this computer, in Mango's data folder, and is kept when the plugin is removed unless you ask for it
to go. Nothing is sent anywhere.

## Building it

Unlike the other official plugins it is built: the source is in `src/` (Vue and TypeScript), `main.js` and `styles.css`
are made from it and committed, as plugins install straight from git.

```bash
pnpm plugins:build            # build (--watch: again on every change)
pnpm plugins:check            # typecheck
pnpm test                     # says so when the built files do not match src/
```

Where documents live is behind `PlannerSource` (`src/data/source.ts`, which also says how a remote one would plug in);
`src/store.ts` is all the interface uses.
