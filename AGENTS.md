# AGENTS.md

Guidance for coding agents (and people) working on Mango. Read this before changing anything.
`README.md` describes the product for users, `PRODUCT.md` holds product context, `DESIGN.md` is the design system.

## What Mango is

A desktop workbench for coding agents: pick a project, run several Claude Code and Codex chats side by side,
review and commit changes, and keep a real terminal docked at the bottom. The feel to hold is JetBrains Air:
calm, dense, keyboard-first.

- **Shell / backend:** Rust + Tauri 2 (`src-tauri/`)
- **Frontend:** Nuxt 4 as an SPA (`ssr: false`), Vue 3 `<script setup lang="ts">`, Pinia (`app/`)
- **Styling:** plain CSS with design tokens. No utility framework.
- **Package manager:** pnpm. Node 24, Rust stable.

## Commands

```bash
pnpm install
pnpm dev            # UI only at http://localhost:1420, with an in-memory mock backend
pnpm app            # the desktop app (tauri dev)
pnpm app:build      # release build + installers

pnpm bump patch|minor|major|1.2.3   # set the version everywhere (prints the commit + tag commands)
pnpm version:check                  # every copy of the version agrees (exit 1 if not)

pnpm nuxt prepare && pnpm vue-tsc --noEmit -p .nuxt/tsconfig.app.json   # typecheck (must be clean)
pnpm test                                                               # plain Node unit tests in tests/ (must pass)
cd src-tauri && cargo test && cargo build                               # backend tests, no new warnings
cd src-tauri && cargo check --target x86_64-pc-windows-msvc             # Windows must keep compiling
# macOS: CI runs `cargo check` on a Mac runner. From Linux, stub the C compiler (no Apple SDK here):
#   CC_aarch64_apple_darwin=<stub> AR_aarch64_apple_darwin=llvm-ar cargo check --target aarch64-apple-darwin --all-targets

# Windows installer from Linux (needs nsis, lld, llvm, clang, the msvc rust target, cargo-xwin)
pnpm tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc

# Drive an agent adapter against the real CLI, outside the app
node scripts/try-agent.ts claude /path/to/scratch-project "say hi" --mode ask --raw

# The iOS app (its own package; see mobile/AGENTS.md)
cd mobile && pnpm install && pnpm typecheck && pnpm test   # must be clean
cd mobile && pnpm web                                      # UI in a browser, simulated environment
cd mobile && pnpm ios                                      # development build (needs Xcode 16.3+)
```

**Versioning:** semver, with `package.json` as the single source. `tauri.conf.json` reads it (`"version":
"../package.json"`), the frontend bakes it in with the git commit (`nuxt.config.ts`, read via `useBuildInfo()`,
shown in Settings > General), and `pnpm bump` keeps `Cargo.toml` and `Cargo.lock` in step. Never edit a version by
hand. Releases are tagged `vX.Y.Z` on a `chore(release): vX.Y.Z` commit.

The dev port is **1420** (`nuxt.config.ts` and `src-tauri/tauri.conf.json` must agree). TypeScript is pinned to
5.9 because vue-tsc does not run on TypeScript 7.

## Layout

