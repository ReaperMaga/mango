---
layout: home

hero:
  name: Mango
  text: A desktop workbench for coding agents
  tagline: Run several Claude Code and Codex chats side by side on a project, review and commit what they change, and keep a real terminal docked at the bottom.
  actions:
    - theme: brand
      text: Download
      link: /guide/install
    - theme: alt
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/ReaperMaga/mango
---

## What Mango does

Mango is a calm, keyboard-first desktop app for Windows and Linux, built with Rust, Tauri 2 and Nuxt. It is a workspace around the agent CLIs you already use, not a new agent: every chat runs your own installed `claude` or `codex` command, signed in with that tool's own sign-in.

**Parallel chats.** Open a project and start as many chats as you like, in tabs or split side by side. The sidebar groups them by status (Working, Settled, Archived) and marks the ones that need you.

**You decide how much an agent may do.** Each chat has a permission mode: Plan, Ask first, Accept edits or Full auto. When an agent wants to edit a file or run a command, Mango shows the request and waits for Allow once or Deny.

**Review and commit in the same window.** The Changes view lists what changed, opens diffs side by side or in one column, and stages, commits, pulls and pushes. A branch popup handles checkout, new branches, merge, rebase, rename and delete.

**Unity Version Control too.** A folder inside a Unity VCS (Plastic SCM) workspace uses the same Changes view, driven by your own `cm` client.

**A real terminal.** A PTY docked at the bottom, with tabs and any shell Mango finds on your machine: PowerShell, Command Prompt, Git Bash, WSL, Nushell, or your login shell on Linux.

Current release: <ReleaseVersion />. See the [changelog](/changelog) for what is in it.
