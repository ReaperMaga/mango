import type { GitBranches, GitCommit, GitFile, GitStatus, GitWorktree, MergePreview, VcsKind, VcsLock, VcsShelve } from '~/types/ipc'

/**
 * In-memory git for the browser preview (no Tauri). Implements the `git_*`
 * commands from types/ipc.ts against fake repositories, one per project path,
 * that really change when you stage, discard, commit or switch branch.
 * The `fruit-stand` project is a Unity VCS workspace and answers the way the
 * real backend does for one (checkins, `/main/...` branches, update).
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
  vcs: VcsKind
  /** Unity VCS: the repository the workspace is bound to. */
  repository: string | null
  isRepo: boolean
  branch: string
  branches: Record<string, Tracking>
  files: MockFile[]
  log: GitCommit[]
  /** Commits a fetch finds on the remote. */
  incoming: string[]
  /** Renames that were unstaged into a deletion plus a new file, so staging both restores them. */
  renames: { from: string; to: string; change: Change }[]
  /** Unity VCS: branches that have changesets of their own (and so can't be deleted). */
  used?: Set<string>
  /** Unity VCS: locks in the repository, mine and other people's. */
  locks?: VcsLock[]
  /** Unity VCS: branches already merged into the workspace's branch. */
  merged?: Set<string>
  /** Unity VCS: shelves on the server, with the changes each one holds. */
  shelves?: MockShelve[]
}
interface MockShelve extends VcsShelve { files: MockFile[] }

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
    vcs: 'git',
    repository: null,
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
    vcs: 'git',
    repository: null,
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
    vcs: 'git',
    repository: null,
    isRepo: true,
    branch: 'main',
    branches: { main: { upstream: 'origin/main', ahead: 0, behind: 0 } },
    files: [],
    log: [commitOf('Button: loading state', 20 * 60 * MIN), commitOf('Menu keyboard navigation', 3 * 24 * 60 * MIN), commitOf('Initial commit', 12 * 24 * 60 * MIN)],
    incoming: ['Dialog: trap focus'],
    renames: [],
  }
}

const emptyRepo = (): Repo => ({ vcs: 'git', repository: null, isRepo: false, branch: 'main', branches: {}, files: [], log: [], incoming: [], renames: [] })

/* ---------- a Unity VCS workspace ---------- */

let nextChangeset = 1290
function changesetOf(subject: string, agoMs: number, author = 'you@orchard.studio'): GitCommit {
  const id = nextChangeset++
  return { hash: `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`, shortHash: `cs:${id}`, subject, author, time: Date.now() - agoMs }
}