```
app/
  agents/            claude.ts, codex.ts: CLI protocol -> AgentEvents. index.ts: runs turns, bridges to Rust. keeper.ts: keeps a chat's CLI process between turns
  assets/css/        tokens.css (the only source of colour/type/space/radius/motion), base.css
  components/        AppTitlebar, AppSidebar (threads) + AppSidebarFoot (account, usage, help, settings), AppToolStrip + AppToolPanel (right tool windows), AppWorkspace, ChatArea, CommandPalette
    chat/            ChatPane, ChatMessage, ChatTool, ChatApproval, ChatComposer, ChatWorking
    git/             GitPanel (Changes tool window), GitDiffPane + GitDiff (main-pane diffs), GitBranchPopup, GitLogPanel (the Git log, a bottom panel tab) + GitLogGraph, GitLogRefs, GitLogCommit, GitCommitDiffPane (a commit's file diff in a tab)
    files/           FilesPanel (Files tool window), FilesEditorPane (Monaco editor tab), FilesDecompiledPane (a library's decompiled source, read-only), FilesImageView (pictures, SVG preview)
    browser/         BrowserPane (a browser tab: toolbar over the placeholder its native webview covers)
    links/           LinksPanel (Pull requests tool window: the chat's linked pull requests and issues), LinksItem, LinksCheckLog (a GitHub Actions job's log), LinksPicker (pick an open pull request or issue to link)
    releases/        ReleasesPanel (Releases tool window: the project's GitHub releases and the workflow runs building them), ReleasesItem
    plugins/         Settings > Plugins: PluginsBrowse (the official catalog: search, filters), PluginsInstalled, PluginDetail (+ PluginSettingsForm), PluginAddDialog (from a git link or a local folder), PluginViewHost (renders any plugin-provided view)
    settings/        SettingsView and its sections (General, Agents, Environments, Terminal, Editor + SettingsLanguageServers, Voice, Appearance), and project settings: ProjectEnv (+ ProjectEnvFields), a project's .env files
    envs/            remote environments inside Settings: server and instance pages, dialogs, EnvTerminal, EnvDesktop
    setup/           GettingStarted: the first-run dialog that installs and signs in to agents
    terminal/        TerminalPanel, TerminalView (xterm.js)
    ui/              UiButton, IconButton, UiMenu, UiDialog, UiField, RipenessDot, MangoMark
  composables/       useBackend.ts (typed IPC + browser mock), useOverlay.ts (HTML layers that hide the browsers' native views), mockGit.ts, mockFiles.ts, mockGithub.ts, mockReleases.ts, useReleaseWatch.ts (keeps the Releases button's mark current), panelTabs.ts (the bottom panel's tabs: built-in and plugins'), useGitLogView.ts (the Git log's loading, search and selection), monaco.ts (lazy Monaco + token theme, text-only markdown), editorDocuments.ts (model URIs, reloads as edits, jumps between files), editorCompletion.ts, editorFeel.ts (caret, suggestions), useAutoSave.ts (when the app asks for saves), windowClose.ts (saves before a window goes), useShortcuts.ts
  i18n/              interface languages: locales.ts (which one shows), messages/ (en is the source and the type de and ru must fill); plugins/i18n.ts applies the `locale` pref
  lsp/               the language server client: protocol, rpc, uri, sync, watched, convert, semanticTokens, languages, session, pool (plain-Node testable); store, service, providers wire it to Pinia and Monaco; decompiled (library source a server decompiled for go to definition); builtins + tsWorker (Monaco's workers held to one file), modelUris, editGuard
  stores/            workspace.ts (projects, layout, prefs), threads.ts (chats, tabs, panes, linked items), git.ts, gitLog.ts (jumps and the actions on a commit), files.ts, links.ts, releases.ts (GitHub releases and their runs, per project), updater.ts,
                     browser.ts (browser tabs: webviews, bounds sync, agent-opened browsers),
                     projectEnv.ts (Settings > Projects > Environment variables: env files, in-memory drafts; values never persisted)
                     plugins.ts (installed plugins, the catalog, each plugin's settings values)
  plugin-host/       the plugin runtime: types.ts (the public plugin API, the contract), runtime.ts (loading, activating, safe mode), api.ts (the `mango` object),
                     registry.ts (everything plugins registered), fileHooks.ts (what plugins add to project files, as the app reads it), scope.ts, hooks.ts, ids.ts, semver.ts (plain-Node testable), ui/ (icons, toasts and dialogs, tool windows, tabs, status items)
  types/             ipc.ts (the frontend <-> Rust contract), chat.ts (threads, messages, statuses)
  utils/             mockAgent.ts, demoThreads.ts, diffTabs.ts, commitDiffTabs.ts, gitLog.ts (lane layout, search; plain-Node testable), builtIns.ts (built-in panel tabs, plugins that became part of Mango), fileTabs.ts, decompiledTabs.ts (decompiled source tabs, the server's answer checked; plain-Node testable), browserTabs.ts (tab ids, address normalising), imageFiles.ts, editorModels.ts, autoSave.ts (when open files save themselves; plain-Node testable), reloadEdits.ts, time.ts, paths.ts,
                     shortcuts.ts (keyboard shortcuts as data: defaults, matching, conflicts), notifications.ts (what a notification says),
                     githubLinks.ts (find created PRs/issues), linkState.ts, linkPicker.ts (filtering the open ones to link), safeHtml.ts (sanitise outside HTML),
                     chatImages.ts (pictures in agent replies), chatHistory.ts (saving chats: debounced, incremental), remoteChats.ts (remote projects' chats mirrored into their environment), actionsLog.ts (GitHub Actions log lines: groups, markers, ANSI),
                     releaseRuns.ts (which runs build which release, job summaries, files by platform)
src-tauri/src/
  agent_proc.rs      starts agent CLIs, forwards stdio line by line as events
  agent_sessions.rs  `agent_transcript`: the end of a Claude Code session's transcript, read only
  auth.rs            agent sign-in status / sign-out
  setup.rs           "Get started": what is installed, per-OS installer recipes run in a PTY (`setup_install`)
  vcs.rs             the `git_*` commands: detects git or Unity VCS per folder and dispatches; an `env://` path runs git in its environment (`git::At`)
  git.rs             everything the Changes view and branch popup need (shells out to git)
  plastic/           the same for Unity Version Control workspaces (shells out to `cm`, XML output): mod.rs, one file per extra feature
  lsp/               language servers (`lsp_*`): servers.rs (the only command lines and installers), resolve.rs (which program runs), session.rs + framing.rs (pipes), tree.rs (the whole process tree ends with it), folder.rs (which folder the user's consent is bound to, and whether a worktree follows its project's)
  files.rs           the Files view: `fs_*` commands, every path confined to the project folder
  file_ops.rs        the Files view's new folder, rename, duplicate, delete and show in file manager: the entry itself (never a link's target), never replacing
  trash_bin.rs       moving to the system's trash, and never deleting for good instead (Windows: its own shell sink, the trash crate does delete for good there)
  github.rs          `gh_item`: a pull request or issue read through the GitHub CLI (`gh` owns the sign-in); `gh_job`: an Actions job's log
  releases.rs        `gh_releases`, `gh_tag_run`, `gh_run`, `gh_run_action`: releases and their workflow runs (re-run, cancel), through `gh` too
  gitlab.rs          GitLab: which hosts are GitLab servers (gitlab.com, `gitlab.*`, the user's list in gitlab-hosts.json), the project's forge
                     from its git remotes (`project_forge`, nested groups), running `glab`. The `gh_*` commands dispatch here by forge
  gitlab_items.rs    merge requests (as `kind: 'pr'`), issues, merging, MR create and CI job logs through `glab` (GraphQL + REST)
  gitlab_releases.rs GitLab releases and pipelines (as runs): retry, run again, cancel
  hosting.rs         Settings > Git hosting: `gh` / `glab` sign-in status, sign in (in a PTY, host validated) and sign out
  browser.rs         browser tabs: native child webviews over the main window (`browser_*`), http(s) only
  browser_mcp.rs     the browser tools agents get: an MCP server on 127.0.0.1, one secret URL per chat
  mcp.rs             the user's own MCP servers (`mcp_servers`, `mcp_servers_save`): mcp-servers.json, owner-only, checked on save
  plugins/           plugins (`plugins_*`): install from a git repository (or a folder in one) or a local folder, updates, confined file reads, the official catalog
  browser_remote.rs  a remote project's browser: SSH tunnels to the environment's localhost, and the reverse forward for its agents
  chats.rs           chat history: `chats_load` / `chats_save` on a SQLite file (rusqlite, bundled)
  chats_remote.rs    remote projects' chats kept inside their environment (`chats_remote_*`), so other computers see them
  images.rs          `chat_image`: a picture an agent's reply shows; any path, but only real raster images (by their bytes)
  notify.rs          `notify`: one system notification (the frontend decides when, `composables/notify.ts`)
  pty.rs, shells.rs  terminals; discovery of installed shells
  projects.rs        open / create / clone, recent projects
  updater.rs         self-update: checks the latest GitHub release's latest.json, installs, restarts
  envs/              remote environments over ssh + incus: hosts.rs (saved servers), ssh.rs (quoting, command lines),
                     incus.rs (instances), recipes.rs (one-click components), remote.rs (shells, sign-in, desktop tunnel),
                     server.rs (install, set up and update Incus on the server)
  voice.rs           voice input: pinned Whisper download (SHA-256 checked) and local transcription (candle)
  bin.rs             finding binaries on PATH, `hide_console`
scripts/try-agent.ts run an adapter against the real CLI
plugins/             the official plugins (one folder each) and catalog.json, the catalog Settings > Plugins > Browse shows (also compiled in as the offline copy)
mobile/              the iOS app (Expo SDK 58, React Native, expo-router): its own package, see mobile/AGENTS.md
```

## Rules that keep the app working

### The IPC contract
- `app/types/ipc.ts` is the single contract. A new backend command needs four things: the Rust command
  (registered in `src-tauri/src/lib.rs`), its entry in `Commands`/`Events` in `ipc.ts`, a mock in
  `useBackend.ts` (or `mockGit.ts`) so `pnpm dev` keeps working, and the caller.
- `window_close_heard`, `window_close_answer` and `window_unsaved` are synchronous on purpose: closes are decided on the main
  thread, in order.
- Rust commands are `async`, do blocking work off the UI thread, and return `Result<T, String>` with a
  message a person can act on. Structs use `#[serde(rename_all = "camelCase")]`.
- Never call `invoke` directly from components: go through `call()` / `on()` in `useBackend.ts`.

### Cross-platform
- Every `std::process::Command` gets `crate::bin::hide_console(&mut cmd)`, or Windows flashes a console window.
- Paths may use `\`: use `utils/paths.ts` (`baseName`, `withTrailingSep`), never `split('/')`.
- Do not use HTML5 drag and drop: the desktop webview takes it over on Windows. Use pointer events
  (see the reordering code in `AppSidebar.vue`).
- Look windows up with `get_window` / `windows()`, never as webview windows (a browser tab hides those). Never add
  `onCloseRequested`: closing is asked of the page through `composables/windowClose.ts` (`src-tauri/src/windows.rs`).
- Menus and popups are teleported to `<body>` with fixed positioning (`UiMenu`, `GitBranchPopup`) so no
  ancestor can clip or cover them. Keep it that way.

### Agents
- An adapter (`app/agents/*.ts`) turns one CLI's protocol into `AgentEvent`s (`app/agents/types.ts`) and ends
  every run with exactly one `turn-end`. It must stay runnable in plain Node: import **only types** from
  `~/…`, no Vue, Pinia or Tauri APIs, erasable TypeScript only.
- A local Claude Code chat keeps its process between turns (`agents/keeper.ts`): a new one that resumes re-sends every
  instruction file that changed since, in full. Whatever decides how a process is started belongs in its key (`processKey`
  in `claude.ts`), and whatever a kept process must not outlive (its folder going, a sign-out, its chat) calls
  `releaseAgents`. Remote runs are never kept: another device may go on with the chat. Before a kept process is used
  again, the last message in the session's transcript (`agent_transcript`) must be one it printed: the user may have gone on
  with the session in a terminal. Transcripts are only ever read. Model and effort are the exception to the key: a kept process is
  asked to change them, and used only once `get_settings` says it runs at them (`wake` in `claude.ts`); it is never asked back to
  a default, which comes out different there. The permission mode stays in the key: a process started with bypassPermissions
  can fall back to that after an approved plan.
- Prove adapter changes against the real CLI with `scripts/try-agent.ts` in a scratch folder (never in this
  repo). Keep prompts tiny: every run spends the user's quota.
- Mango never handles credentials. Sign-in is the CLI's own flow, run in an embedded terminal.
- Installing works the same way: `setup.rs` picks the vendor's own installer per OS and runs it in a PTY the
  user watches. The frontend only names a tool id; never build an install command line from webview input.
- Agent output is untrusted text: `ChatMarkdown.vue` escapes raw HTML. Do not weaken that. Pictures in a
  reply (`![alt](path)`) come only from local files (or, in a remote project, files inside its environment)
  through `chat_image`, which reads nothing but real raster images (the phone app runs the same script, `mobile/src/remote/images.ts`: keep them in step); never fetch a picture URL from the web (it can carry data out of the chat). A pull request's
  description (GitHub's rendered HTML) goes through `utils/safeHtml.ts` before `v-html`; keep its allow-list tight.
- Pull requests and issues an agent creates are linked to the chat by `utils/githubLinks.ts` (`createdBy`), which only
  trusts a `gh pr|issue create` / `glab mr|issue create` command or a GitHub/GitLab MCP create tool, never a link the agent
  merely mentions. GitLab link keys use `!N` for merge requests (their numbers are separate from issues'); GitHub keys never change.
- GitLab (`gitlab*.rs`): `glab` owns the sign-in, like `gh`. A GitLab-shaped link on a host Mango does not know as GitLab is
  refused before `glab` sees it, so a token never goes to a server the user did not name. Values reach `glab api` as `-f` raw
  fields only (never `-F`, which reads `@file`). The phone ports these files in `mobile/src/remote/gitlab*.ts`: keep them in step.
- The browser (`browser.rs`, `browser_mcp.rs`, `stores/browser.ts`): pages in it are untrusted. Its webviews load only http(s)
  (and about:blank) and never get Mango's IPC. The MCP server that hands agents the browser tools binds 127.0.0.1 only, and
  each chat's URL carries its own secret token. Each webview is a native view drawn over all HTML: every floating layer
  (menu, dialog, popup, a resize drag) registers with `useOverlay`/`holdOverlay` so the browsers hide while it is up.
- Language servers (`src-tauri/src/lsp/`, `app/lsp/`): they can run a project's code, so they start only through `lsp/service.ts`, in
  local projects the user allowed (`allowed` in `lsp/store.ts`), never for `env://`. The frontend names an id; the backend resolves
  the program outside the project (never `node_modules/.bin`, the current folder or a rustup proxy). `lsp_send` and `lsp_stop` are
  synchronous commands on purpose (message order) and must not block. What servers say is untrusted: keep `lsp/convert.ts` strict
  (and `lsp/semanticTokens.ts`, which maps each server's token legend onto the few kinds the theme colours, each a rule in
  `monaco.ts`; types it does not map are dropped so the tokenizer's colours stay) and Monaco's markdown text-only (`monaco.ts`; check that deep import when upgrading Monaco). Prove backend changes with the
  ignored `lsp::tests::real_*` tests. Go to definition opens only the project's own files; a library's source comes only as
  text its server decompiled (`csharp/metadata`, checked in `utils/decompiledTabs.ts`), shown read-only and never read from disk. A chat's worktree takes its project's answer only while `lsp/folder.rs` proves it a
  linked git worktree of it, and a yes only while it is also the folder bound to that yes (`languageServersWorktree`: where
  Mango adds a worktree, it calls `worktreeMade`); any other folder, Unity VCS workspaces included, answers for itself. A
  folder's own no always wins. `lsp/folder.rs` follows a path it read only past `near`: looking asks no other computer.
- Monaco's workers answer about one file and edit only its current text (`lsp/builtins.ts`): never share a program between
  models, reuse a model URI, trust markdown or let a link run a command. When upgrading Monaco check its deep imports
  (`monaco.ts`, `lsp/tsWorker.ts`), the suggest-controller internals in `editorFeel.ts`, and the TypeScript and
  tokenization internals in `lsp/builtins.ts`.
- Remote environments (`src-tauri/src/envs/`): nothing of Mango's runs on the server; each action is one `ssh … incus …`
  call with the user's own keys (`BatchMode` unless a terminal is shown). Every value from the webview passes a validator in
  `envs/mod.rs` and reaches the remote shell only through `ssh::quote`; install scripts are constants in `recipes.rs`.
  Remote projects are keyed `env://<hostId>/<instance>/<dir>` (`utils/envPath.ts`). The `git_*`, `fs_*` and `gh_*`
  commands accept them (git and file access run inside the instance through `git::At`; `gh` stays local and only the
  repository is read from the remotes there); anything else that touches the local disk must skip them (`isEnvPath`).
- Remote round trips are the cost to watch (a fresh SSH connection is ~1 s on a distant server). Short captured commands
  share one background connection per host (`ssh::batch_argv`, `ControlMaster`; not on Windows, whose OpenSSH lacks it);
  terminals, agents and tunnels keep their own. Git reads that would run one after another go in one call (`git::run_all`),
  and reads skip the login shell (`EnvAt::run_plain`, which falls back to it when a tool is missing); anything that may run
  hooks keeps it. Long commands and the connection check (`ssh::run_alone`) use their own connection. Measure with the ignored
  `files::tests::remote_timing` test.
- Plugins (`app/plugin-host/`, `src-tauri/src/plugins/`, `docs/plugins.md`): installed plugins are trusted code running in Mango's
  window; the user is told so before installing. `app/plugin-host/types.ts` is their API: change it additively, keep `docs/plugins.md`
  and `plugins/mango-plugin.d.ts` in step. Nuxt auto-loads files in `app/plugins/` as its own plugins, so nothing of this lives there.
  Everything a plugin registers goes through its scope and is undone when it stops; a plugin's error is caught, logged to it, and never
  breaks the app. Git sources pass `validate.rs` (URL, ref, subpath) before reaching git, and a plugin's files are read only from inside its
  folder. An official plugin is a folder in `plugins/` plus its entry in `plugins/catalog.json` (`tests/officialPlugins.test.ts` checks them).
- Plugins' file hooks (`ui.files`, `plugin-host/fileHooks.ts`) run per row inside computeds: call them only through
  that file, which guards them and reports outside the computed. A companion (Unity's `.meta`) must never be separated
  from its entry: whatever in Mango renames or deletes project entries goes through `stores/files.ts` (`renameEntry`, `companionPaths` + `deleteEntry`), which uses `utils/companions.ts`.
- User MCP servers (Settings > MCP servers, `stores/mcp.ts`, `utils/mcpServers.ts`): each run gets the enabled ones for its agent
  and project (`mcpServersForRun`; a remote project only its own), and `agents/mcp.ts` turns them into the CLI's arguments.
  Their env values and headers are secrets: never log them or put them on the command line; they go into the CLI's
  environment and the config names the variable (Claude Code `${VAR}`, Codex `env_vars` / `env_http_headers`). Test with
  `pnpm test` (plain Node, `tests/`).
- The browser preview has no backend to run CLIs; it simulates replies and labels them "Simulated".

### The mobile app (`mobile/`)
- It is one more computer opening a remote environment: it runs the same commands inside the instance as the
  desktop (ported in `mobile/src/remote/`) and syncs chats through the same files (`chats_remote.rs`). Change one
  side's scripts, chat JSON or revision rules and the other must follow; the desktop's `app/agents/` adapters and
  `app/types/chat.ts` are shared with it directly (`~/…`), so keep them free of Vue, Pinia and Tauri.
- The phone speaks SSH itself (`mobile/modules/mango-ssh`, SwiftNIO SSH): Ed25519 keys stay in the Keychain, every
  connection pins the host key. Values from the UI, a link or a chat file reach the remote shell only through
  `quote` (`mobile/src/remote/shell.ts`), after the same validators as `envs/mod.rs`.

### Interface languages
- New text in a translated component goes into `app/i18n/messages/` in every language and is read with `t()` inside the
  template or a `computed`, so it follows a change of language. Mango's own words only: never agent, git or terminal output.

### State
- Chat statuses are defined in `types/chat.ts` (`ThreadStatus`, `displayStatus`): Idle, Working, Settled,
  Archived, plus "Needs you" and "Failed" which only a run can set. While a run is active it owns the status.
- Chats and their layout persist to a SQLite file in the app data folder (`chats.rs`, `utils/chatHistory.ts`):
  one row per chat holding its JSON, saved debounced and incrementally. `persist(id)` marks one chat changed,
  `persist()` compares them all (and is the only way deletions reach the database), `persistLayout()` is tabs and
  panes only; mutate a chat without one of them and the change is not saved. A remote project's chats are also mirrored
  into its environment (`utils/remoteChats.ts`, fed by what `chatHistory.ts` saves), stored with `env://@` in place of
  this computer's server id; a chat read from there must stay inside that environment (`parseShared`). Prefs persist to localStorage
  (`workspace.ts`). Loading must tolerate data written by older builds (`normalizeLoaded`).
- Files save themselves (`utils/autoSave.ts`, `stores/files.ts`): whatever changes project files from outside the editor runs in
  `files.aroundChange`, and whatever only reads them in `aroundRead` or after `saveAll`, so a save can neither be missed nor undo
  it. Saves keep `expectedHash`, and `expectedModifiedMs` for where there is no hash. An open model is reloaded with `reloadDocument`, never `setValue`.
- Git is slow and external: all git state goes through `stores/git.ts`, which refreshes after every action.
- A chat may work in its own linked git worktree (`Thread.worktree`, `utils/worktrees.ts`). "New chat in a worktree"
  makes a chat with `awaitingWorktree` set: it runs nowhere until its first send, which adds the worktree on a branch
  named from that message (`threads._addWorktreeFor`) before the agent starts. Anything that acts on
  "the folder the user is looking at" (Changes, Files, branch, new terminal) uses `threads.workdir`, not
  `activeProjectPath`; the agent runs in `threads.workdirFor(id)`. Tabs opened from a worktree carry its folder and
  belong to the chat's project through `threads.ownerOf`.

### Git safety in the backend
- Ref names from the UI go through `safe_ref` before reaching git. File names are literal
  (`GIT_LITERAL_PATHSPECS=1`). `GIT_TERMINAL_PROMPT=0` so nothing waits on a prompt nobody sees.
- Discard and delete destroy work: the UI asks first (two-step confirm), and the backend refuses unsafe cases.
- Unity VCS (`plastic/`): branch names go through `safe_branch`; `cm` never gets a prompt (`--noinput`,
  `PLASTICEDITOR` removed). Read structured output with `--xml --encoding=utf-8`: plain `cm` output is in the
  console code page and mangles non-ASCII names. Prove changes with the ignored `plastic::tests::real_cm` test
  against a throwaway workspace (`MANGO_CM_WORKSPACE`), never a real one.

## Design: use the impeccable skill

All UI work goes through the **impeccable** design skill, vendored at `.claude/skills/impeccable/`
(its reviewer and documenter agents are in `.claude/agents/`).

1. Before UI work, run `.claude/skills/impeccable/scripts/impeccable context` from the repo root. It loads
   `PRODUCT.md`, `DESIGN.md` and the surface brief (`.impeccable/surfaces/`).
2. Read `.claude/skills/impeccable/reference/craft-floor.md` immediately before editing UI, and
   `reference/operate.md` for app screens. Mango is an **Operate** surface: precision and restraint.
3. Build with the tokens in `app/assets/css/tokens.css` only. Named rules from `DESIGN.md` that matter most:
   - `--accent` is a fill (with `--accent-fg` on it); accent-coloured text and icons use `--accent-ink`.
   - Status colours have a mark grade (`--ripe-*`) and a text grade (`--ripe-*-fg`).
   - Depth comes from lightness steps (app < canvas < panel < raised); shadows only on floating layers.
   - Monospace is for code, paths, branches and the terminal only.
   - Thread status is shown with the ripeness dot (`ui/RipenessDot.vue`): colour plus fill level.
4. Bans from the craft floor: no kicker/eyebrow labels over headings, no gradient text, no side-stripe
   borders, no emoji as icons (use `lucide-vue-next`), no same-size icon cards as page structure, no glass.
5. After the change, run `.claude/skills/impeccable/scripts/impeccable detect --json app` and fix what it finds.
6. Look at the result in both themes (`<html data-theme="dark|light">`) at 1440x900 and at the minimum
   window size, 960x600.
7. For a new surface or a larger redesign, finish with the `impeccable-finish-reviewer` agent, and update
   `DESIGN.md` through the `impeccable-documenter` agent when the system itself changed.

The project owner prefers building over choosing: **skip impeccable's mockup / direction-choice rounds**
unless asked for them. Ask at most one short batch of product questions, then build.

## Verifying a change

- **Always:** typecheck, `pnpm test`, `cargo test`, `cargo build` with no new warnings, and the Windows `cargo check`.
- **UI:** run `pnpm dev` and look at it. The mock backend supplies projects, a git repository and simulated
  agents; "Load demo threads" in the command palette (Ctrl+K) fills the sidebar. Pinia stores are reachable
  for scripted checks: `document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$pinia._s`.
- **Native behaviour** (PTY, real agents, real git): build the debug binary and run it against the dev
  server, on a private display if needed (`xvfb-run`), with `XDG_DATA_HOME` pointed at a scratch folder so
  test projects do not land in the real app data.
- Say what was and was not tested. Windows builds here are cross-compiled and have not been run on Windows; macOS
  builds come from CI only and have not been run here. macOS window settings live in `src-tauri/tauri.macos.conf.json`
  (merged over `tauri.conf.json`: keep its window entry in step), and the titlebar leaves room for the traffic lights.

## Housekeeping

- Never `pkill -f "nuxt dev"`: it kills other dev servers (and the shell running it). Kill by PID.
- Do not edit generated or vendored files: `.nuxt/`, `.output/`, `src-tauri/gen/`, `src-tauri/icons/`,
  `.claude/skills/impeccable/`.
- **Always use Conventional Commits prefixes**, for everything that carries a title: commit messages, pull
  request titles, issue titles, release names and branch names (`feat/…`, `fix/…`). Types: `feat`, `fix`, `docs`,
  `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`; optional scope such as `feat(git): …`; `!`
  after the type (or a `BREAKING CHANGE:` footer) for breaking changes. Write the subject in the imperative, lower
  case, no trailing period. One logical change per commit.
- Keep `README.md` in step with user-visible changes.
- `docs/changelog.md` writes itself: `pnpm bump` turns the `feat`/`fix`/`perf` commits since the last tag (not `mobile`-scoped ones) into the new version's section, so commit subjects must read well to a user. Hand-written bullets under `## Unreleased` are kept and come first.
