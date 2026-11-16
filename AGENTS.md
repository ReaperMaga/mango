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
cd src-tauri && cargo test && cargo build                               # backend tests, no new warnings
cd src-tauri && cargo check --target x86_64-pc-windows-msvc             # Windows must keep compiling

# Windows installer from Linux (needs nsis, lld, llvm, clang, the msvc rust target, cargo-xwin)
pnpm tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc

# Drive an agent adapter against the real CLI, outside the app
node scripts/try-agent.ts claude /path/to/scratch-project "say hi" --mode ask --raw
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
  agents/            claude.ts, codex.ts: CLI protocol -> AgentEvents. index.ts: runs turns, bridges to Rust
  assets/css/        tokens.css (the only source of colour/type/space/radius/motion), base.css
  components/        AppTitlebar, AppSidebar (threads), AppToolStrip + AppToolPanel (right tool windows), AppWorkspace, ChatArea, CommandPalette
    chat/            ChatPane, ChatMessage, ChatTool, ChatApproval, ChatComposer, ChatWorking
    git/             GitPanel (Changes tool window), GitDiffPane + GitDiff (main-pane diffs), GitBranchPopup
    files/           FilesPanel (Files tool window), FilesEditorPane (Monaco editor tab), FilesImageView (pictures, SVG preview)
    browser/         BrowserPane (a browser tab: toolbar over the placeholder its native webview covers)
    links/           LinksPanel (Pull requests tool window: the chat's linked pull requests and issues), LinksItem, LinksCheckLog (a GitHub Actions job's log)
    settings/        SettingsView and its sections (General, Agents, Environments, Terminal, Voice, Appearance)
    envs/            remote environments inside Settings: server and instance pages, dialogs, EnvTerminal, EnvDesktop
    setup/           GettingStarted: the first-run dialog that installs and signs in to agents
    terminal/        TerminalPanel, TerminalView (xterm.js)
    ui/              UiButton, IconButton, UiMenu, UiDialog, UiField, RipenessDot, MangoMark
  composables/       useBackend.ts (typed IPC + browser mock), useOverlay.ts (HTML layers that hide the browsers' native views), mockGit.ts, mockFiles.ts, mockGithub.ts, monaco.ts (lazy Monaco + token theme), useShortcuts.ts
  stores/            workspace.ts (projects, layout, prefs), threads.ts (chats, tabs, panes, linked items), git.ts, files.ts, links.ts, updater.ts,
                     browser.ts (browser tabs: webviews, bounds sync, agent-opened browsers)
  types/             ipc.ts (the frontend <-> Rust contract), chat.ts (threads, messages, statuses)
  utils/             mockAgent.ts, demoThreads.ts, diffTabs.ts, fileTabs.ts, browserTabs.ts (tab ids, address normalising), imageFiles.ts, editorModels.ts, time.ts, paths.ts,
                     githubLinks.ts (find created PRs/issues), linkState.ts, safeHtml.ts (sanitise outside HTML),
                     chatImages.ts (pictures in agent replies), chatHistory.ts (saving chats: debounced, incremental), actionsLog.ts (GitHub Actions log lines: groups, markers, ANSI)
src-tauri/src/
  agent_proc.rs      starts agent CLIs, forwards stdio line by line as events
  auth.rs            agent sign-in status / sign-out
  setup.rs           "Get started": what is installed, per-OS installer recipes run in a PTY (`setup_install`)
  vcs.rs             the `git_*` commands: detects git or Unity VCS per folder and dispatches; an `env://` path runs git in its environment (`git::At`)
  git.rs             everything the Changes view and branch popup need (shells out to git)
  plastic.rs         the same for Unity Version Control workspaces (shells out to `cm`, XML output)
  files.rs           the Files view: `fs_*` commands, every path confined to the project folder
  github.rs          `gh_item`: a pull request or issue read through the GitHub CLI (`gh` owns the sign-in); `gh_job`: an Actions job's log
  browser.rs         browser tabs: native child webviews over the main window (`browser_*`), http(s) only
  browser_mcp.rs     the browser tools agents get: an MCP server on 127.0.0.1, one secret URL per chat
  browser_remote.rs  a remote project's browser: SSH tunnels to the environment's localhost, and the reverse forward for its agents
  chats.rs           chat history: `chats_load` / `chats_save` on a SQLite file (rusqlite, bundled)
  images.rs          `chat_image`: a picture an agent's reply shows; any path, but only real raster images (by their bytes)
  pty.rs, shells.rs  terminals; discovery of installed shells
  projects.rs        open / create / clone, recent projects
  updater.rs         self-update: checks the latest GitHub release's latest.json, installs, restarts
  envs/              remote environments over ssh + incus: hosts.rs (saved servers), ssh.rs (quoting, command lines),
                     incus.rs (instances), recipes.rs (one-click components), remote.rs (shells, sign-in, desktop tunnel),
                     server.rs (install, set up and update Incus on the server)
  voice.rs           voice input: pinned Whisper download (SHA-256 checked) and local transcription (candle)
  bin.rs             finding binaries on PATH, `hide_console`
scripts/try-agent.ts run an adapter against the real CLI
```

## Rules that keep the app working

### The IPC contract
- `app/types/ipc.ts` is the single contract. A new backend command needs four things: the Rust command
  (registered in `src-tauri/src/lib.rs`), its entry in `Commands`/`Events` in `ipc.ts`, a mock in
  `useBackend.ts` (or `mockGit.ts`) so `pnpm dev` keeps working, and the caller.
- Rust commands are `async`, do blocking work off the UI thread, and return `Result<T, String>` with a
  message a person can act on. Structs use `#[serde(rename_all = "camelCase")]`.
- Never call `invoke` directly from components: go through `call()` / `on()` in `useBackend.ts`.

### Cross-platform
- Every `std::process::Command` gets `crate::bin::hide_console(&mut cmd)`, or Windows flashes a console window.
- Paths may use `\`: use `utils/paths.ts` (`baseName`, `withTrailingSep`), never `split('/')`.
- Do not use HTML5 drag and drop: the desktop webview takes it over on Windows. Use pointer events
  (see the reordering code in `AppSidebar.vue`).
- Menus and popups are teleported to `<body>` with fixed positioning (`UiMenu`, `GitBranchPopup`) so no
  ancestor can clip or cover them. Keep it that way.

### Agents
- An adapter (`app/agents/*.ts`) turns one CLI's protocol into `AgentEvent`s (`app/agents/types.ts`) and ends
  every run with exactly one `turn-end`. It must stay runnable in plain Node: import **only types** from
  `~/…`, no Vue, Pinia or Tauri APIs, erasable TypeScript only.
- Prove adapter changes against the real CLI with `scripts/try-agent.ts` in a scratch folder (never in this
  repo). Keep prompts tiny: every run spends the user's quota.
- Mango never handles credentials. Sign-in is the CLI's own flow, run in an embedded terminal.
- Installing works the same way: `setup.rs` picks the vendor's own installer per OS and runs it in a PTY the
  user watches. The frontend only names a tool id; never build an install command line from webview input.
- Agent output is untrusted text: `ChatMarkdown.vue` escapes raw HTML. Do not weaken that. Pictures in a
  reply (`![alt](path)`) come only from local files through `chat_image`, which reads nothing but real raster
  images; never fetch a picture URL from the web (it can carry data out of the chat). A pull request's
  description (GitHub's rendered HTML) goes through `utils/safeHtml.ts` before `v-html`; keep its allow-list tight.
- Pull requests and issues an agent creates are linked to the chat by `utils/githubLinks.ts` (`createdBy`), which only
  trusts a `gh pr|issue create` command or a GitHub MCP create tool, never a link the agent merely mentions.
- The browser (`browser.rs`, `browser_mcp.rs`, `stores/browser.ts`): pages in it are untrusted. Its webviews load only http(s)
  (and about:blank) and never get Mango's IPC. The MCP server that hands agents the browser tools binds 127.0.0.1 only, and
  each chat's URL carries its own secret token. Each webview is a native view drawn over all HTML: every floating layer
  (menu, dialog, popup, a resize drag) registers with `useOverlay`/`holdOverlay` so the browsers hide while it is up.
- Remote environments (`src-tauri/src/envs/`): nothing of Mango's runs on the server; each action is one `ssh … incus …`
  call with the user's own keys (`BatchMode` unless a terminal is shown). Every value from the webview passes a validator in
  `envs/mod.rs` and reaches the remote shell only through `ssh::quote`; install scripts are constants in `recipes.rs`.
  Remote projects are keyed `env://<hostId>/<instance>/<dir>` (`utils/envPath.ts`). The `git_*`, `fs_*` and `gh_*`
  commands accept them (git and file access run inside the instance through `git::At`; `gh` stays local and only the
  repository is read from the remotes there); anything else that touches the local disk must skip them (`isEnvPath`).
- The browser preview has no backend to run CLIs; it simulates replies and labels them "Simulated".

### State
- Chat statuses are defined in `types/chat.ts` (`ThreadStatus`, `displayStatus`): Idle, Working, Settled,
  Archived, plus "Needs you" and "Failed" which only a run can set. While a run is active it owns the status.
- Chats and their layout persist to a SQLite file in the app data folder (`chats.rs`, `utils/chatHistory.ts`):
  one row per chat holding its JSON, saved debounced and incrementally. `persist(id)` marks one chat changed,
  `persist()` compares them all (and is the only way deletions reach the database), `persistLayout()` is tabs and
  panes only; mutate a chat without one of them and the change is not saved. Prefs persist to localStorage
  (`workspace.ts`). Loading must tolerate data written by older builds (`normalizeLoaded`).
- Git is slow and external: all git state goes through `stores/git.ts`, which refreshes after every action.

### Git safety in the backend
- Ref names from the UI go through `safe_ref` before reaching git. File names are literal
  (`GIT_LITERAL_PATHSPECS=1`). `GIT_TERMINAL_PROMPT=0` so nothing waits on a prompt nobody sees.
- Discard and delete destroy work: the UI asks first (two-step confirm), and the backend refuses unsafe cases.
- Unity VCS (`plastic.rs`): branch names go through `safe_branch`; `cm` never gets a prompt (`--noinput`,
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

- **Always:** typecheck, `cargo test`, `cargo build` with no new warnings, and the Windows `cargo check`.
- **UI:** run `pnpm dev` and look at it. The mock backend supplies projects, a git repository and simulated
  agents; "Load demo threads" in the command palette (Ctrl+K) fills the sidebar. Pinia stores are reachable
  for scripted checks: `document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$pinia._s`.
- **Native behaviour** (PTY, real agents, real git): build the debug binary and run it against the dev
  server, on a private display if needed (`xvfb-run`), with `XDG_DATA_HOME` pointed at a scratch folder so
  test projects do not land in the real app data.
- Say what was and was not tested. Windows builds here are cross-compiled and have not been run on Windows.

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
