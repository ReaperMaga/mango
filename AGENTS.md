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

pnpm nuxt prepare && pnpm vue-tsc --noEmit -p .nuxt/tsconfig.app.json   # typecheck (must be clean)
cd src-tauri && cargo test && cargo build                               # backend tests, no new warnings
cd src-tauri && cargo check --target x86_64-pc-windows-msvc             # Windows must keep compiling

# Windows installer from Linux (needs nsis, lld, llvm, clang, the msvc rust target, cargo-xwin)
pnpm tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc

# Drive an agent adapter against the real CLI, outside the app
node scripts/try-agent.ts claude /path/to/scratch-project "say hi" --mode ask --raw
```

The dev port is **1420** (`nuxt.config.ts` and `src-tauri/tauri.conf.json` must agree). TypeScript is pinned to
5.9 because vue-tsc does not run on TypeScript 7.

## Layout

```
app/
  agents/            claude.ts, codex.ts: CLI protocol -> AgentEvents. index.ts: runs turns, bridges to Rust
  assets/css/        tokens.css (the only source of colour/type/space/radius/motion), base.css
  components/        AppTitlebar, AppSidebar, AppWorkspace, ChatArea, CommandPalette
    chat/            ChatPane, ChatMessage, ChatTool, ChatApproval, ChatComposer, ChatWorking
    git/             GitPanel (sidebar Changes view), GitDiffPane + GitDiff (main-pane diffs), GitBranchPopup
    settings/        SettingsView and its sections (Agents, Terminal, Appearance, General)
    terminal/        TerminalPanel, TerminalView (xterm.js)
    ui/              UiButton, IconButton, UiMenu, UiDialog, UiField, RipenessDot, MangoMark
  composables/       useBackend.ts (typed IPC + browser mock), mockGit.ts, useShortcuts.ts
  stores/            workspace.ts (projects, layout, prefs), threads.ts (chats, tabs, panes), git.ts
  types/             ipc.ts (the frontend <-> Rust contract), chat.ts (threads, messages, statuses)
  utils/             mockAgent.ts, demoThreads.ts, diffTabs.ts, time.ts, paths.ts
src-tauri/src/
  agent_proc.rs      starts agent CLIs, forwards stdio line by line as events
  auth.rs            agent sign-in status / sign-out
  git.rs             everything the Changes view and branch popup need (shells out to git)
  pty.rs, shells.rs  terminals; discovery of installed shells
  projects.rs        open / create / clone, recent projects
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
- Agent output is untrusted text: `ChatMarkdown.vue` escapes raw HTML. Do not weaken that.
- The browser preview has no backend to run CLIs; it simulates replies and labels them "Simulated".

### State
- Chat statuses are defined in `types/chat.ts` (`ThreadStatus`, `displayStatus`): Idle, Working, Settled,
  Archived, plus "Needs you" and "Failed" which only a run can set. While a run is active it owns the status.
- Threads, tabs and prefs persist to localStorage (`threads.ts`, `workspace.ts`). Loading must tolerate data
  written by older builds (`normalizeLoaded`).
- Git is slow and external: all git state goes through `stores/git.ts`, which refreshes after every action.

### Git safety in the backend
- Ref names from the UI go through `safe_ref` before reaching git. File names are literal
  (`GIT_LITERAL_PATHSPECS=1`). `GIT_TERMINAL_PROMPT=0` so nothing waits on a prompt nobody sees.
- Discard and delete destroy work: the UI asks first (two-step confirm), and the backend refuses unsafe cases.

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
