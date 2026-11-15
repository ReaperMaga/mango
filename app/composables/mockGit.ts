import type { GitBranches, GitCommit, GitFile, GitStatus } from '~/types/ipc'

/**
 * In-memory git for the browser preview (no Tauri). Implements the `git_*`
 * commands from types/ipc.ts against fake repositories, one per project path,
 * that really change when you stage, discard, commit or switch branch.
 */

interface Change {
  /** M, A, D, R on the staged side; M, D, ? on the working-tree side. */
  status: string
  diff: string
  origPath?: string
}
interface MockFile { path: string; staged: Change | null; unstaged: Change | null }
interface Tracking { upstream: string | null; ahead: number; behind: number }
interface Repo {
  isRepo: boolean
  branch: string
  branches: Record<string, Tracking>
  files: MockFile[]
  log: GitCommit[]
  /** Commits a fetch finds on the remote. */
  incoming: string[]
  /** Renames that were unstaged into a deletion plus a new file, so staging both restores them. */
  renames: { from: string; to: string; change: Change }[]
}

const MIN = 60_000
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('')
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p

function commitOf(subject: string, agoMs: number, author = 'You'): GitCommit {
  const hash = hex(40)
  return { hash, shortHash: hash.slice(0, 7), subject, author, time: Date.now() - agoMs }
}

/* ---------- diff text ---------- */

const head = (from: string, to = from) => `diff --git a/${from} b/${to}\nindex ${hex(7)}..${hex(7)} 100644\n--- a/${from}\n+++ b/${to}\n`

function added(path: string, lines: string[]): string {
  return `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..${hex(7)}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join('\n')}\n`
}
function deleted(path: string, lines: string[]): string {
  return `diff --git a/${path} b/${path}\ndeleted file mode 100644\nindex ${hex(7)}..0000000\n--- a/${path}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n${lines.map(l => `-${l}`).join('\n')}\n`
}
/** Join the hunks of two diffs of the same file, in file order. */
function mergeHunks(a: string, b: string): string {
  const split = (d: string) => {
    const at = d.search(/^@@/m)
    return at < 0 ? { top: d, hunks: [] as string[] } : { top: d.slice(0, at), hunks: d.slice(at).split(/^(?=@@)/m) }
  }
  const start = (h: string) => Number(h.match(/^@@ -(\d+)/)?.[1] ?? 0)
  const [x, y] = [split(a), split(b)]
  return x.top + [...x.hunks, ...y.hunks].sort((p, q) => start(p) - start(q)).join('')
}

/* ---------- the fake repositories ---------- */

const TIME_OLD = [
  '/** Relative time for lists. */',
  'export function relativeTime(ts: number, now = Date.now()): string {',
  '  const s = Math.max(0, Math.round((now - ts) / 1000))',
  "  if (s < 45) return 'now'",
  '  const m = Math.round(s / 60)',
  '  if (m < 60) return `${m}m`',
  '  const h = Math.round(m / 60)',
  '  if (h < 24) return `${h}h`',
  '  const d = Math.round(h / 24)',
  '  if (d < 7) return `${d}d`',
  "  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })",
  '}',
]
const TIME_NEW = [
  '/** Compact relative time for lists: "now", "4m", "3h", "2d", "12 Mar". */',
  'export function shortAgo(ts: number, now = Date.now()): string {',
  ...TIME_OLD.slice(2),
]