function unityRepo(): Repo {
  const noTrack = { upstream: null, ahead: 0, behind: 0 }
  nextChangeset = 1285
  const log = ([
    ['Initial import from Unity 6', 20 * 24 * 60 * MIN],
    ['Item stacks merge on pickup', 2 * 24 * 60 * MIN],
    ['Farm scene: move the well next to the barn', 22 * 60 * MIN],
    ['Inventory grid: drag to reorder slots', 3 * 60 * MIN],
    ['Crops: wilt when not watered for two days', 50 * MIN],
  ] as const).map(([subject, ago]) => changesetOf(subject, ago)).reverse()
  const files: MockFile[] = [
    {
      path: 'Assets/Scripts/Inventory/InventoryGrid.cs',
      staged: null,
      unstaged: {
        status: 'M',
        diff: `${head('Assets/Scripts/Inventory/InventoryGrid.cs')}@@ -41,9 +41,13 @@ public class InventoryGrid : MonoBehaviour
     public bool TryAdd(ItemStack stack)
     {
-        var slot = slots.FirstOrDefault(s => s.IsEmpty);
-        if (slot == null) return false;
-        slot.Set(stack);
+        // Top up stacks of the same item before taking an empty slot.
+        foreach (var s in slots.Where(s => s.Item == stack.Item && !s.IsFull))
+            stack = s.Absorb(stack);
+        if (stack.Count == 0) return true;
+        var empty = slots.FirstOrDefault(s => s.IsEmpty);
+        if (empty == null) return false;
+        empty.Set(stack);
         onChanged?.Invoke();
         return true;
     }
`,
      },
    },
    {
      path: 'Assets/Scenes/Farm.unity',
      staged: null,
      unstaged: {
        status: 'M',
        diff: `${head('Assets/Scenes/Farm.unity')}@@ -2214,7 +2214,7 @@ Transform:
   m_GameObject: {fileID: 1820347715}
   serializedVersion: 2
   m_LocalRotation: {x: 0, y: 0.38268343, z: 0, w: 0.9238795}
-  m_LocalPosition: {x: 12.5, y: 0, z: -4}
+  m_LocalPosition: {x: 9.75, y: 0, z: -6.5}
   m_LocalScale: {x: 1, y: 1, z: 1}
   m_ConstrainProportionsScale: 0
   m_Children: []
`,
      },
    },
    {
      path: 'Assets/Scripts/Items/ItemStack.cs',
      staged: null,
      unstaged: {
        status: 'R',
        origPath: 'Assets/Scripts/ItemStack.cs',
        diff: 'diff --git a/Assets/Scripts/ItemStack.cs b/Assets/Scripts/Items/ItemStack.cs\nrename from Assets/Scripts/ItemStack.cs\nrename to Assets/Scripts/Items/ItemStack.cs\n',
      },
    },
    {
      path: 'Assets/Scripts/Legacy/SaveV1.cs',
      staged: null,
      unstaged: {
        status: 'D',
        diff: deleted('Assets/Scripts/Legacy/SaveV1.cs', [
          '// Version 1 saves, read once and rewritten as version 2.',
          'public static class SaveV1',
          '{',
          '    public static bool CanRead(byte[] data) => data.Length > 4 && data[0] == 0x46 && data[4] == 1;',
          '}',
        ]),
      },
    },
    {
      path: 'Assets/Prefabs/Player.prefab',
      staged: null,
      unstaged: {
        status: 'M',
        diff: `${head('Assets/Prefabs/Player.prefab')}@@ -88,7 +88,7 @@ MonoBehaviour:
   m_Script: {fileID: 11500000, guid: 5f1c2a9e0b7d4c3a8e6f1b2c3d4e5f60, type: 3}
   moveSpeed: 4.5
-  carryCapacity: 12
+  carryCapacity: 16
   pickupRadius: 1.2
`,
      },
    },
    {
      path: 'Assets/Prefabs/Crate.prefab',
      staged: null,
      unstaged: {
        status: '?',
        diff: added('Assets/Prefabs/Crate.prefab', [
          '%YAML 1.1',
          '%TAG !u! tag:unity3d.com,2011:',
          '--- !u!1 &4410925571286573214',
          'GameObject:',
          '  m_Name: Crate',
          '  m_TagString: Pickup',
          '  m_Layer: 6',
        ]),
      },
    },
    {
      path: 'Assets/Prefabs/Crate.prefab.meta',
      staged: null,
      unstaged: { status: '?', diff: added('Assets/Prefabs/Crate.prefab.meta', ['fileFormatVersion: 2', `guid: ${hex(32)}`, 'PrefabImporter:', '  externalObjects: {}']) },
    },
    {
      path: 'Assets/Textures/crate_albedo.png',
      staged: null,
      unstaged: {
        status: '?',
        diff: 'diff --git a/Assets/Textures/crate_albedo.png b/Assets/Textures/crate_albedo.png\nnew file mode 100644\nBinary files /dev/null and b/Assets/Textures/crate_albedo.png differ\n',
      },
    },
  ]
  return {
    vcs: 'plastic',
    repository: 'fruit-stand@orchard-studio@cloud',
    isRepo: true,
    branch: '/main/feature/inventory',
    branches: {
      '/main': noTrack,
      '/main/feature/inventory': { ...noTrack },
      '/main/feature/weather': { ...noTrack },
      '/main/fix/crate-physics': { ...noTrack },
      '/main/release-1.2': { ...noTrack },
    },
    used: new Set(['/main', '/main/feature/inventory', '/main/feature/weather', '/main/fix/crate-physics', '/main/release-1.2']),
    files,
    log,
    shelves: [
      {
        id: 41, comment: 'Weather: rain particles, half done', owner: 'you@orchard.studio', time: Date.now() - 26 * 60 * MIN, branch: '/main/feature/weather',
        files: [{
          path: 'Assets/Scripts/Weather/RainEmitter.cs', staged: null,
          unstaged: { status: 'M', diff: `${head('Assets/Scripts/Weather/RainEmitter.cs')}@@ -12,6 +12,8 @@ public class RainEmitter : MonoBehaviour\n     [SerializeField] ParticleSystem drops;\n+    [SerializeField, Range(0, 1)] float intensity = 0.4f;\n+    [SerializeField] AnimationCurve windByHour;\n     void Update()\n     {\n` },
        }],
      },
      {
        id: 38, comment: 'Try a lighter crate mass', owner: 'you@orchard.studio', time: Date.now() - 4 * 24 * 60 * MIN, branch: '/main/fix/crate-physics',
        files: [{
          path: 'Assets/Prefabs/Barrel.prefab', staged: null,
          unstaged: { status: 'M', diff: `${head('Assets/Prefabs/Barrel.prefab')}@@ -40,7 +40,7 @@ Rigidbody:\n   m_ObjectHideFlags: 0\n-  m_Mass: 12\n+  m_Mass: 4.5\n   m_Drag: 0\n` },
        }],
      },
    ],
    // Changesets a teammate checked in on this branch since the workspace was updated.
    incoming: ['Inventory: tooltips show the stack total', 'Fix the crate falling through the barn floor'],
    renames: [],
    locks: [
      { path: 'Assets/Art/Barn.psd', owner: 'sam@orchard.studio', workspace: 'sam-art', branch: '/main/art-pass', status: 'retained', time: Date.now() - 26 * 60 * MIN, mine: false },
      { path: 'Assets/Prefabs/Player.prefab', owner: ME, workspace: 'fruit-stand', branch: '/main/feature/inventory', status: 'locked', time: Date.now() - 40 * MIN, mine: true },
      { path: 'Assets/Scenes/Farm.unity', owner: 'priya@orchard.studio', workspace: 'priya-desktop', branch: '/main/feature/weather', status: 'locked', time: Date.now() - 95 * MIN, mine: false },
      { path: 'Assets/Scenes/Market.unity', owner: 'priya@orchard.studio', workspace: 'priya-desktop', branch: '/main/feature/weather', status: 'locked', time: Date.now() - 3 * 60 * MIN, mine: false },
    ],
  }
}

