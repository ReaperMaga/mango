# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Desktop app: a Tauri 2 webview. The UI is web technology; it should still feel like a native desktop tool, not a website.)

## Stack

- Shell / backend: Rust + Tauri 2.
- Frontend: Nuxt (SPA mode, `ssr: false`) + Vue 3 + TypeScript.
- Terminal: xterm.js in the frontend, a real PTY in Rust (`portable-pty`).
- Styling: delegated — plain CSS with design tokens (custom properties), no utility framework, so the token system in DESIGN.md is the single source of truth.

## Users

Primary user: the author, a developer who runs coding agents (Claude Code, Codex) all day across several repositories. They want one calm desktop workspace where projects, many parallel agent chats and a terminal live side by side. Public distribution to other developers may come later; nothing should block it, but onboarding and marketing surfaces are out of scope for now.

## Product Purpose

Mango is a desktop "agent workbench": open or create a project (local folder, new folder, or git clone), run several agent chats against it at once in tabs or splits, and keep a real built-in terminal docked at the bottom, the way an IDE does. Success: the user stops juggling terminal windows and browser tabs to run agents; switching between parallel agent threads is instant and legible.

## Positioning

Simpler than a full IDE, more structured than a terminal. Agent chats are the primary object, not files. Agents are the user's existing local CLIs (Claude Code, Codex), so Mango is a workspace around tools the user already trusts, not a new agent.

## Operating Context

- Long sessions, often on a large monitor, frequently in a dark room; also used in daylight (needs a light theme).
- Many chats run concurrently; the user glances at status (running, waiting for approval, done, error) more than they read every message.
- Keyboard-heavy: command palette, tab switching, terminal toggle.
- Reference products the user named: JetBrains Air (primary reference for feel), T3 Code, VS Code (docked terminal).

## Capabilities and Constraints

Built so far:
- Welcome / project hub: open folder, create new project, clone a git repository, recent projects.
- Workspace: project + thread sidebar, multiple chat tabs and split chat panes, agent / model / permission pickers, composer.
- Real agent runs: Mango drives the installed Claude Code and Codex CLIs (streaming, tool calls, diffs, approvals, resume). Permission modes: Plan, Ask first, Accept edits, Full auto.
- Changes panel (git): status, diffs, stage, commit, fetch / pull / push, branches, history.
- Docked terminal panel (real PTY), toggleable and resizable, multiple terminal tabs.
- Settings: agents (install state, sign in / out through the CLI's own login), default agent and permission mode, theme.
- Dark and light themes.

Constraints:
- Mango never handles credentials itself; signing in is the CLI's own flow, run in an embedded terminal.
- The list of agents will grow; anything agent-specific lives behind the adapter interface in `app/agents/`.

Undecided: persistence format for chat history, attachments, "always allow" approval rules.

## Brand Commitments

- Name: **Mango**. Existing mark: `assets/icon.svg` (rounded square, "M"). The teal in it is a placeholder, not a commitment.
- Feel the user asked for: "similar to JetBrains Air: slick, smooth, good UI". Binding as a reference for quality and calm density, not as something to copy.

## Evidence on Hand

None. No users, testimonials or metrics; do not fabricate any.

## Product Principles

1. Threads are first-class: every agent chat has a visible status and can be reached in one keystroke.
2. The terminal is a peer, not an afterthought: always one shortcut away, real shell.
3. Calm by default: the UI recedes so agent output and code carry the attention.
4. Local-first: projects are folders on disk; agents are the user's own CLIs.