function mangoRepo(): Repo {
  const files: MockFile[] = [
    {
      path: 'app/stores/workspace.ts',
      staged: {
        status: 'M',
        diff: `${head('app/stores/workspace.ts')}@@ -47,6 +47,10 @@ export const useWorkspace = defineStore('workspace', {
       terminalTabs: [] as TerminalTab[],
       activeTerminalId: null as string | null,

+      /** Right-hand source control panel. */
+      gitOpen: (prefs.gitOpen ?? false) as boolean,
+      gitWidth: (prefs.gitWidth ?? 380) as number,
+
       /** Permission mode new chats start in. */
       defaultMode: (prefs.defaultMode ?? 'ask') as PermissionMode,

@@ -178,6 +182,14 @@ export const useWorkspace = defineStore('workspace', {
       this.sidebarWidth = Math.round(Math.min(420, Math.max(200, w)))
     },

+    toggleGit(force?: boolean) {
+      this.gitOpen = force ?? !this.gitOpen
+      this.persist()
+    },
+    setGitWidth(w: number) {
+      this.gitWidth = Math.round(Math.min(720, Math.max(300, w)))
+    },
+
     /* ---------- terminal ---------- */
     toggleTerminal(force?: boolean) {
       this.terminalOpen = force ?? !this.terminalOpen
`,
      },
      unstaged: null,
    },
    {
      path: 'app/utils/time.ts',
      staged: {
        status: 'R',
        origPath: 'app/utils/relativeTime.ts',
        diff: `diff --git a/app/utils/relativeTime.ts b/app/utils/time.ts
similarity index 86%
rename from app/utils/relativeTime.ts
rename to app/utils/time.ts
index ${hex(7)}..${hex(7)} 100644
--- a/app/utils/relativeTime.ts
+++ b/app/utils/time.ts
@@ -1,5 +1,5 @@
-${TIME_OLD[0]}
-${TIME_OLD[1]}
+${TIME_NEW[0]}
+${TIME_NEW[1]}
   const s = Math.max(0, Math.round((now - ts) / 1000))
   if (s < 45) return 'now'
   const m = Math.round(s / 60)
`,
      },
      unstaged: null,
    },
    {
      path: 'src-tauri/src/lib.rs',
      staged: {
        status: 'M',
        diff: `${head('src-tauri/src/lib.rs')}@@ -2,6 +2,7 @@ mod agent_proc;
 mod agents;
 mod auth;
 mod bin;
+mod git;
 mod projects;
 mod pty;

`,
      },
      unstaged: {
        status: 'M',
        diff: `${head('src-tauri/src/lib.rs')}@@ -34,6 +34,19 @@ pub fn run() {
             agent_proc::agent_kill,
             auth::agent_auth_status,
             auth::agent_logout,
+            git::git_status,
+            git::git_diff,
+            git::git_stage,
+            git::git_unstage,
+            git::git_discard,
+            git::git_commit,
+            git::git_fetch,
+            git::git_pull,
+            git::git_push,
+            git::git_log,
+            git::git_branches,
+            git::git_checkout,
+            git::git_init,
         ])
         .build(tauri::generate_context!())
         .expect("error while building Mango")
`,
      },
    },
    {
      path: 'app/components/AppWorkspace.vue',
      staged: null,
      unstaged: {
        status: 'M',
        diff: `${head('app/components/AppWorkspace.vue')}@@ -13,6 +13,7 @@ const column = ref<HTMLElement | null>(null)
       <ChatArea class="workspace__chat" />
       <TerminalPanel v-show="ws.terminalOpen" :container="column" />
     </div>
+    <GitPanel v-if="ws.gitOpen" />
   </div>
 </template>

`,
      },
    },
    {
      path: 'scripts/try-agent.ts',
      staged: null,
      unstaged: {
        status: 'D',
        diff: deleted('scripts/try-agent.ts', [
          '// Smoke test: start an agent CLI and print its event stream.',
          "import { spawn } from 'node:child_process'",
          '',
          "const [agent = 'claude', ...prompt] = process.argv.slice(2)",
          "const child = spawn(agent, ['-p', prompt.join(' '), '--output-format', 'stream-json', '--verbose'])",
          "child.stdout.on('data', chunk => process.stdout.write(chunk))",
          "child.on('exit', code => console.log(`\\n${agent} exited with ${code}`))",
        ]),
      },
    },
    {
      path: 'app/components/git/GitPanel.vue',
      staged: null,
      unstaged: {
        status: '?',
        diff: added('app/components/git/GitPanel.vue', [
          '<script setup lang="ts">',
          "import { useGit } from '~/stores/git'",
          "import { useWorkspace } from '~/stores/workspace'",
          '',
          'const ws = useWorkspace()',
          'const git = useGit()',
          "const repo = computed(() => (ws.activeProjectPath ? git.repo(ws.activeProjectPath) : null))",
          '',
          'watch(() => ws.activeProjectPath, path => path && git.refresh(path), { immediate: true })',
          '</script>',
          '',
          '<template>',
          '  <aside class="gp" :style="{ width: `${ws.gitWidth}px` }" aria-label="Changes">',
          '    <header class="gp__head">',
          '      <h2 class="gp__title">Changes</h2>',
          '    </header>',
          '    <ul class="gp__list" role="list">',
          '      <li v-for="f in repo?.status?.files ?? []" :key="f.path">{{ f.path }}</li>',
          '    </ul>',
          '  </aside>',
          '</template>',
        ]),
      },
    },
    {
      path: 'app/stores/git.ts',
      staged: null,
      unstaged: {
        status: '?',
        diff: added('app/stores/git.ts', [
          "import { defineStore } from 'pinia'",
          "import type { GitStatus } from '~/types/ipc'",
          "import { call } from '~/composables/useBackend'",
          '',
          "export const useGit = defineStore('git', {",
          '  state: () => ({ status: {} as Record<string, GitStatus> }),',
          '  actions: {',
          '    async refresh(path: string) {',
          "      this.status[path] = await call('git_status', { path })",
          '    },',
          '  },',
          '})',
        ]),
      },
    },
    {
      path: 'public/changes-panel.png',
      staged: null,
      unstaged: {
        status: '?',
        diff: 'diff --git a/public/changes-panel.png b/public/changes-panel.png\nnew file mode 100644\nindex 0000000..4c1f0aa\nBinary files /dev/null and b/public/changes-panel.png differ\n',
      },
    },
  ]
  return {
    isRepo: true,
    branch: 'main',
    branches: {
      'main': { upstream: 'origin/main', ahead: 1, behind: 0 },
      'feat/terminal': { upstream: 'origin/feat/terminal', ahead: 0, behind: 0 },
      'fix/composer-height': { upstream: null, ahead: 0, behind: 0 },
    },
    files,
    log: [
      commitOf('Add the terminal panel, backed by a real PTY', 38 * MIN),
      commitOf('Thread sidebar with ripeness dots', 5 * 60 * MIN),
      commitOf('Command palette and global shortcuts', 26 * 60 * MIN),
      commitOf('Welcome hub: open, create and clone projects', 2 * 24 * 60 * MIN),
      commitOf('Design tokens for the orchard-at-dusk theme', 4 * 24 * 60 * MIN),
      commitOf('Initial commit', 9 * 24 * 60 * MIN),
    ],
    incoming: ['Keep the composer height when the window resizes', 'Bump tauri to 2.12'],
    renames: [],
  }
}

