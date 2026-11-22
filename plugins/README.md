# Plugins

This folder holds Mango's official plugins and the plugin catalog.

- `catalog.json`: the list people browse in **Settings > Plugins > Browse plugins**. Mango fetches it from
  `https://raw.githubusercontent.com/ReaperMaga/mango/main/plugins/catalog.json` and also carries a copy built into the
  app for when it is offline, so it must be valid JSON at every commit.
- `<id>/`: one official plugin per folder, installed from this repository with the folder as its subpath.
- `mango-plugin.d.ts`: the plugin API as a standalone TypeScript declaration, for authors.

How to write a plugin is in [docs/plugins.md](../docs/plugins.md).

| Plugin | What it does | Shows |
|---|---|---|
| [prompt-templates](prompt-templates/) | Your own slash commands from prompt templates | slash commands, settings |
| [secret-guard](secret-guard/) | Catches keys and tokens before a message is sent | `onBeforeSend`, confirm |
| [focus-timer](focus-timer/) | A work and break timer in the titlebar | status items, notifications, storage |
| [scratchpad](scratchpad/) | A notes tool window per project | tool windows, a Vue component |
| [csv-preview](csv-preview/) | csv and tsv blocks in replies as tables | code block renderers, styles |
| [turn-chime](turn-chime/) | A chime when an agent finishes | `onTurnEnd`, WebAudio |
| [copy-as-markdown](copy-as-markdown/) | Copy a reply or a chat as Markdown | message actions, menus |
| [unity](unity/) | Unity projects: hidden `.meta` files that follow their assets, icons, project details, checks | `ui.files`, project status item, `appendSystemPrompt` |

The official plugins are plain JavaScript with no build step. `pnpm test` checks them and the catalog
(`tests/officialPlugins.test.ts`). In `pnpm dev` the mock backend serves them straight from this folder.

## Adding a plugin to the catalog

Community plugins live in their own repositories; the catalog only points at them. To list one, open a pull request
that adds an entry to `catalog.json`. Title it `feat(plugins): add <id> to the catalog`.

```json
{
  "id": "my-plugin",
  "name": "My plugin",
  "description": "One sentence on what it does for the person using it.",
  "author": "Your name",
  "version": "1.0.0",
  "tags": ["chat"],
  "official": false,
  "icon": "sparkles",
  "source": { "url": "https://github.com/you/mango-my-plugin", "ref": "v1.0.0", "subpath": null },
  "minAppVersion": "0.1.36",
  "homepage": "https://github.com/you/mango-my-plugin"
}
```

| Field | |
|---|---|
| `id`, `name`, `version`, `minAppVersion` | The same as in the plugin's `mango-plugin.json` at `ref`. Update `version` with each release you want listed. |
| `description` | One plain sentence, no marketing. |
| `author` | You, or your organisation. |
| `tags` | One to three of: `chat`, `prompts`, `safety`, `productivity`, `notifications`, `tools`, `theme`, `git`. Ask in the pull request if none fits. |
| `official` | `false`. Only plugins maintained in this repository are official. |
| `icon` | A lucide icon name Mango draws (the set in `app/components/plugins/PluginGlyph.vue`); omit it for the default. |
| `source.url` | A public `https://` git repository. |
| `source.ref` | A tag or commit, so what people install is what was reviewed. Use `null` only for a branch you keep stable. |
| `source.subpath` | The plugin's folder in the repository, or `null` for the root. |
| `homepage` | Where people read about it: the repository or its README. |

### What a review looks at

A plugin runs with Mango's full rights, so the review reads the code at `ref`:

- The repository holds the built `main.js` and the code it was built from, with a README that says what the plugin
  does, its settings, and anything it reaches beyond the API (the network, the backend, the stores).
- It does what the description says, and nothing else: no telemetry, nothing sent anywhere people did not ask for.
- Untrusted text (agent output, chat messages, file contents, web pages) never goes into `innerHTML` or `v-html`.
- No secrets in logs, settings or storage; no code fetched and run at runtime.
- It cleans up: timers and listeners it makes itself are undone in `onDispose`, so turning it off leaves nothing behind.
- It fits Mango: styled with the design tokens, works in dark and light theme, and its commands and labels read like
  Mango's own (plain words, sentence case).

An update to a listed plugin is a pull request that changes `version` and `ref`. An entry whose repository disappears
or stops matching its review is removed.

## Changing an official plugin

Edit it here, bump `version` in both its `mango-plugin.json` and its catalog entry, and run `pnpm test`. Plugin changes
go in their own commits, scoped `feat(plugins): …` or `fix(plugins): …`.
