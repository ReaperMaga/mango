---
version: 1
slug: "app-app-vue"
primary_target: "app/app.vue"
related_targets: []
---

# Workspace shell (app/)

Scope: the whole Mango desktop app shell — welcome hub, workspace (sidebar, chat tabs/splits, composer), docked terminal. Visitor mode: Operate.

Audience/job: one developer running Claude Code and Codex threads in parallel across local repos; long sessions, mostly dark room, sometimes daylight. Task: open/create/clone a project, start and switch between several agent chats, use a real shell without leaving the app. Constraints: Tauri webview, custom titlebar, keyboard-first, dark + light themes. Reference for craft bar (not world): JetBrains Air.

User skipped the decision round ("start right away if you have a proper idea"); direction chosen unattended from the roll.

## Direction contract

THESIS: Agent threads are fruit on a branch: each one visibly ripens from queued to running to needs-you to done. Refuses the category default of a grey IDE with one blue accent and identical grey status dots.
OWN-WORLD: Mango orchard at dusk. Dark ground is leaf-shade green-black (hue ~160, very low chroma), panels lift in steps of lightness, never by borders alone. Accent is ripe mango flesh (warm orange-gold ~hue 65); unripe leaf green for queued; blush coral for needs-you; yellow-gold for done. Light theme: pale leaf-tinted paper white, accent deepened for contrast. Inter Variable for UI at 13px density, JetBrains Mono for code and terminal only. Radius scale 4/6/8/12 (controls 6, panels 8, floating layers and composer 12), soft offset shadows only on floating layers.
STORY: The user sees every thread's state in one glance at the sidebar, jumps to any with a keystroke, splits two chats side by side, and pulls the terminal up from the bottom without losing context.
FIRST VIEWPORT: Custom titlebar 40px (mark, project switcher + branch, centered command search, panel toggles, window controls). Left rail 260px: New chat, threads grouped by project with ripeness dots, footer settings. Center: chat tab strip, one or two chat panes, composer docked at pane bottom with agent picker. Bottom: terminal panel ~35% height, tabs, drag-resizable. Welcome hub when no project: open / new / clone actions and recent list, centered column.
FORM: grounded candidate 7 of 7 (mango ripeness as status grammar), seed:b132fe9e3a62140f.
SIGNATURE: the ripeness dot — a small fruit-shaped status mark whose colour and fill level change as a thread ripens (hollow when idle or queued, half-filled and breathing while running, full when it needs you or is done), used in sidebar, tabs and pane headers.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