function sideRepo(branch: string): Repo {
  return {
    isRepo: true,
    branch,
    branches: { 'main': { upstream: 'origin/main', ahead: 0, behind: 0 }, [branch]: { upstream: null, ahead: 0, behind: 0 } },
    files: [
      {
        path: 'src/middleware/rateLimit.ts',
        staged: null,
        unstaged: {
          status: 'M',
          diff: `${head('src/middleware/rateLimit.ts')}@@ -8,7 +8,8 @@ export function rateLimit(options: RateLimitOptions) {
   return async (req: Request, next: Next) => {
     const key = options.keyFor(req)
     const hits = await store.increment(key, options.windowMs)
-    if (hits > options.max) return tooMany()
+    const limit = options.maxFor?.(req) ?? options.max
+    if (hits > limit) return tooMany(limit, options.windowMs)
     return next(req)
   }
 }
`,
        },
      },
      {
        path: 'docs/rate limits.md',
        staged: null,
        unstaged: { status: '?', diff: added('docs/rate limits.md', ['# Rate limits', '', 'Each key gets `max` requests per window. Routes can override it with `maxFor`.']) },
      },
    ],
    log: [commitOf('Sliding-window rate limiter', 3 * 60 * MIN), commitOf('Health and readiness routes', 30 * 60 * MIN), commitOf('Initial commit', 6 * 24 * 60 * MIN)],
    incoming: [],
    renames: [],
  }
}

function cleanRepo(): Repo {
  return {
    isRepo: true,
    branch: 'main',
    branches: { main: { upstream: 'origin/main', ahead: 0, behind: 0 } },
    files: [],
    log: [commitOf('Button: loading state', 20 * 60 * MIN), commitOf('Menu keyboard navigation', 3 * 24 * 60 * MIN), commitOf('Initial commit', 12 * 24 * 60 * MIN)],
    incoming: ['Dialog: trap focus'],
    renames: [],
  }
}