/** Unity VCS: the signed-in user, and the files the server's lock rules cover. */
const ME = 'you@orchard.studio'
const LOCK_RULES = /\.(unity|prefab|psd|png|fbx|asset)$/i
const fileName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const heldBy = (l: VcsLock) => `${l.owner} (workspace ${l.workspace})`

/** Unity VCS: lock by checking out, as `vcs_lock` does. */
async function lockFiles(r: Repo, files: string[]): Promise<string> {
  if (!files.length) throw new Error('Pick the files to lock or unlock')
  await wait(400)
  const locks = r.locks ??= []
  for (const f of files) {
    const other = locks.find(l => l.path === f && !l.mine)
    if (other) throw new Error(`${fileName(f)} is locked by ${heldBy(other)}. Ask them to check it in or release the lock.`)
    const change = r.files.find(x => x.path === f)
    const code = change?.unstaged?.status ?? change?.staged?.status
    if (code === '?' || code === 'A') throw new Error(`cm checkout failed\n\nThe item ${f} is not under source control. Check it in first.`)
  }
  const skipped: string[] = []
  for (const f of files) {
    if (!LOCK_RULES.test(f)) { skipped.push(fileName(f)); continue }
    const at = locks.findIndex(l => l.path === f)
    const lock: VcsLock = { path: f, owner: ME, workspace: 'fruit-stand', branch: r.branch, status: 'locked', time: Date.now(), mine: true }
    if (at >= 0) locks[at] = lock
    else locks.push(lock)
  }
  locks.sort((a, b) => a.path.localeCompare(b.path))
  if (!skipped.length) return ''
  const rules = "An administrator sets them in the Unity Cloud dashboard (or the server's lock.conf)."
  return skipped.length === 1
    ? `Checked out ${skipped[0]}, but it isn't locked.\nThe server's lock rules don't cover this file. ${rules}`
    : `Checked out ${files.length} files, but ${skipped.length} of them aren't locked: ${skipped.join(', ')}.\nThe server's lock rules don't cover them. ${rules}`
}

async function unlockFiles(r: Repo, files: string[]) {
  if (!files.length) throw new Error('Pick the files to lock or unlock')
  await wait(300)
  const locks = r.locks ?? []
  for (const f of files) {
    const l = locks.find(x => x.path === f)
    if (!l) throw new Error(`${fileName(f)} isn't locked.`)
    if (!l.mine) throw new Error(`${fileName(f)} is locked by ${heldBy(l)}. Only they, or a server administrator, can release it.`)
  }
  r.locks = locks.filter(l => !files.includes(l.path))
}

/**
 * Unity VCS: what merging each branch into fruit-stand brings ([path, status]), and what clashes.
 * `/main/feature/weather` changed two files the workspace's branch changed too: Mango refuses it.
 */
const UNITY_MERGES: Record<string, { files: [string, 'M' | 'A' | 'D'][]; conflicts?: string[] }> = {
  '/main': {
    files: [
      ['Assets/Scripts/Save/SaveSystem.cs', 'M'],
      ['Assets/Scripts/Save/SaveV2.cs', 'A'],
      ['Assets/Scenes/Title.unity', 'M'],
      ['Packages/manifest.json', 'M'],
      ['ProjectSettings/ProjectVersion.txt', 'M'],
    ],
  },
  '/main/feature/weather': {
    files: [['Assets/Scripts/Weather/RainSystem.cs', 'A'], ['Assets/Scripts/Weather/RainSystem.cs.meta', 'A']],
    conflicts: ['Assets/Scenes/Farm.unity', 'Assets/Scripts/Inventory/InventoryGrid.cs'],
  },
  '/main/fix/crate-physics': {
    files: [['Assets/Scripts/Physics/CrateBody.cs', 'M'], ['Assets/Physics/Crate.physicMaterial', 'M']],
  },
}

