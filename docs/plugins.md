# Writing plugins

A plugin adds to Mango from the inside: a slash command, a tool window, a colour scheme, a check that runs before a
message is sent. It is a folder with a manifest and one JavaScript module. Mango loads the module into its window and
hands it an API object; everything the plugin adds goes through that object and is taken out again when the plugin is
turned off.

This page is the reference for writing one. To install and manage plugins, open **Settings > Plugins**.

The official plugins in [`plugins/`](https://github.com/ReaperMaga/mango/tree/main/plugins) are small, commented
examples of most of the API. Read one next to this page.

## A first plugin

Two files in a folder:

```json
// hello/mango-plugin.json
{
  "id": "hello",
  "name": "Hello",
  "version": "1.0.0",
  "description": "Says hello.",
  "minAppVersion": "0.1.36"
}
```

```js
// hello/main.js
export function activate(mango) {
  mango.commands.register({
    id: 'say-hello',
    title: 'Say hello',
    run: () => mango.ui.toast({ title: `Hello from Mango ${mango.version}` }),
  })
}
```

In **Settings > Plugins**, choose **Add local folder** and pick `hello/`. Press <kbd>Ctrl/⌘</kbd> <kbd>K</kbd> and run
**Say hello**. Edit `main.js`, press **Reload** on the plugin, and the change is live.

## The manifest

`mango-plugin.json` sits at the root of the plugin's folder.

| Field | | |
|---|---|---|
| `id` | required | Lower case letters, digits, `.`, `_` and `-`, starting with a letter or digit, up to 64 characters. Unique among installed plugins; it also names the plugin's storage, so do not change it once people use the plugin. |
| `name` | required | Shown in Settings and in front of the plugin's commands and shortcuts. |
| `version` | required | Semver (`1.2.0`). Mango compares it to offer updates. |
| `description` | | One sentence: what the plugin does for the user. |
| `author` | | A person or organisation. |
| `homepage` | | A web page about it (its repository). |
| `main` | | The entry module, relative to the folder. Default `main.js`. |
| `styles` | | A CSS file, relative to the folder, added to the app while the plugin is active. |
| `minAppVersion` | | The oldest Mango it works with. An older Mango lists the plugin as incompatible and does not run it. |
| `settings` | | Settings fields, shown on the plugin's page in Settings > Plugins (below). |

### Settings fields

Declare the settings a person can change and Mango draws the form, stores the values and hands them to the plugin
through [`mango.settings`](#settings-and-storage). Each field:

| Field | | |
|---|---|---|
| `key` | required | Unique within the plugin. |
| `type` | required | `boolean` (a switch), `string` (one line), `text` (several lines), `number`, or `select` (a list). |
| `label` | required | |
| `description` | | A line under the label. |
| `default` | | The value until the person changes it: a string, number or boolean matching `type`. |
| `options` | `select` | `[{ "value": "ask", "label": "Ask before sending" }, …]` |
| `placeholder` | | For `string`, `text` and `number`. |
| `min`, `max` | | For `number`. |

```json
"settings": [
  { "key": "when", "type": "select", "label": "Play the chime", "default": "unfocused",
    "options": [
      { "value": "unfocused", "label": "When Mango is in the background" },
      { "value": "always", "label": "Always" },
      { "value": "off", "label": "Never" }
    ] },
  { "key": "volume", "type": "number", "label": "Volume", "default": 40, "min": 0, "max": 100 }
]
```

Settings values are kept in the app's local storage, not in a secret store. Do not ask for passwords or tokens in a
settings field.

## The entry module

The entry module is one ES module. It exports `activate` and, if it needs one, `deactivate`, either as named exports
or as a default object:

```js
export function activate(mango) { /* register things */ }
export function deactivate() { /* free what the plugin made itself */ }

// or
export default {
  activate(mango) {},
}
```

`activate` may be `async`, and may return a function that runs on deactivation (the same as `deactivate`).

**The module cannot import anything.** Mango loads it from a `blob:` URL, where neither relative imports
(`./util.js`) nor package imports (`vue`) resolve. Vue, the stores and every Mango feature come through the `mango`
object. A plugin with several files or npm dependencies is bundled into one file first; see
[Bundling](#bundling-with-esbuild).

## Lifecycle and cleanup

Mango activates a plugin when it starts (or when the plugin is installed, turned on or reloaded) and deactivates it
when it is turned off, reloaded, updated or removed.

Everything registered through `mango` returns a `Disposable` (`{ dispose() }`) and is also undone on its own when the
plugin deactivates: commands, tool windows, hooks, styles, schemes, open dialogs. Keep the `Disposable` only to take
something out earlier, for example to re-register after a settings change:

```js
let registered = []
const register = () => {
  registered.forEach(d => d.dispose())
  registered = names().map(name => mango.chat.slashCommands.register({ name, description: '…', run: () => '…' }))
}
register()
mango.settings.onChange(key => { if (key === 'templates') register() })
```

What the plugin makes itself, Mango does not know about: timers, intervals, `AudioContext`s, global event listeners,
`fetch` loops. Undo them in `mango.onDispose(fn)` (or `deactivate`):

```js
const timer = setInterval(tick, 1000)
mango.onDispose(() => clearInterval(timer))
```

Closing a window does not deactivate its plugins. What is not saved yet then goes into `mango.onBeforeClose(fn)` (since
0.4.2). Mango waits for it before the window closes or hides, Mango quits, or restarts for an update: about two seconds,
for all plugins together.

```js
mango.onBeforeClose(() => saveNow())
```

It runs in each window that closes, only for what that window holds. The window may stay after all (another file could
not be saved, and the person chose to keep it), so save, but do not shut down. A crash does not call it: save as you go.

A plugin that throws in `activate` is shown as failed in Settings > Plugins, with the error, and whatever it had
registered so far is undone. A hook or handler that throws is skipped for that call, logged in the plugin's log, and
the rest of Mango carries on. Still, catch what you can: a failed hook means the plugin silently did nothing.

### Safe mode

If Mango did not finish starting the last time (a plugin may have hung or broken the window), it starts with every
plugin paused and says so in Settings > Plugins, with **Resume plugins**. Turn the suspect plugin off first, then
resume. Opening Mango with `?safe-mode` in the address (in `pnpm dev`) does the same on purpose.

## The API

`activate(mango)` receives a `MangoPluginApi`. Its full TypeScript definition, with a comment on every member, is
[`app/plugin-host/types.ts`](https://github.com/ReaperMaga/mango/blob/main/app/plugin-host/types.ts); for a plugin of
your own, copy [`plugins/mango-plugin.d.ts`](https://github.com/ReaperMaga/mango/blob/main/plugins/mango-plugin.d.ts),
a standalone version without Mango's internal imports.

A few conventions run through all of it:

- **Ids** of things a plugin registers are unique within the plugin: letters, digits, `.`, `_`, `-` and `:`. Mango
  prefixes them with the plugin id (`<pluginId>.<id>`), so two plugins never clash.
- **Icons** (`PluginIcon`) are a lucide icon name in kebab-case (`'timer'`, `'notebook-pen'`), raw `<svg …>` markup, or a
  Vue component. Mango ships a set of lucide icons for plugins, not the whole library: a name it does not know is
  drawn as a puzzle piece. The names in the set are listed in
  [`PluginGlyph.vue`](https://github.com/ReaperMaga/mango/blob/main/app/components/plugins/PluginGlyph.vue); for any other
  icon, pass its SVG markup. Icons follow `currentColor`.
- **Views** (`PluginView`) are UI a plugin puts somewhere: either `{ component, props? }`, a Vue component rendered by
  the app's own Vue, or `{ mount(el, ctx) }`, a function that fills an element and may return a cleanup. The context
  `ctx` depends on the place (a tool window gets its project, a code block its code). A component receives it as the
  `ctx` prop when it declares one (`props: ['ctx']`), or through `inject('mango:ctx')`.
- **Reactive values** (`Reactive<T>`) are a plain value or a getter. A getter is re-read when what it reads changes:
  Vue refs (`mango.vue.ref`) or Mango's stores.

### Plugin and app

```js
mango.plugin.id          // 'focus-timer'
mango.plugin.manifest    // the parsed mango-plugin.json
mango.plugin.dir         // the folder it runs from
mango.version            // Mango's version, '0.1.36'
mango.platform           // 'windows' | 'macos' | 'linux' | 'browser' (the pnpm dev preview)
mango.vue                // the app's Vue: h, ref, computed, watch, defineComponent…
```

### Commands and shortcuts

Commands appear in the command palette (<kbd>Ctrl/⌘</kbd> <kbd>K</kbd>).

```js
mango.commands.register({
  id: 'reset',
  title: 'Focus timer: reset',
  detail: 'Back to a fresh focus block',   // secondary text
  icon: 'timer',
  keywords: 'pomodoro',                     // extra words the palette matches
  when: () => mango.chat.active() !== null, // hidden while false
  run: () => reset(),
})

await mango.commands.execute('focus-timer.reset')   // a plugin command by full id, or a built-in palette action
mango.commands.list()                               // [{ id, title, pluginId }]
```

Shortcuts are listed under the plugin's name in Settings > Shortcuts, where people can rebind them.

```js
mango.shortcuts.register({
  id: 'toggle',
  label: 'Start or pause the focus timer',
  key: 'Mod+Shift+T',   // Mod is Cmd on macOS, Ctrl elsewhere; a key must contain Mod
  scope: 'workspace',   // 'always', 'app' (not in the terminal) or 'workspace' (not under Settings, the default)
  run: () => toggle(),
})
```

### Chats

Reading and driving chats:

```js
mango.chat.active()                    // the chat in the active pane, or null
mango.chat.get(threadId)               // a chat by id, or null
mango.chat.list(projectPath?)          // chats of a project (all open projects when omitted), archived ones too
mango.chat.create({ projectPath, agent: 'claude', title })  // a new chat, shown
await mango.chat.send(threadId, text)  // send as the user would (onBeforeSend hooks run)
mango.chat.stop(threadId)
mango.chat.show(threadId)
mango.chat.rename(threadId, 'New title')
mango.chat.draft(threadId)             // since 0.4.2: what is in its composer, not sent yet
mango.chat.setDraft(threadId, text)    // since 0.4.2: replaces it; nothing is sent
```

A chat is a `Thread` (see [`app/types/chat.ts`](https://github.com/ReaperMaga/mango/blob/main/app/types/chat.ts)):
`id`, `projectPath`, `title`, `agent` (`'claude'` or `'codex'`), `model`, `status`, `messages`, `worktree`,
`parentId` (set on a sub-agent's chat) and more. A `Message` has a `role` (`'user'` or `'agent'`) and `parts`: `text`,
`thinking`, `tool` (with `tool`, `target`, `status`, `output`), `approval`, `question` and `notice`. Treat what you get
as read-only; change chats through the methods above.

Hooks:

```js
// Before a message goes out: change it, cancel it (false), or leave it (return nothing).
mango.chat.onBeforeSend(async ({ threadId, text, attachments, agent, projectPath }) => {
  if (!text.includes('TODO')) return
  return { text: text.replaceAll('TODO', 'to do') }
})

mango.chat.onAgentEvent((threadId, event) => { /* every event a run produces: text deltas, tool calls, turn-end… */ })
mango.chat.onTurnEnd((threadId, ok) => { /* a turn finished; ok is false when it failed */ })
mango.chat.onThreadCreated(thread => {})
mango.chat.onStatusChange((threadId, status) => {})
```

`onBeforeSend` hooks of all plugins run in the order they were registered, each seeing the previous one's result.
When a hook cancels, tell the person why (a toast); Mango does not.

Slash commands appear in the composer's `/` menu. `run` happens instead of sending; return a string to send that
text to the agent instead, which is all a prompt template needs:

```js
mango.chat.slashCommands.register({
  name: 'explain',
  description: 'Explain code step by step',
  argumentHint: '[what]',
  agents: ['claude', 'codex'],   // all when omitted
  run: ({ threadId, args, projectPath }) => `Explain ${args || 'the code we just looked at'} step by step.`,
})
```

A name already taken by Mango (`/clear`, `/create-pr`, `/create-release`) or by another plugin is refused with an error.

Message actions are buttons on a message:

```js
mango.chat.messageActions.register({
  id: 'copy',
  label: 'Copy as Markdown',
  icon: 'clipboard-copy',
  when: ({ role }) => role === 'assistant',
  run: async ({ threadId, messageId, role, text }) => navigator.clipboard.writeText(text),
})
```

Code block renderers draw fenced blocks of a language in agent replies (`` ```csv ``, `` ```mermaid ``). The code is
agent output: untrusted. Build the DOM with `textContent` and `createElement`, never by putting the code into
`innerHTML`.

```js
mango.chat.codeBlocks.register({
  languages: ['csv', 'tsv'],
  view: {
    mount(el, { code, language, threadId }) {
      const table = document.createElement('table')
      for (const line of code.trim().split('\n')) {
        const tr = table.insertRow()
        for (const cell of line.split(language === 'tsv' ? '\t' : ',')) tr.insertCell().textContent = cell
      }
      el.append(table)
      return () => table.remove()
    },
  },
})
```

### UI

**Tool windows** sit on the right beside Files, Changes and Pull requests, with a button in the tool strip.

```js
mango.ui.toolWindows.register({
  id: 'scratchpad',
  title: 'Scratchpad',
  icon: 'notebook-pen',
  badge: () => unread.value || null,   // a small number on the button
  when: () => mango.workspace.activeProject() !== null,
  view: { component: Scratchpad },     // ctx: { projectPath, close() }
})
mango.ui.toolWindows.open('scratchpad')   // this plugin's tool window, by its own id
mango.ui.toolWindows.close()
```

**Panel tabs** sit in the bottom panel among the terminals and Mango's own Git log (like tool windows docked at the bottom of an IDE), and
each gets a button at the foot of the tool strip, above the terminal's. There is one of each, and the user handles it
like a terminal's tab: drags it along the strip, into the main area (a tab of its own, a split) and back, or closes it.
Mango remembers where it is. A closed tab comes back into the panel from its button, `panelTabs.open` or a command of
yours that calls it; `when` hides it from the panel and the tool strip. The view mounts the first time the tab shows and
stays mounted while it is moved or another tab is in front; `ctx.visible` says whether it is in view, so pause polling
while it is false.

```js
mango.ui.panelTabs.register({
  id: 'output',
  title: 'Build output',
  icon: 'scroll-text',
  badge: () => errors.value || null,   // a small number on the tab and its button
  when: () => mango.workspace.activeProject() !== null,
  view: { component: Output },         // ctx: { projectPath, visible, close() } (hides the panel, or closes its main-area tab)
})
mango.ui.panelTabs.open('output')      // brings it into view wherever it is; a closed one opens in the panel (no shell is started)
```

**Tabs** in the main area, beside chats, diffs and files:

```js
mango.ui.tabs.register({
  id: 'report',
  icon: 'file-text',
  view: { mount(el, ctx) { el.textContent = JSON.stringify(ctx.state) } },  // ctx: { state, projectPath, setTitle, setState, close }
  header: 'none',   // since 0.4.2: no header row (icon, title, plugin name) above the view, which draws its own
  restore: true,    // since 0.4.2: open tabs come back after a restart
})
mango.ui.tabs.open('report', { title: 'Report', key: 'weekly', state: { week: 47 } })  // same key: focus the open tab
mango.ui.tabs.active()                  // since 0.4.2: { viewId, key, state } of your tab in the active pane, or null
mango.ui.tabs.close('report', 'weekly') // since 0.4.2: in the active project
```

A tab belongs to the project that was active when it opened; `tabs.open` throws while none is. With `restore`, its title
and `state` are saved with the window's layout (the main window's; other windows start afresh), so `state` must be JSON
and small (up to 256 KB): what to show, not the data itself. `ctx.setState` replaces it. Opening an open tab without a
`state` leaves the one it has. Give such a tab a fixed `key`. A restored tab waits, empty, until your plugin has
registered its view, so register it in `activate` before anything slow. Turning the plugin off closes its tabs.

**Navigation** (`ui.navItems`, since 0.4.2) is for a plugin whose main thing is a tab: a row at the top of the sidebar
under New chat, and an icon in the titlebar while the sidebar is hidden. Not shown in a window of a single chat.

```js
mango.shortcuts.register({ id: 'open', label: 'Open report', key: 'Mod+Shift+R', run: openReport })
mango.ui.navItems.register({
  id: 'report',
  title: 'Report',
  icon: 'file-text',
  shortcut: 'open',                                          // shows the key the user has for it
  badge: () => unread.value || null,
  active: () => mango.ui.tabs.active()?.viewId === 'report', // marked while its tab is in view
  run: openReport,
})
```

**Mango's controls** (`ui.components`, since 0.4.2) are Vue components for a plugin's own views, so they look and behave
like the app. In a `mount` view, render them with `mango.vue.render` and a vnode whose `appContext` is
`mango.app._context`.

| Component | Props | Slots, events and methods |
|---|---|---|
| `Button` | `variant` (`primary`, `secondary`, `ghost`, `danger`; default `secondary`), `size` (`sm`, `md`, `lg`; default `md`), `loading`, `block`, `type` (`button`, `submit`); attributes such as `disabled` and `onClick` go to the button | default: the label, an icon before it |
| `IconButton` | `label` (its tooltip and accessible name), `active`, `size` (`sm`, `md`; default `md`), `shortcut` (added to the tooltip); attributes go to the button | default: the icon |
| `Menu` | `items` (`PluginMenuRow[]`), `placement` (`bottom-start`, `bottom-end`, `top-start`, `top-end`; default `bottom-start`), `width` (default 240), `maxWidth` (grow to fit up to this), `maxHeight`, `label` | default `{ open, toggle }`: the trigger. Event `closed`. Methods `show()`, `showAt(x, y)`, `close()`, `toggle()` |
| `Field` | `label`, `hint`, `error`, `for` (the control's id) | default: the control (`<input class="input">`) |
| `Icon` | `icon` (any `PluginIcon`) | |
| `ThreadDot` | `threadId`, `size` (default 12) | nothing renders for a chat that is gone |
| `ProjectBadge` | `path`, `name` (default: the project's), `size` (`sm`, `md`; default `md`) | in the colour the user gave the project |
| `Markdown` | `text`, `base` (the folder relative picture paths are in) | raw HTML is escaped; pictures come only from files |

```js
const { h } = mango.vue
const { Button, Icon } = mango.ui.components
h(Button, { variant: 'primary', onClick: add }, () => [h(Icon, { icon: 'plus' }), 'Add'])
```

**Menus of your own** (since 0.4.2), at a point (a right click) or hanging from an element. One is open at a time;
resolves when it closes:

```js
el.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  void mango.ui.contextMenu({ x: e.clientX, y: e.clientY }, [
    { label: 'Rename', icon: 'pencil', onSelect: rename },
    { label: 'Delete', icon: 'trash-2', danger: true, divider: true, onSelect: remove },
  ])
})
```

A browser tab's page is a native view drawn over all HTML. Mango's menus and dialogs make it step aside; for a popover
or a drag of your own, hold it: `const hold = mango.ui.holdOverlay()`, then `hold.dispose()` when the layer is gone.

**Status items** are small text-and-icon buttons in the titlebar or the sidebar foot. Location `project` (since
0.1.41) is beside the project and branch, for what kind of project it is; in a narrow window it keeps only the icon,
so give it one. Text, icon and tooltip may be getters, so they update by themselves:

```js
const { ref } = mango.vue
const left = ref(25 * 60)
mango.ui.statusItems.register({
  id: 'timer',
  location: 'titlebar',   // or 'project', 'sidebar'
  icon: 'timer',
  text: () => `${Math.floor(left.value / 60)}:${String(left.value % 60).padStart(2, '0')}`,
  tooltip: () => 'Click to pause',
  onClick: () => toggle(),
})
```

**Settings pages** are listed under Plugins in the Settings rail, for settings richer than the manifest's fields:

```js
mango.ui.settingsPages.register({ id: 'accounts', title: 'My plugin accounts', view: { component: AccountsPage } })
mango.ui.openSettings('accounts')   // this plugin's page, '<pluginId>.<pageId>', or a built-in section
```

**Menu items** in the context menus of a chat (`thread`), a file in the Files view (`file`) or a project (`project`):

```js
mango.ui.menus.register('thread', {
  id: 'copy-chat',
  label: 'Copy chat as Markdown',
  icon: 'file-text',
  run: ({ threadId }) => copyThread(threadId),
})
mango.ui.menus.register('file', {
  id: 'count-lines',
  label: 'Count lines',
  when: ({ isDir }) => !isDir,
  run: async ({ path }) => mango.ui.toast({ title: `${(await mango.files.read(path)).split('\n').length} lines` }),
})
```

**Project files** (`ui.files`, since 0.1.41) shape the Files view, file tabs and the editor. The callbacks run for every
row, so keep them quick and synchronous; read what they need beforehand into a `ref` and they follow it. One that
throws is logged once and counts as no answer.

```js
// A checkbox under View options > Show, off at first: what it hides shows when the user ticks it.
mango.ui.files.filters.register({
  id: 'meta',
  label: 'Unity .meta files',
  when: ({ projectPath }) => isUnity(projectPath),   // which projects list it
  hide: ({ path, name, isDir, hasSibling }) => name.endsWith('.meta') && hasSibling(name.slice(0, -5)),
})

// A file that goes with another (`Player.cs` and `Player.cs.meta`).
mango.ui.files.companions.register({
  id: 'meta',
  suffix: '.meta',
  when: ({ projectPath, path }) => isUnity(projectPath) && path.startsWith('Assets/'),
})

// The first provider with an answer wins, then Mango's own icons.
mango.ui.files.icons.register({
  id: 'types',
  icon: ({ name, isDir, open }) => name.endsWith('.prefab') ? { icon: PREFAB_SVG, tint: 'blue', note: 'Prefab' } : null,
})

// For extensions Monaco does not know.
mango.ui.files.languages.register({ id: 'yaml', extensions: ['.prefab', '.unity'], language: 'yaml' })

mango.ui.files.filters.isShown('meta')
mango.ui.files.filters.setShown('meta', true)
await mango.ui.files.reveal('/path/in/project/Assets/Main.unity')   // opens Files at it
```

- `path` is relative to `projectPath` and has forward slashes on every system.
- `hasSibling(name, ignoreCase?)` says whether the same folder has a name. In a folder too big to read whole a filter gets `false` and
  an icon provider gets no `hasSibling`: never report something as missing then.
- A companion is renamed and deleted with its entry (a rename moves all or none) and is not copied by Duplicate. While
  hidden, its git change shows on the entry. If you hide companions, hide only those whose `when` is true, or a
  hidden file is left behind.
- A companion's `when` returns `null` while it does not know yet (still reading the project): rename and delete are
  then refused instead of leaving the companion behind. A throw refuses them too.
- Tints are Mango's file-type colours (`blue`, `yellow`, `orange`, `green`, `purple`, `red`, `neutral`). Return the
  same icon value each time; SVG markup draws at once, a lucide name is looked up first.

**Messages and dialogs:**

```js
mango.ui.toast({ title: 'Copied', body: 'The chat is on the clipboard.', kind: 'success', timeout: 3000,
                 action: { label: 'Undo', run: undo } })   // kind: info, success, warning, error; timeout 0 stays
mango.ui.notify('Break is over', 'Next focus block: 25 minutes.')   // a system notification (Settings > Notifications)

const ok = await mango.ui.confirm({ title: 'Send anyway?', body: '…', confirmLabel: 'Send anyway', danger: true })
const name = await mango.ui.prompt({ title: 'Branch name', placeholder: 'feat/…', value: '' })   // null when cancelled
await mango.ui.dialog({ title: 'Preview', width: 560, view: { component: Preview } })        // ctx: { close() }
```

### Theme

```js
mango.theme.addStyles('.my-plugin-row { color: var(--fg-muted); }')   // CSS added while the plugin is active
mango.theme.setTokens({ '--accent': '#f60' })                          // override design tokens, in either theme
mango.theme.current()                                                  // 'dark' | 'light'
mango.theme.onChange(theme => {})
```

The manifest's `styles` file is added for you. Style with Mango's design tokens
([`app/assets/css/tokens.css`](https://github.com/ReaperMaga/mango/blob/main/app/assets/css/tokens.css)) so the
plugin follows the theme, the colour scheme and the text size: `--bg-panel`, `--bg-raised`, `--line`, `--fg`,
`--fg-muted`, `--fg-subtle`, `--accent` (a fill, with `--accent-fg` on it), `--accent-ink` (accent-coloured text),
`--text-sm`, `--space-2`, `--radius-sm`, `--dur-fast` and the rest. Prefix your class names with the plugin id;
plugin CSS is global.

**Colour schemes** appear in Settings > Appearance beside Mango's own. A scheme sets the same custom properties a
built-in one does: the hue and tint of the grounds (`--hue-ground`, `--hue-ink`, `--ground-tint`, from which every
background, line and text colour is derived) and its accent family (`--accent`, `--accent-strong`, `--accent-fg`,
`--accent-soft`, `--accent-ink`, `--accent-line`, `--selection`, `--focus-ring`). `dark` applies in both themes and
`light` overrides it in light theme, so set every key in both. Leave the status colours (`--ripe-*`) alone.

```js
mango.theme.registerScheme({
  id: 'nord',
  label: 'Nord',
  swatch: '#88c0d0',
  dark:  { '--hue-ground': '255', '--hue-ink': '230', '--ground-tint': '1.8', '--accent': 'oklch(0.78 0.075 215)', /* … */ },
  light: { '--hue-ground': '260', '--hue-ink': '250', '--ground-tint': '1.6', '--accent': 'oklch(0.70 0.09 240)', /* … */ },
})
```

Keep the built-ins' contrast: `--accent-fg` on `--accent` at least 4.5:1, `--accent-ink` on every ground at least 5:1.
When the plugin is turned off, a window using its scheme goes back to Mango's own.

### Workspace, files and git

```js
mango.workspace.activeProject()   // the active project's folder, or null
mango.workspace.openProjects()    // every open project's folder
mango.workspace.workdir()         // the folder in view: the active chat's worktree, or the project
mango.workspace.onProjectChange(projectPath => {})
mango.workspace.openFile('/path/in/project/src/main.ts')
mango.workspace.openBrowser('http://localhost:3000')   // http and https only
mango.workspace.openTerminal({ cwd, command: 'pnpm test' })

await mango.files.read(path)                 // text; paths are absolute and inside an open project
await mango.files.write(path, content)       // creates the file when it is not there
await mango.files.list(dir)                  // [{ name, path, isDir }]
await mango.files.list(dir, { children: true })  // since 0.1.41: some subfolders come with their `children`, in one call

mango.files.onChange(projectPath => {})      // since 0.1.41: files may have changed (Files view, agent turn, branch or commit)

await mango.git.status(path)                 // the working copy's status, or null outside version control
await mango.git.refresh(path)                // after changing files, so the Changes view catches up
```

Paths may use `\` on Windows. Remote projects (`env://…`) work with `files` and `git` too.

### Agents

```js
// An MCP server every agent run gets while the plugin is active (the shape of Settings > MCP servers).
mango.agents.registerMcpServer({
  name: 'docs',
  transport: 'http',          // or 'stdio' with command, args and env
  url: 'https://example.com/mcp',
  agents: ['claude'],         // all when omitted
})

// Text appended to every run's system prompt (Claude Code --append-system-prompt, Codex instructions).
mango.agents.appendSystemPrompt(() => `Today is ${new Date().toDateString()}.`)

// Since 0.1.41 the function gets the run: '' adds nothing to it.
mango.agents.appendSystemPrompt(({ threadId, agent, projectPath, workdir }) => isUnity(workdir) ? UNITY_RULES : '')
```

Keep the text to one line: a CLI installed as a Windows batch file (`claude.cmd`) refuses arguments with line breaks,
and the run does not start.

### Settings and storage

```js
mango.settings.get('volume')          // the person's value, or the manifest default
mango.settings.set('volume', 60)
mango.settings.all()                  // every field's value
mango.settings.onChange((key, value) => {})

mango.storage.set('state', { phase: 'work', endAt: 1700000000000 })   // JSON values, kept across restarts
mango.storage.get('state')
mango.storage.delete('state')
mango.storage.keys()
```

Storage is the plugin's own (namespaced by its id), lives in the app's local storage, and is meant for small
values: state and notes, not files. It is not a secret store. For what a person makes in the plugin, use
[saved documents](#saved-documents).

### Saved documents

Since 0.4.2 (`"minAppVersion": "0.4.2"`). `mango.data` keeps documents in a database in Mango's data folder:

```js
const [doc] = await mango.data.write([
  { op: 'put', collection: 'tasks', id: 'task-1', data: { title: 'Write the docs' } },
])
await mango.data.list('tasks')           // every document in the collection
await mango.data.get('tasks', 'task-1')  // one, or null
await mango.data.write([{ op: 'delete', collection: 'tasks', id: 'task-1' }])
await mango.data.changes(0)              // { seq, docs }: everything written after a seq, deleted documents too
mango.data.onChange(({ docs, local }) => {})   // after every write, in this window (local) or another
```

Use `storage` for small state you can lose: what was open, a phase, a filter. Use `data` for what a person makes and
would miss. It holds more, writes are safe with several windows open, and documents **outlive the plugin**: Remove keeps
them for when it is installed again, unless the person ticks **Also delete what you made in it**. It is no secret store
either.

- A collection is just a name (letters, digits, `_`, `-`, up to 64). An id is yours to choose, up to 128 characters.
  `data` is JSON (what `JSON.stringify` keeps of it), at most 1 MB per document.
- One `write` takes up to 20 000 operations (and 64 MB of JSON) and lands whole or not at all. It returns the document after each operation,
  in their order.
- `rev` is 1 at first and one more on every write of that document. `seq` grows with every write of the plugin and is
  never used twice, so `changes(lastSeq)` is what you missed. A deleted document stays in it as a tombstone
  (`deleted: true`, `data: null`).
- Register `onChange` before the first `list`, and nothing falls in between.

**Conflicts.** Give an operation the `rev` you read as `expectedRev`, and it is refused when someone (another window)
wrote the document since. `expectedRev: 0` means it must not exist. The write then rejects, nothing of it is saved,
and the error's `conflicts` holds the documents as they are now (`rev: 0` for one that was never there):

```js
const put = (data, expectedRev) =>
  mango.data.write([{ op: 'put', collection: 'tasks', id: doc.id, data, expectedRev }])
try {
  await put(mine, doc.rev)
} catch (e) {
  if (!e.conflicts) throw e
  const [theirs] = e.conflicts
  await put(merge(mine, theirs.data), theirs.rev)
}
```

Without `expectedRev` the last write wins.

### Events between plugins

```js
mango.events.on('focus-timer:done', payload => {})
mango.events.emit('focus-timer:done', { phase: 'work' })
```

Names are free; prefix them with your plugin id.

### Assets and logging

```js
const css = await mango.assets.text('extra.css')    // a file of the plugin as text
img.src = await mango.assets.url('logo.png')         // as a blob: URL (revoked when the plugin goes away)

mango.log.info('Registered', n, 'templates')         // shown in the plugin's log in Settings > Plugins
mango.log.warn('…')
mango.log.error('…', error)
```

The log is shown in Settings and mirrored to the developer console. Never log secrets or the text of people's
messages.

### Escape hatches

```js
await mango.backend.call('git_status', { path })   // any backend command in app/types/ipc.ts
await mango.backend.on('pty://data', payload => {})
mango.stores.threads                                // Mango's Pinia stores: workspace, threads, git, files, browser
mango.stores.byId('models')
mango.app, mango.pinia                              // the Vue app and Pinia instance
```

These reach everything the app itself can, and come with **no stability promise**: commands, events and store shapes
change between versions without notice. Prefer the API above, and say in your README which escape hatches you use.

## Using Vue

`mango.vue` is the app's own Vue. Use it; never bundle a second copy (two Vues in one page do not share reactivity).

There is no single-file component compiler at runtime, so a plugin without a build step writes components as render
functions with `defineComponent` and `h`:

```js
export function activate(mango) {
  const { defineComponent, h, ref } = mango.vue

  const Counter = defineComponent({
    props: ['ctx'],   // a tool window's { projectPath, close }
    setup(props) {
      const count = ref(0)
      return () => h('div', { class: 'my-counter' }, [
        h('p', `Project: ${props.ctx?.projectPath ?? 'none'}`),
        h('button', { type: 'button', onClick: () => count.value++ }, `Clicked ${count.value} times`),
      ])
    },
  })

  mango.ui.toolWindows.register({ id: 'counter', title: 'Counter', icon: 'sparkles', view: { component: Counter } })
}
```

Components can read Mango's stores (`mango.stores.threads.threads`) and stay reactive to them.

### Bundling with esbuild

For `.vue` files, TypeScript or npm packages, bundle the plugin into one ES module. Vue must be left out of the
bundle and read from `mango.vue` at runtime: map every `import … from 'vue'` to a stub that hands out the app's Vue,
which `activate` puts on `globalThis` first.

```js
// build.mjs
import { build } from 'esbuild'
import vue from 'esbuild-plugin-vue3'

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'esm',
  outfile: 'main.js',
  target: 'es2022',
  plugins: [
    vue(),
    {
      // `import { ref } from 'vue'` reads from the app's Vue, through mango.vue.
      name: 'mango-vue',
      setup(b) {
        b.onResolve({ filter: /^vue$/ }, () => ({ path: 'vue', namespace: 'mango-vue' }))
        b.onLoad({ filter: /.*/, namespace: 'mango-vue' }, () => ({
          contents: 'module.exports = globalThis.__mangoVue',
          loader: 'js',
        }))
      },
    },
  ],
})
```

```ts
// src/main.ts
import type { MangoPluginApi } from '../mango-plugin'

export async function activate(mango: MangoPluginApi) {
  // Set before the components (and their `import … from 'vue'`) are first evaluated.
  ;(globalThis as any).__mangoVue = mango.vue
  const { default: Panel } = await import('./Panel.vue')
  mango.ui.toolWindows.register({ id: 'panel', title: 'Panel', icon: 'sparkles', view: { component: Panel } })
}
```

Two things make this work. The `vue` import becomes a CommonJS stub that esbuild evaluates lazily, on first use,
so it reads `globalThis.__mangoVue` after `activate` has set it; that is also why the entry file itself does not
import from `vue` (use `mango.vue` there). And the dynamic `import('./Panel.vue')` is bundled
into the same file (esbuild inlines it with `bundle: true` and no `splitting`), so the result still has no imports.
Check the output: `main.js` must not contain an `import` statement. Vite in library mode works the same way, with
`build.lib.formats: ['es']`, `rollupOptions.external: ['vue']` swapped for the same shim, and `inlineDynamicImports: true`.

### TypeScript

[`plugins/mango-plugin.d.ts`](https://github.com/ReaperMaga/mango/blob/main/plugins/mango-plugin.d.ts) declares the API
for authors, without Mango's internal imports: copy it next to your sources and type `activate(mango: MangoPluginApi)`.
The source of truth is [`app/plugin-host/types.ts`](https://github.com/ReaperMaga/mango/blob/main/app/plugin-host/types.ts);
the standalone file types the stores, backend and `Thread` loosely.

## Installing

In **Settings > Plugins**:

- **Browse plugins** lists the catalog. Choose a plugin and **Install**.
- **Add from a link** takes a git repository URL (`https://…`, `ssh://…` or `git@host:owner/repo`), optionally
  a branch, tag or commit, and a folder inside the repository. One repository can hold several plugins; without a
  folder, Mango lists every plugin it finds in it and you pick. Mango clones with your own git and credentials, so
  private repositories work when your git can reach them.
- **Add local folder** uses a folder on this computer in place, for developing a plugin.

A plugin installed from a repository is copied into Mango's data folder, pinned to the commit it was installed at.
**Check for updates** compares it with the repository; **Update** fetches the new commit and reloads the plugin.
Turning a plugin off keeps it installed; **Remove** deletes the copy and the plugin's storage,
and its [saved documents](#saved-documents) only when asked to.

## Developing a plugin

1. Make a folder with `mango-plugin.json` and `main.js`, and add it with **Add local folder**.
2. Edit, then press **Reload** on the plugin (it deactivates, reads its files again and activates).
3. Watch the plugin's log in Settings > Plugins, or the developer console (in `pnpm app`, right click > Inspect).
   What a plugin registered right now is listed on its page: commands, hooks, tool windows and so on.

`pnpm dev` (the browser preview) serves the official plugins straight from the repository's `plugins/` folder, which
is the quickest way to work on one of them: change a file and Reload.

## Security

**A plugin is trusted code with full access.** It runs inside Mango's window with the same rights as Mango itself:
it can read and write files in your projects, run commands through the backend, send messages to agents, and read
every chat. There is no sandbox and no permission prompt. Install plugins only from people you trust, and read the code
of one you are unsure about: a plugin is one readable file.

Official plugins are reviewed in Mango's repository. Community plugins in the catalog are reviewed when they are added
and at each catalog change, but the plugin's own repository can change after that: a catalog entry pins nothing
unless it names a `ref`.

What a plugin must still not do, even though it could:

- **Never put untrusted text into HTML.** Agent output, chat messages, file contents, pull request text and web pages
  can carry markup. Set it with `textContent` (or Vue's `{{ }}` / `h(tag, text)`), never `innerHTML` or `v-html`. A
  plugin that renders agent output as HTML gives any prompt injection the full rights of Mango.
- **Keep secrets out of logs, settings and storage.** The plugin log is shown in Settings and the console; settings and
  storage are plain local storage. A token a plugin needs belongs in the user's environment or in the CLI's own
  sign-in, not in Mango.
- **Do not send people's chats or files anywhere** they did not ask for. Say plainly in the README when a plugin talks
  to the network, and to whom.
- **Do not fight Mango's own UI**: no global CSS on Mango's own class names, no patching stores to change behaviour
  the API covers. It breaks with the next release and is hard for people to diagnose.

## Publishing

A plugin is published by pushing its folder to a git repository (its own, or a folder of a larger one). People
install it with the repository URL and, if needed, the folder.

- Bump `version` in the manifest for every release: Mango offers updates by commit, but shows the version.
- Set `minAppVersion` to the oldest Mango you tested with. (`pnpm dev` and `pnpm app` count as the next patch release,
  so a plugin for an API that is not released yet runs there.)
- Ship the built `main.js` in the repository (Mango does not build plugins), and a README that says what the plugin
  does, which settings it has, and what it reaches outside the API (network, escape hatches).

### Getting into the catalog

The catalog people browse in Settings > Plugins is
[`plugins/catalog.json`](https://github.com/ReaperMaga/mango/blob/main/plugins/catalog.json) in Mango's repository. To
list a plugin there, open a pull request that adds an entry; see
[`plugins/README.md`](https://github.com/ReaperMaga/mango/blob/main/plugins/README.md) for the fields and what a review
looks at.