const emptyRepo = (): Repo => ({ isRepo: false, branch: 'main', branches: {}, files: [], log: [], incoming: [], renames: [] })

const repos = new Map<string, Repo>()
function repoAt(path: string): Repo {
  let repo = repos.get(path)
  if (!repo) {
    const name = baseName(path)
    repo = name === 'notes' ? emptyRepo() : name === 'pulp-ui' ? cleanRepo() : name === 'orchard-api' ? sideRepo('feat/rate-limits') : mangoRepo()
    repos.set(path, repo)
  }
  return repo
}

/* ---------- operations ---------- */

const tracking = (r: Repo): Tracking => r.branches[r.branch] ?? { upstream: null, ahead: 0, behind: 0 }

function statusOf(r: Repo, path: string): GitStatus {
  if (!r.isRepo) return { isRepo: false, root: null, branch: null, head: null, upstream: null, ahead: 0, behind: 0, files: [] }
  const t = tracking(r)
  const files: GitFile[] = r.files
    .map(f => ({ path: f.path, origPath: f.staged?.origPath ?? null, index: f.staged?.status ?? null, worktree: f.unstaged?.status ?? null, conflicted: false }))
    .sort((a, b) => Number(a.worktree === '?') - Number(b.worktree === '?') || a.path.localeCompare(b.path))
  return { isRepo: true, root: path, branch: r.branch, head: r.log[0]?.shortHash ?? null, upstream: t.upstream, ahead: t.ahead, behind: t.behind, files }
}

const wanted = (files: string[]) => (f: MockFile) => files.length === 0 || files.includes(f.path)
const prune = (r: Repo) => { r.files = r.files.filter(f => f.staged || f.unstaged) }

function stage(r: Repo, files: string[]) {
  for (const f of r.files.filter(wanted(files))) {
    if (!f.unstaged) continue
    const u = f.unstaged
    if (!f.staged) f.staged = { status: u.status === '?' ? 'A' : u.status, diff: u.diff }
    else if (u.status === 'D') f.staged = f.staged.status === 'A' ? null : { status: 'D', diff: u.diff }
    else f.staged = { ...f.staged, diff: mergeHunks(f.staged.diff, u.diff) }
    f.unstaged = null
  }
  prune(r)
  // A deletion and an addition that came from one rename are a rename again.
  for (const m of [...r.renames]) {
    const [from, to] = [r.files.find(f => f.path === m.from), r.files.find(f => f.path === m.to)]
    if (from?.staged?.status === 'D' && !from.unstaged && to?.staged?.status === 'A' && !to.unstaged) {
      r.files = r.files.filter(f => f !== from)
      to.staged = m.change
      r.renames = r.renames.filter(x => x !== m)
    }
  }
}

function unstage(r: Repo, files: string[]) {
  for (const f of r.files.filter(wanted(files))) {
    if (!f.staged) continue
    const s = f.staged
    if (s.status === 'R' && s.origPath) {
      r.renames.push({ from: s.origPath, to: f.path, change: s })
      r.files.push({ path: s.origPath, staged: null, unstaged: { status: 'D', diff: deleted(s.origPath, TIME_OLD) } })
      f.unstaged = { status: '?', diff: added(f.path, TIME_NEW) }
    } else if (!f.unstaged) {
      f.unstaged = { status: s.status === 'A' ? '?' : s.status, diff: s.diff }
    } else if (s.status === 'A') {
      f.unstaged = { status: '?', diff: s.diff }
    } else {
      f.unstaged = { status: f.unstaged.status, diff: f.unstaged.status === 'D' ? f.unstaged.diff : mergeHunks(s.diff, f.unstaged.diff) }
    }
    f.staged = null
  }
}

function discard(r: Repo, files: string[]) {
  for (const f of r.files) {
    if (files.length === 0) f.unstaged = null
    else if (files.includes(f.path)) {
      // Like the real command: working-tree changes first; a staged-only file goes back to HEAD.
      if (f.unstaged) f.unstaged = null
      else f.staged = null
    }
  }
  prune(r)
}

