import type { Thread } from '~/types/chat'

/** Synthetic demo threads (clearly mock content) for exploring the UI. */
export function demoThreads(projectPath: string): Thread[] {
  const now = Date.now()
  const min = 60_000
  const base = { projectPath, seen: true, mode: 'ask' as const, simulated: true }
  const id = (n: string) => `demo-${n}-${Math.random().toString(36).slice(2, 6)}`

  return [
    {
      ...base,
      id: id('term'),
      title: 'Wire the terminal panel to a real PTY',
      agent: 'claude',
      model: 'opus',
      status: 'done',
      seen: false,
      branch: 'feat/terminal',
      createdAt: now - 42 * min,
      updatedAt: now - 2 * min,
      messages: [
        { id: id('m'), role: 'user', createdAt: now - 42 * min, parts: [{ type: 'text', text: 'Hook the bottom terminal panel up to a real shell. Use portable-pty on the Rust side and xterm.js in the panel. It should resize with the panel and survive switching tabs.' }] },
        {
          id: id('m'), role: 'agent', createdAt: now - 41 * min, parts: [
            { type: 'thinking', text: 'Two halves: a PTY manager in Rust that streams output as events, and an xterm instance per terminal tab that stays mounted when hidden so scrollback survives.', seconds: 6 },
            { type: 'tool', tool: 'read', target: 'src-tauri/src/lib.rs', status: 'ok', summary: '88 lines' },
            { type: 'tool', tool: 'write', target: 'src-tauri/src/pty.rs', status: 'ok', summary: '+142' },
            {
              type: 'tool', tool: 'edit', target: 'src-tauri/src/lib.rs', status: 'ok', summary: '+6 −1', diff: [
                { kind: 'ctx', text: 'mod projects;' },
                { kind: 'add', text: 'mod pty;' },
                { kind: 'hunk', text: '@@ pub fn run()' },
                { kind: 'del', text: '        .invoke_handler(tauri::generate_handler![open_project])' },
                { kind: 'add', text: '        .manage(pty::PtyState::default())' },
                { kind: 'add', text: '        .invoke_handler(tauri::generate_handler![' },
                { kind: 'add', text: '            open_project, pty::pty_spawn, pty::pty_write, pty::pty_resize, pty::pty_kill,' },
                { kind: 'add', text: '        ])' },
              ],
            },
            { type: 'tool', tool: 'bash', target: 'cargo check', status: 'ok', summary: 'finished in 14.2s', output: '    Checking mango v0.1.0 (/home/you/Projects/mango/src-tauri)\n    Finished `dev` profile [unoptimized + debuginfo] target(s) in 14.20s' },
            { type: 'text', text: 'The panel now runs your login shell through a real PTY.\n\n- Output streams over `pty://data`; split UTF-8 sequences are buffered so emoji and box-drawing characters arrive intact.\n- Each tab keeps its xterm instance mounted while hidden, so scrollback survives tab switches.\n- Resizing the panel calls `pty_resize` after a fit, debounced to one frame.\n\nRun `pnpm app` and toggle the panel with **Ctrl+J**.' },
          ],
        },
      ],
    },
    {
      ...base,
      id: id('clone'),
      title: 'Clone dialog: show git progress inline',
      agent: 'codex',
      model: 'default',
      status: 'waiting',
      seen: false,
      branch: 'main',
      createdAt: now - 18 * min,
      updatedAt: now - 1 * min,
      messages: [
        { id: id('m'), role: 'user', createdAt: now - 18 * min, parts: [{ type: 'text', text: 'When cloning, show git’s progress lines under the URL field instead of a spinner. Make failures readable.' }] },
        {
          id: id('m'), role: 'agent', createdAt: now - 17 * min, parts: [
            { type: 'tool', tool: 'search', target: 'clone://progress', status: 'ok', summary: '2 matches in 2 files' },
            { type: 'tool', tool: 'read', target: 'app/components/CloneDialog.vue', status: 'ok', summary: '163 lines' },
            { type: 'approval', command: 'git clone --progress https://github.com/tauri-apps/tauri /tmp/mango-clone-check', reason: 'Check what git prints on a real clone before parsing it', state: 'pending' },
          ],
        },
      ],
    },
    {
      ...base,
      id: id('rate'),
      title: 'Persist threads to SQLite',
      agent: 'claude',
      model: 'sonnet',
      status: 'running',
      branch: 'feat/persistence',
      createdAt: now - 9 * min,
      updatedAt: now,
      messages: [
        { id: id('m'), role: 'user', createdAt: now - 9 * min, parts: [{ type: 'text', text: 'Threads live in localStorage right now. Move them to a SQLite file in the app data dir, one row per message part, and migrate what is already there.' }] },
        {
          id: id('m'), role: 'agent', createdAt: now - 8 * min, parts: [
            { type: 'thinking', text: 'rusqlite with the bundled feature keeps the build self-contained. Schema: threads, messages, parts. The migration reads the existing localStorage blob once on first launch.', seconds: 4 },
            { type: 'tool', tool: 'read', target: 'app/stores/threads.ts', status: 'ok', summary: '214 lines' },
            { type: 'tool', tool: 'write', target: 'src-tauri/migrations/0001_threads.sql', status: 'ok', summary: '+38' },
            { type: 'tool', tool: 'bash', target: 'cargo add rusqlite --features bundled', status: 'running' },
          ],
        },
      ],
    },
    {
      ...base,
      id: id('palette'),
      title: 'Command palette fuzzy matching',
      agent: 'codex',
      model: 'default',
      status: 'error',
      branch: 'main',
      createdAt: now - 3 * 60 * min,
      updatedAt: now - 2 * 60 * min,
      messages: [
        { id: id('m'), role: 'user', createdAt: now - 3 * 60 * min, parts: [{ type: 'text', text: 'Make the command palette match “nwch” to “New chat”.' }] },
        {
          id: id('m'), role: 'agent', createdAt: now - 3 * 60 * min, parts: [
            { type: 'tool', tool: 'bash', target: 'pnpm typecheck', status: 'error', summary: 'exit 2', output: "app/components/CommandPalette.vue:48:11 - error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'." },
            { type: 'text', text: 'The typecheck failed on my change to `CommandPalette.vue`. The session ended before I fixed it; send a message to pick it back up.' },
          ],
        },
      ],
    },
    {
      ...base,
      id: id('readme'),
      title: 'Write the README',
      agent: 'claude',
      model: 'haiku',
      status: 'working',
      branch: 'main',
      createdAt: now - 26 * 60 * min,
      updatedAt: now - 25 * 60 * min,
      messages: [],
    },
  ]
}