function mergePreview(r: Repo, branch: string): MergePreview {
  const base = { branch, into: r.branch, files: [] as string[], conflicts: [] as string[], blocker: null as string | null }
  if (branch === r.branch) return { ...base, blocker: `The workspace is already on ${branch}. Switch to the branch to merge into first.` }
  const pending = r.files.filter(f => f.staged || (f.unstaged && f.unstaged.status !== '?')).length
  if (pending) {
    return { ...base, blocker: `The workspace has ${pending} file${pending === 1 ? '' : 's'} pending. Check in or undo them first, so the merge result is all that's left to check in.` }
  }
  if (r.incoming.length) {
    const n = r.incoming.length
    return { ...base, blocker: `${r.branch} has ${n} changeset${n === 1 ? '' : 's'} your workspace doesn't have yet. Update first, then merge.` }
  }
  const m = r.merged?.has(branch) ? undefined : UNITY_MERGES[branch]
  if (!m) return base
  const conflicts = m.conflicts ?? []
  return { ...base, files: m.files.map(f => f[0]).filter(p => !conflicts.includes(p)), conflicts }
}

async function plasticMerge(r: Repo, branch: string): Promise<string> {
  await wait(700)
  const p = mergePreview(r, branch)
  if (p.blocker) throw new Error(p.blocker)
  if (p.conflicts.length) {
    const n = p.conflicts.length
    throw new Error(`${n} file${n === 1 ? '' : 's'} changed on both branches need resolving by hand, so Mango didn't merge ${branch}. Merge it in the Unity Version Control app, which resolves conflicts, then check in from here.\n\n${p.conflicts.join('\n')}`)
  }
  if (!p.files.length) return `Nothing to merge: ${r.branch} already has everything from ${branch}.`
  for (const [path, status] of UNITY_MERGES[branch]!.files) {
    const diff = status === 'A'
      ? added(path, ['// Merged from ' + branch, 'public class ' + (baseName(path).split('.')[0] || 'Merged') + ' { }'])
      : `${head(path)}@@ -1,3 +1,3 @@\n // ${baseName(path)}\n-// before the merge\n+// merged from ${branch}\n \n`
    r.files.push({ path, staged: { status, diff }, unstaged: null })
  }
  ;(r.merged ??= new Set()).add(branch)
  const n = p.files.length
  return `Merged ${branch}: ${n} file${n === 1 ? '' : 's'} changed, check in to finish.\nThe merge into ${r.branch} is pending changes until you check it in.`
}

const UNITY_ONLY = (what: string) => new Error(`${what} isn't part of Unity Version Control. Checkins go straight to the server.`)

/** Unity VCS: add a branch and switch to it. */
function createBranch(r: Repo, full: string, switchTo: boolean) {
  if (r.branches[full]) throw new Error(`A branch named ${full} already exists.`)
  r.branches[full] = { upstream: null, ahead: 0, behind: 0 }
  if (switchTo) r.branch = full
}