function commit(r: Repo, message: string, amend: boolean): string {
  const subject = message.trim().split('\n')[0] ?? ''
  if (!subject && !amend) throw new Error('Write a commit message first')
  if (amend && !r.log.length) throw new Error('There is no commit to amend yet.')
  if (!amend && !r.files.some(f => f.staged)) throw new Error('Nothing is staged. Stage the changes you want in this commit first.')
  for (const f of r.files) f.staged = null
  prune(r)
  r.renames = []
  const t = r.branches[r.branch] ??= { upstream: null, ahead: 0, behind: 0 }
  if (amend) {
    const last = r.log[0]!
    r.log[0] = { ...commitOf(subject || last.subject, 0), time: Date.now() }
    if (t.upstream && t.ahead === 0) { t.ahead = 1; t.behind += 1 }
  } else {
    r.log.unshift(commitOf(subject, 0))
    if (t.upstream) t.ahead += 1
  }
  return r.log[0]!.shortHash
}

const REMOTE = 'github.com:you'

async function fetch(r: Repo, path: string): Promise<string> {
  await wait(650)
  const t = tracking(r)
  if (!t.upstream || !r.incoming.length || t.behind > 0) return ''
  t.behind = r.incoming.length
  return `From ${REMOTE}/${baseName(path)}\n   ${r.log[t.ahead]?.shortHash ?? hex(7)}..${hex(7)}  ${r.branch.padEnd(10)} -> ${t.upstream}`
}

async function pull(r: Repo, path: string): Promise<string> {
  const t = tracking(r)
  if (!t.upstream) throw new Error(`${r.branch} isn't tracking a remote branch yet. Publish it first, then pull.`)
  await fetch(r, path)
  if (t.behind === 0) return 'Already up to date.'
  const before = r.log[t.ahead]?.shortHash ?? hex(7)
  const arrived = r.incoming.map((subject, i) => commitOf(subject, (i + 1) * 47 * MIN, 'Priya N.'))
  r.log.splice(t.ahead, 0, ...arrived)
  r.incoming = []
  t.behind = 0
  return `Updating ${before}..${arrived[0]!.shortHash}\nFast-forward\n app/components/chat/ChatComposer.vue | 9 ++++++---\n src-tauri/Cargo.toml                 | 2 +-\n 2 files changed, 7 insertions(+), 4 deletions(-)`
}

async function push(r: Repo, path: string): Promise<string> {
  await wait(700)
  const t = r.branches[r.branch] ??= { upstream: null, ahead: 0, behind: 0 }
  const url = `${REMOTE}/${baseName(path)}.git`
  if (!r.log.length) throw new Error('There are no commits to push yet.')
  if (!t.upstream) {
    t.upstream = `origin/${r.branch}`
    t.ahead = 0
    return `remote: Create a pull request for '${r.branch}' by visiting:\nremote:   https://github.com/you/${baseName(path)}/pull/new/${r.branch}\nTo ${url}\n * [new branch]      ${r.branch} -> ${r.branch}\nbranch '${r.branch}' set up to track '${t.upstream}'.`
  }
  if (t.behind > 0) {
    throw new Error(`The remote has commits you don't have yet. Pull, then push again.\n\nTo ${url}\n ! [rejected]        ${r.branch} -> ${r.branch} (fetch first)\nerror: failed to push some refs to '${url}'`)
  }
  if (t.ahead === 0) return 'Everything up-to-date'
  const from = r.log[t.ahead]?.shortHash ?? hex(7)
  t.ahead = 0
  return `To ${url}\n   ${from}..${r.log[0]!.shortHash}  ${r.branch} -> ${r.branch}`
}

function checkout(r: Repo, branch: string, create: boolean) {
  const name = branch.trim()
  if (!name) throw new Error('Enter a branch name')
  if (create) {
    if (/[\s~^:?*[\\]|^-|\.\.|\/$|^\//.test(name)) throw new Error(`"${name}" is not a valid branch name`)
    if (r.branches[name]) throw new Error(`fatal: a branch named '${name}' already exists`)
    r.branches[name] = { upstream: null, ahead: 0, behind: 0 }
  } else if (!r.branches[name]) {
    throw new Error(`fatal: invalid reference: ${name}`)
  }
  r.branch = name
}

export async function mockGit(cmd: string, args: any): Promise<any> {
  const path = String(args?.path ?? '')
  const r = repoAt(path)
  if (cmd === 'git_status') return statusOf(r, path)
  if (cmd === 'git_init') {
    if (!r.isRepo) {
      Object.assign(r, emptyRepo(), {
        isRepo: true,
        branches: { main: { upstream: null, ahead: 0, behind: 0 } },
        files: [
          { path: 'ideas/2026.md', staged: null, unstaged: { status: '?', diff: added('ideas/2026.md', ['# 2026', '', '- A pane for git changes', '- Ripeness for long-running tasks']) } },
          { path: 'todo.md', staged: null, unstaged: { status: '?', diff: added('todo.md', ['- [ ] water the mango tree', '- [x] open this folder in Mango']) } },
        ],
      })
    }
    return
  }
  if (!r.isRepo) throw new Error(`${path} is not inside a git repository`)
  switch (cmd) {
    case 'git_diff': {
      const f = r.files.find(x => x.path === args.file)
      return (args.staged ? f?.staged?.diff : f?.unstaged?.diff) ?? ''
    }
    case 'git_stage': return stage(r, args.files ?? [])
    case 'git_unstage': return unstage(r, args.files ?? [])
    case 'git_discard': return discard(r, args.files ?? [])
    case 'git_commit': return commit(r, String(args.message ?? ''), !!args.amend)
    case 'git_fetch': return fetch(r, path)
    case 'git_pull': return pull(r, path)
    case 'git_push': return push(r, path)
    case 'git_log': return r.log.slice(0, args.limit ?? 20)
    case 'git_branches': return { current: r.branch, local: Object.keys(r.branches).sort() } satisfies GitBranches
    case 'git_checkout': return checkout(r, String(args.branch ?? ''), !!args.create)
    case 'git_branch_list': {
      const now = Date.now()
      const names = Object.keys(r.branches)
      return {
        current: r.branch,
        local: names.map((name, i) => ({
          name, isCurrent: name === r.branch, upstream: r.branches[name]!.upstream, upstreamGone: false,
          ahead: r.branches[name]!.ahead, behind: r.branches[name]!.behind,
          time: now - (i + 1) * 3_600_000 * (i + 1), subject: r.log[i]?.subject ?? 'Work in progress',
        })),
        remote: [...new Set(['origin/main', 'origin/feat/persistence', 'origin/fix/terminal-resize', ...names.filter(n => r.branches[n]!.upstream).map(n => r.branches[n]!.upstream!)])]
          .map((name, i) => ({ name, remote: 'origin', time: now - (i + 2) * 5_400_000, subject: r.log[i]?.subject ?? 'Remote work' })),
        remotes: ['origin'],
      }
    }
    case 'git_branch_create': {
      const from = r.branch
      checkout(r, String(args.name ?? ''), true)
      if (!args.checkout) r.branch = from
      return
    }
    case 'git_checkout_remote': {
      const local = String(args.branch).replace(/^origin\//, '')
      if (!r.branches[local]) r.branches[local] = { upstream: String(args.branch), ahead: 0, behind: 0 }
      r.branch = local
      return local
    }
    case 'git_merge': return `Merge made by the 'ort' strategy.\n ${String(args.branch)} merged into ${r.branch}`
    case 'git_rebase': return `Successfully rebased and updated refs/heads/${r.branch}.`
    case 'git_branch_rename': {
      const from = String(args.from); const to = String(args.to).trim()
      if (!to) throw new Error('Enter a branch name')
      if (r.branches[to]) throw new Error(`fatal: a branch named '${to}' already exists`)
      r.branches[to] = r.branches[from]!; delete r.branches[from]
      if (r.branch === from) r.branch = to
      return
    }
    case 'git_branch_delete': {
      const name = String(args.branch)
      if (name === r.branch) throw new Error(`error: cannot delete branch '${name}' used by worktree`)
      if (!args.force && r.branches[name] && !r.branches[name]!.upstream) throw new Error(`error: the branch '${name}' is not fully merged`)
      delete r.branches[name]
      return
    }
  }
  throw new Error(`mock: ${cmd} is not implemented`)
}