/** Unity VCS: a typed name is a child of `parent` unless it starts at the root. */
function childBranch(name: string, parent: string): string {
  const n = name.trim()
  if (!n) throw new Error('Enter a branch name')
  if (/[\s"'@#:;*?<>|\\$`]|\.\.|\/\/|^-|\/$/.test(n)) throw new Error(`"${n}" is not a valid branch name`)
  return n.startsWith('/') ? n : `${parent.replace(/\/+$/, '')}/${n}`
}

/* ---------- Unity VCS shelves ---------- */

let nextShelve = 42
const listShelves = (r: Repo): VcsShelve[] =>
  (r.shelves ?? []).map(({ files: _files, ...s }) => s).sort((a, b) => b.time - a.time)

/** Shelve what a checkin would take (the staged files, or all); private files can't be shelved. */
async function shelve(r: Repo, comment: string, undo: boolean): Promise<string> {
  if (!comment.trim()) throw new Error('Write a comment for the shelve first')
  const chosen = r.files.some(f => f.staged) ? r.files.filter(f => f.staged) : r.files
  // A staged new file is only picked for the checkin: to Unity VCS it is still private.
  const isPrivate = (f: MockFile) => (f.unstaged ?? f.staged)?.status === '?' || (!f.unstaged && f.staged?.status === 'A')
  const take = chosen.filter(f => !isPrivate(f))
  const privates = chosen.length - take.length
  if (!take.length) {
    throw new Error(privates
      ? "Only new files are pending, and Unity VCS can't shelve a file until it is under version control. Check them in, or add them with cm add first."
      : 'There are no changes to shelve.')
  }
  await wait(700)
  const id = nextShelve++
  // As pending changes again: Unity VCS has no staging area to restore.
  const files = take.map(f => {
    const c = (f.unstaged ?? f.staged)!
    return { path: f.path, staged: null, unstaged: { ...c } }
  })
  ;(r.shelves ??= []).push({ id, comment: comment.trim(), owner: 'you@orchard.studio', time: Date.now(), branch: r.branch, files })
  if (undo) r.files = r.files.filter(f => !take.includes(f))
  const n = take.length
  return `Shelved ${n} change${n === 1 ? '' : 's'} as sh:${id}${undo ? ' and undid them in the workspace' : ''}.`
    + (privates ? `\n${privates} new file${privates === 1 ? '' : 's'} not under version control stay${privates === 1 ? 's' : ''} in the workspace.` : '')
}

async function applyShelve(r: Repo, id: number): Promise<string> {
  const s = r.shelves?.find(x => x.id === id)
  if (!s) throw new Error(`The shelve sh:${id} does not exist.`)
  const clash = s.files.find(f => r.files.some(p => p.path === f.path))
  if (clash) throw new Error(`Shelve sh:${id} conflicts with changes in the workspace. Check in or undo those files, then apply it again.\n\n${clash.path} has pending changes.`)
  await wait(600)
  r.files.push(...s.files.map(f => ({ ...f, unstaged: f.unstaged && { ...f.unstaged } })))
  return `Applied sh:${id} to the workspace. Its changes are pending again; the shelve stays on the server.`
}

const repos = new Map<string, Repo>()
/** Linked worktrees made with `git_worktree_add`: folder → the main working tree's folder. */
const linkedTrees = new Map<string, string>()
/** The `mango` project comes with one linked worktree, a few commits ahead of main (start a chat in it from the sidebar's "Continue in" list). */
const SEEDED = { leaf: 'fix-diff-wrap', branch: 'fix/diff-wrap' }
const seededMain = (path: string) => {
  const m = new RegExp(`^(.*)\\.worktrees/${SEEDED.leaf}$`).exec(path)
  return m && baseName(m[1]!) === 'mango' ? m[1]! : null
}
function seedWorktree(main: string, mainRepo: Repo) {
  const folder = `${main.replace(/\/+$/, '')}.worktrees/${SEEDED.leaf}`
  mainRepo.branches[SEEDED.branch] = { upstream: null, ahead: 0, behind: 0 }
  const work = [
    commitOf('Wrap long lines in the diff view', 12 * MIN),
    commitOf('Keep the gutter fixed while a wrapped diff scrolls', 54 * MIN),
    commitOf('Diff: soft-wrap setting in Appearance', 2 * 60 * MIN),
  ]
  repos.set(folder, { ...cleanRepo(), branch: SEEDED.branch, branches: mainRepo.branches, log: [...work, ...mainRepo.log], incoming: [] })
  linkedTrees.set(folder, main)
}
function repoAt(path: string): Repo {
  let repo = repos.get(path)
  if (!repo) {
    // The seeded worktree, asked for before its project: the project brings it.
    const main = seededMain(path)
    if (main && !repos.has(main)) {
      repoAt(main)
      if (repos.has(path)) return repos.get(path)!
    }
    const name = baseName(path)
    repo = name === 'notes' ? emptyRepo() : name === 'pulp-ui' ? cleanRepo() : name === 'orchard-api' ? sideRepo('feat/rate-limits') : name === 'fruit-stand' ? unityRepo() : mangoRepo()
    repos.set(path, repo)
    if (name === 'mango' && !linkedTrees.has(path)) seedWorktree(path, repo)
  }
  return repo
}

/** Commits in `r` that `base` doesn't have (the mock keeps one shared history of commit objects). */
const notIn = (r: Repo, base: Repo) => r.log.filter(c => !base.log.some(b => b.hash === c.hash))

/* ---------- operations ---------- */

const tracking = (r: Repo): Tracking => r.branches[r.branch] ?? { upstream: null, ahead: 0, behind: 0 }

function statusOf(r: Repo, path: string): GitStatus {
  if (!r.isRepo) return { vcs: 'git', repository: null, isRepo: false, root: null, mainRoot: null, branch: null, head: null, upstream: null, ahead: 0, behind: 0, files: [] }
  const t = tracking(r)
  const files: GitFile[] = r.files
    .map(f => ({ path: f.path, origPath: f.staged?.origPath ?? f.unstaged?.origPath ?? null, index: f.staged?.status ?? null, worktree: f.unstaged?.status ?? null, conflicted: false }))
    .sort((a, b) => Number(a.worktree === '?') - Number(b.worktree === '?') || a.path.localeCompare(b.path))
  if (r.vcs === 'plastic') {
    // A changeset number for HEAD; "behind" is newer changesets on the branch, known without a fetch.
    const head = r.log[0]?.shortHash.replace(/^cs:/, '') ?? null
    return { vcs: 'plastic', repository: r.repository, isRepo: true, root: path, mainRoot: null, branch: r.branch, head, upstream: null, ahead: 0, behind: r.incoming.length, files }
  }
  return { vcs: 'git', repository: null, isRepo: true, root: path, mainRoot: linkedTrees.get(path) ?? null, branch: r.branch, head: r.log[0]?.shortHash ?? null, upstream: t.upstream, ahead: t.ahead, behind: t.behind, files }
}

const wanted = (files: string[]) => (f: MockFile) => files.length === 0 || files.includes(f.path)
const prune = (r: Repo) => { r.files = r.files.filter(f => f.staged || f.unstaged) }

function stage(r: Repo, files: string[]) {
  for (const f of r.files.filter(wanted(files))) {
    if (!f.unstaged) continue
    const u = f.unstaged
    if (!f.staged) f.staged = { status: u.status === '?' ? 'A' : u.status, diff: u.diff, origPath: u.origPath }
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
    if (r.vcs === 'plastic') {
      // No index to restore from: the change just goes back to being unpicked.
      f.unstaged = { status: s.status === 'A' ? '?' : s.status, diff: s.diff, origPath: s.origPath }
    } else if (s.status === 'R' && s.origPath) {
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
  // Unity VCS: undoing a checkout releases the lock it took.
  if (r.locks) r.locks = r.locks.filter(l => !(l.mine && l.status === 'locked' && !r.files.some(f => f.path === l.path)))
}

function checkin(r: Repo, message: string, amend: boolean): string {
  const subject = message.trim().split('\n')[0] ?? ''
  if (amend) throw UNITY_ONLY('Amending a changeset')
  if (!subject) throw new Error('Write a checkin comment first')
  if (!r.files.some(f => f.staged)) throw new Error('Nothing is staged. Stage the changes you want in this checkin first.')
  if (r.incoming.length) {
    throw new Error(`The branch has changesets your workspace doesn't have yet. Update the workspace, then check in again.\n\nMERGE_NEEDED A merge is needed from changeset 'cs:${nextChangeset + r.incoming.length - 1}' to changeset '${r.log[0]?.shortHash}' in order to checkin.`)
  }
  const taken = r.files.filter(f => f.staged).map(f => f.path)
  const blocked = r.locks?.find(l => !l.mine && taken.includes(l.path))
  if (blocked) throw new Error(`The checkin was refused.\n\nThe item ${blocked.path} is locked by ${heldBy(blocked)}.`)
  if (r.locks) {
    r.locks = r.branch === '/main'
      ? r.locks.filter(l => !(l.mine && taken.includes(l.path)))
      : r.locks.map(l => (l.mine && taken.includes(l.path) ? { ...l, status: 'retained' as const } : l))
  }
  for (const f of r.files) f.staged = null
  prune(r)
  r.used?.add(r.branch)
  r.log.unshift(changesetOf(subject, 0))
  return r.log[0]!.shortHash
}

async function update(r: Repo): Promise<string> {
  await wait(900)
  if (!r.incoming.length) return ''
  const arrived = r.incoming.map((subject, i) => changesetOf(subject, (r.incoming.length - i) * 31 * MIN, 'priya@orchard.studio')).reverse()
  r.log.unshift(...arrived)
  r.incoming = []
  return `Updated. Downloaded ${arrived.length + 3} files.`
}

function commit(r: Repo, message: string, amend: boolean): string {
  if (r.vcs === 'plastic') return checkin(r, message, amend)
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

/* Results read like the backend's summaries (git.rs `describe_*`): a headline, then detail lines. */
const commits = (n: number) => `${n} commit${n === 1 ? '' : 's'}`

async function fetch(r: Repo): Promise<string> {
  await wait(650)
  const t = tracking(r)
  const fresh = !!t.upstream && r.incoming.length > 0 && t.behind === 0
  if (fresh) t.behind = r.incoming.length
  const title = fresh ? 'Fetched: 1 branch updated.' : 'Fetched. Nothing new on the remote.'
  return t.upstream && t.behind > 0 ? `${title}\n${r.branch} is ${commits(t.behind)} behind ${t.upstream}. Update to bring them in.` : title
}

async function pull(r: Repo): Promise<string> {
  const t = tracking(r)
  if (!t.upstream) throw new Error(`${r.branch} isn't tracking a remote branch yet. Publish it first, then pull.`)
  await fetch(r)
  if (t.behind === 0) return `${r.branch} is already up to date with ${t.upstream}.`
  const arrived = r.incoming.map((subject, i) => commitOf(subject, (i + 1) * 47 * MIN, 'Priya N.'))
  r.log.splice(t.ahead, 0, ...arrived)
  r.incoming = []
  t.behind = 0
  return `Pulled ${commits(arrived.length)} into ${r.branch}.\n2 files changed, +7 −4`
}

async function push(r: Repo, path: string): Promise<string> {
  await wait(700)
  const t = r.branches[r.branch] ??= { upstream: null, ahead: 0, behind: 0 }
  const url = `${REMOTE}/${baseName(path)}.git`
  if (!r.log.length) throw new Error('There are no commits to push yet.')
  if (!t.upstream) {
    t.upstream = `origin/${r.branch}`
    t.ahead = 0
    return `Published ${r.branch} to ${t.upstream}.\n${r.branch} now tracks it, so Update and Push work from here.`
  }
  if (t.behind > 0) {
    throw new Error(`The remote has commits you don't have yet. Pull, then push again.\n\nTo ${url}\n ! [rejected]        ${r.branch} -> ${r.branch} (fetch first)\nerror: failed to push some refs to '${url}'`)
  }
  if (t.ahead === 0) return `Nothing to push. ${t.upstream} already has every commit.`
  const n = t.ahead
  t.ahead = 0
  return `Pushed ${commits(n)} to ${t.upstream}.`
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

/* ---------- worktrees ---------- */

function worktreeList(path: string): GitWorktree[] {
  const main = linkedTrees.get(path) ?? path
  const entry = (at: string, isMain: boolean): GitWorktree => {
    const r = repoAt(at)
    return { path: at, branch: r.branch, head: r.log[0]?.shortHash ?? null, isMain, isCurrent: at === path, locked: false, prunable: false }
  }
  return [entry(main, true), ...[...linkedTrees].filter(([, m]) => m === main).map(([at]) => entry(at, false))]
}

async function worktreeAdd(path: string, branch: string, from: string | null, create: boolean): Promise<GitWorktree> {
  await wait(350)
  const main = linkedTrees.get(path) ?? path
  const mainRepo = repoAt(main)
  const name = branch.trim()
  if (!name || /\s|\.\.|[~^:?*[\\]/.test(name)) throw new Error(`"${name}" is not a valid branch name`)
  const list = worktreeList(main)
  if (list.some(w => w.branch === name)) throw new Error(`fatal: '${name}' is already checked out at '${list.find(w => w.branch === name)!.path}'`)
  if (create && mainRepo.branches[name]) throw new Error(`A branch named ${name} already exists`)
  if (!create && !mainRepo.branches[name]) throw new Error(`fatal: invalid reference: ${name}`)
  const sep = main.includes('\\') && !main.includes('/') ? '\\' : '/'
  const cut = main.replace(/[\\/]+$/, '').lastIndexOf(sep)
  const folder = `${main.slice(0, cut + 1)}${baseName(main)}.worktrees${sep}${name.replace(/\//g, '-')}`
  if (repos.has(folder)) throw new Error(`${folder} already exists; pick another branch name`)
  // The mock has one history: a new branch starts where the project's does, whatever `from` says.
  void from
  if (create) mainRepo.branches[name] = { upstream: null, ahead: 0, behind: 0 }
  repos.set(folder, { ...cleanRepo(), branch: name, branches: mainRepo.branches, log: [...mainRepo.log], incoming: [] })
  linkedTrees.set(folder, main)
  return worktreeList(folder).find(w => w.path === folder)!
}

async function worktreeRemove(path: string, folder: string, force: boolean) {
  await wait(250)
  const main = linkedTrees.get(path) ?? path
  if (folder === main) throw new Error('That is the main working tree; it cannot be removed')
  if (linkedTrees.get(folder) !== main) throw new Error(`${folder} is not a worktree of this repository`)
  const r = repoAt(folder)
  if (r.files.length && !force) throw new Error(`${r.branch} has uncommitted changes; commit or discard them first`)
  repos.delete(folder)
  linkedTrees.delete(folder)
}

export async function mockGit(cmd: string, args: any): Promise<any> {
  const path = String(args?.path ?? '')
  const r = repoAt(path)
  if (cmd === 'git_worktrees') return r.isRepo && r.vcs === 'git' ? worktreeList(path) : []
  if (cmd === 'git_worktree_add') {
    if (r.vcs === 'plastic') throw new Error('Worktrees are a git feature; Unity Version Control workspaces have none')
    return worktreeAdd(path, String(args.branch ?? ''), args.from ?? null, args.create !== false)
  }
  if (cmd === 'git_worktree_remove') return worktreeRemove(path, String(args.worktree ?? ''), !!args.force)
  if (cmd === 'git_status') return statusOf(r, path)
  if (cmd.startsWith('vcs_')) {
    if (cmd === 'vcs_locks') {
      if (r.vcs !== 'plastic') return []
      await wait(150)
      return (r.locks ?? []).map(l => ({ ...l }))
    }
    if (r.vcs !== 'plastic') throw new Error('Locks are a Unity Version Control feature; git has no file locks.')
    if (cmd === 'vcs_lock') return lockFiles(r, args.files ?? [])
    if (cmd === 'vcs_unlock') return unlockFiles(r, args.files ?? [])
  }
  if (cmd === 'git_ahead') {
    if (!r.isRepo) throw new Error(`${path} is not inside a git repository`)
    if (r.vcs === 'plastic') throw new Error("Worktrees are a git feature; Unity Version Control workspaces don't have them.")
    await wait(120)
    const mainRepo = repoAt(linkedTrees.get(path) ?? path)
    const base = args.base ? String(args.base) : mainRepo.branch
    const other = worktreeList(path).map(w => repoAt(w.path)).find(x => x.branch === base) ?? mainRepo
    return { base, ahead: notIn(r, other).length }
  }
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
  if (cmd.startsWith('vcs_shelve')) {
    if (r.vcs !== 'plastic') throw new Error('Shelves are a Unity Version Control feature. In a git repository, use git stash in a terminal.')
    switch (cmd) {
      case 'vcs_shelves': await wait(250); return listShelves(r)
      case 'vcs_shelve': return shelve(r, String(args.comment ?? ''), !!args.undo)
      case 'vcs_shelve_apply': return applyShelve(r, Number(args.id))
      case 'vcs_shelve_delete': r.shelves = r.shelves?.filter(x => x.id !== Number(args.id)); return
    }
  }
  if (r.vcs === 'plastic') {
    switch (cmd) {
      case 'git_fetch': throw UNITY_ONLY('Fetch')
      case 'git_push': throw UNITY_ONLY('Push')
      case 'git_pull': return update(r)
      case 'git_merge': return plasticMerge(r, String(args.branch ?? ''))
      case 'git_merge_preview': await wait(450); return mergePreview(r, String(args.branch ?? ''))
      case 'git_rebase': throw UNITY_ONLY('Rebase')
      case 'git_checkout_remote': throw UNITY_ONLY('Remote branches')
      case 'git_checkout':
        if (args.create) return createBranch(r, childBranch(String(args.branch ?? ''), r.branch), true)
        await wait(500)
        return checkout(r, String(args.branch ?? ''), false)
      case 'git_branch_create':
        return createBranch(r, childBranch(String(args.name ?? ''), args.from || r.branch), !!args.checkout)
      case 'git_branch_list': {
        const now = Date.now()
        return {
          current: r.branch,
          local: Object.keys(r.branches).map((name, i) => ({
            name, isCurrent: name === r.branch, upstream: null, upstreamGone: false, ahead: 0, behind: 0,
            time: name === r.branch ? (r.log[0]?.time ?? now) : now - (i + 2) * 7_200_000,
            subject: name === r.branch ? (r.log[0]?.subject ?? '') : r.log[i + 1]?.subject ?? '',
          })).sort((a, b) => b.time - a.time),
          remote: [],
          remotes: [],
        }
      }
      case 'git_branch_rename': {
        const from = String(args.from)
        const to = String(args.to).includes('/') ? childBranch(String(args.to), '') : childBranch(String(args.to), from.slice(0, from.lastIndexOf('/')))
        if (to.slice(0, to.lastIndexOf('/')) !== from.slice(0, from.lastIndexOf('/'))) throw new Error(`Unity VCS renames a branch in place. Keep it under ${from.slice(0, from.lastIndexOf('/')) || 'the top level'}.`)
        if (r.branches[to]) throw new Error(`A branch named ${to} already exists.`)
        r.branches[to] = r.branches[from]!; delete r.branches[from]
        if (r.used?.delete(from)) r.used.add(to)
        if (r.branch === from) r.branch = to
        return
      }
      case 'git_branch_delete': {
        const name = String(args.branch)
        if (name === r.branch) throw new Error(`The workspace is on ${name}. Switch to another branch before deleting it.`)
        if (Object.keys(r.branches).some(b => b.startsWith(`${name}/`))) throw new Error("Can't remove this branch because it has child branches.")
        if (r.used?.has(name)) throw new Error("Can't remove this branch because it has changesets.")
        delete r.branches[name]
        return
      }
    }
  }
  switch (cmd) {
    case 'git_diff': {
      const f = r.files.find(x => x.path === args.file)
      return (args.staged ? f?.staged?.diff : f?.unstaged?.diff) ?? ''
    }
    case 'git_stage': return stage(r, args.files ?? [])
    case 'git_unstage': return unstage(r, args.files ?? [])
    case 'git_discard': return discard(r, args.files ?? [])
    case 'git_commit': return commit(r, String(args.message ?? ''), !!args.amend)
    case 'git_fetch': return fetch(r)
    case 'git_pull': return pull(r)
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
    case 'git_merge': {
      const branch = String(args.branch)
      // A branch checked out in another worktree of this repository: its commits really arrive.
      const from = worktreeList(path).map(w => repoAt(w.path)).find(x => x !== r && x.branch === branch)
      if (!from) return `Merged 2 commits from ${branch} into ${r.branch}.\n4 files changed, +38 −11`
      await wait(600)
      const fresh = notIn(from, r)
      if (!fresh.length) return `${r.branch} already has every commit from ${branch}.`
      r.log.unshift(...fresh)
      const t = tracking(r)
      if (t.upstream) t.ahead += fresh.length
      return `Merged ${commits(fresh.length)} from ${branch} into ${r.branch}.\n${fresh.length + 2} files changed, +${fresh.length * 17} −${fresh.length * 4}`
    }
    case 'git_merge_preview': throw new Error('Merge previews are for Unity VCS workspaces.')
    case 'git_rebase': return `Rebased ${r.branch} onto ${String(args.onto)}.\nPicked up 2 commits from ${String(args.onto)}.`
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
