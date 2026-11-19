import type { AgentId, Thread } from '~/types/chat'
import type { SpawnFn } from '~/agents/types'
import { MOCK_GITHUB, mockChats } from './mockChats'
import { ghFailure, ghItemArgv } from './github'
import { envPath } from '~/utils/envPath'
import { simulatedSpawn } from '@/agents/simulated'
import { toShared } from './chatSyncCore'
import { checkedPicturePath } from './images'
import { MOCK_SHOT_PATH, MOCK_SHOT_PNG } from './mockPictures'
import { parseProjectPath } from './sshBackend'
import { validInstance, validInstanceDir } from './shell'
import { safeRef, worktreeFolder } from './git'
import type {
  Env, EnvRemote, GitChange, GitState, GitWorktree, Instance, RemoteBackend, RemoteChatEntry, RemoteProject, RemotePut,
} from './types'

/**
 * An in-memory `RemoteBackend` for the web preview and a simulator without a server: two
 * environments' worth of instances and projects, chats kept "in the environment" with the same
 * revision rules as the real scripts, a small git repository per project, and agent runs from
 * the simulation (their replies are labelled "Simulated"). Answers come after a short delay,
 * so loading states show.
 */

const wait = (min = 120, max = 380) => new Promise<void>(r => setTimeout(r, min + Math.random() * (max - min)))

/** A well-formed `ssh-ed25519` host key blob (its 32 bytes are made up). */
const FAKE_HOST_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIAUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUF'

/** The environments the preview starts with (the envs store seeds itself with these). */
export const MOCK_ENVS: Env[] = [
  {
    id: 'mock-forge',
    name: 'forge',
    endpoint: { host: 'forge.example.net', port: 22, user: 'ops', keyId: 'mock-forge', hostKey: FAKE_HOST_KEY },
    server: { incusRemote: null },
    addedAt: Date.UTC(2026, 9, 2),
  },
  {
    id: 'mock-shared',
    name: 'shop (shared)',
    endpoint: { host: '203.0.113.24', port: 22001, user: 'agent', keyId: 'mock-shared', hostKey: FAKE_HOST_KEY },
    joined: { instance: 'shop', sharedFrom: 'ana/shop', shareId: 'mock-share', expiresAt: null },
    addedAt: Date.UTC(2026, 10, 9),
  },
]

const INSTANCES: Record<string, Instance[]> = {
  'mock-forge': [
    { name: 'dev', state: 'running', kind: 'container' },
    { name: 'sandbox', state: 'running', kind: 'container' },
    { name: 'build-vm', state: 'stopped', kind: 'virtual-machine' },
  ],
  'mock-shared': [{ name: 'shop', state: 'running', kind: null }],
}

/** Project folders per `<envId>/<instance>`, with their branch. */
const PROJECTS: Record<string, [dir: string, branch: string | null][]> = {
  'mock-forge/dev': [['/home/agent/work/mango', 'main'], ['/home/agent/work/shop-api', 'feat/orders']],
  'mock-forge/sandbox': [['/home/agent/work/scratch', 'main']],
  'mock-shared/shop': [['/home/agent/work/shop', 'main'], ['/home/agent/work/shop-admin', null]],
}

/* ---------- git ---------- */

interface MockRepo {
  branch: string | null
  ahead: number
  behind: number
  upstream: boolean
  changes: GitChange[]
  diffs: Record<string, string>
}

const SAMPLE_CHANGES: GitChange[] = [
  { path: 'src/orders/checkout.ts', kind: 'modified', staged: false, additions: 14, deletions: 3 },
  { path: 'src/orders/refunds.ts', kind: 'added', staged: true, additions: 22, deletions: 0 },
  { path: 'src/legacy/cart.ts', kind: 'deleted', staged: false, additions: 0, deletions: 9 },
  { path: 'docs/orders.md', kind: 'renamed', from: 'docs/checkout.md', staged: true, additions: 2, deletions: 1 },
  { path: 'notes/todo.txt', kind: 'untracked', staged: false, additions: null, deletions: null },
]

const SAMPLE_DIFFS: Record<string, string> = {
  'src/orders/checkout.ts': `diff --git a/src/orders/checkout.ts b/src/orders/checkout.ts
index 3f1c2a9..8b0e4d1 100644
--- a/src/orders/checkout.ts
+++ b/src/orders/checkout.ts
@@ -12,9 +12,20 @@ export async function checkout(cart: Cart, customer: Customer) {
   const total = priceOf(cart)
-  if (total <= 0) throw new Error('Empty cart')
-  const payment = await charge(customer, total)
-  return createOrder(cart, payment)
+  if (total <= 0) throw new CheckoutError('empty-cart')
+  const reserved = await reserveStock(cart)
+  try {
+    const payment = await charge(customer, total, { idempotencyKey: cart.id })
+    return await createOrder(cart, payment)
+  } catch (err) {
+    await releaseStock(reserved)
+    throw err
+  }
 }
+
+export class CheckoutError extends Error {
+  constructor(readonly reason: 'empty-cart' | 'out-of-stock') { super(reason) }
+}
`,
  'src/orders/refunds.ts': `diff --git a/src/orders/refunds.ts b/src/orders/refunds.ts
new file mode 100644
index 0000000..5c7d1e2
--- /dev/null
+++ b/src/orders/refunds.ts
@@ -0,0 +1,22 @@
+import { db } from '../db'
+import type { Order } from './types'
+
+/** Refund an order in full, once. */
+export async function refund(order: Order) {
+  if (order.refundedAt) return order
+  const payment = await db.payments.get(order.paymentId)
+  await payment.provider.refund(payment.id, payment.amount)
+  return db.orders.update(order.id, { refundedAt: Date.now() })
+}
`,
  'src/legacy/cart.ts': `diff --git a/src/legacy/cart.ts b/src/legacy/cart.ts
deleted file mode 100644
index 9a2b3c4..0000000
--- a/src/legacy/cart.ts
+++ /dev/null
@@ -1,9 +0,0 @@
-// Old cart, kept for the v1 API.
-export function legacyTotal(items: { price: number; qty: number }[]) {
-  let total = 0
-  for (const i of items) {
-    total += i.price * i.qty
-  }
-  return total
-}
-
`,
  'docs/orders.md': `diff --git a/docs/checkout.md b/docs/orders.md
similarity index 80%
rename from docs/checkout.md
rename to docs/orders.md
index 1111111..2222222 100644
--- a/docs/checkout.md
+++ b/docs/orders.md
@@ -1,4 +1,5 @@
-# Checkout
+# Orders

 Checkout reserves stock before charging, and releases it if the charge fails.
+Refunds are full and happen once per order.
`,
  'notes/todo.txt': `diff --git a/notes/todo.txt b/notes/todo.txt
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/notes/todo.txt
@@ -0,0 +1,3 @@
+- partial refunds
+- email receipt after refund
+- admin view for failed charges
`,
}

/* ---------- the backend ---------- */

export function createMockBackend(): RemoteBackend {
  let lookup: (hostId: string) => Env | null = id => MOCK_ENVS.find(e => e.id === id) ?? null
  const repos = new Map<string, MockRepo>()
  /** Linked worktrees added here, per repository key (`<envId>/<instance><dir>`): folder and branch. */
  const worktrees = new Map<string, { dir: string; branch: string }[]>()
  /** Chats "in the environment", per `<hostId>/<instance>`: revision and shared JSON, or a tombstone. */
  const kept = new Map<string, Map<string, { rev: number; json: string } | { rev: null }>>()

  const envOf = (hostId: string) => {
    const env = lookup(hostId)
    if (!env) throw new Error("That environment is no longer in Mango's list. Add it again.")
    return env
  }

  const instancesOf = (env: Env): Instance[] =>
    INSTANCES[env.id] ?? (env.joined ? [{ name: env.joined.instance, state: 'running', kind: null }] : [{ name: 'dev', state: 'running', kind: 'container' }])

  const projectsOf = (env: Env, instance: string): [string, string | null][] =>
    PROJECTS[`${env.id}/${instance}`] ?? [[`/home/agent/work/${instance}`, 'main']]

  function running(env: Env, instance: string) {
    const inst = instancesOf(env).find(i => i.name === instance)
    if (!inst) throw new Error(`There is no environment named ${instance} on ${env.name}.`)
    if (inst.state !== 'running') throw new Error(`The environment ${instance} is not running. Start it on the computer that owns it, then try again.`)
  }

  function repoOf(projectPath: string): MockRepo | null {
    const loc = parseProjectPath(projectPath)
    const env = envOf(loc.hostId)
    running(env, loc.instance)
    // A linked worktree is a clean checkout of its own branch.
    for (const [key, list] of worktrees) {
      if (!key.startsWith(`${env.id}/${loc.instance}/`)) continue
      const wt = list.find(w => loc.dir === w.dir || loc.dir.startsWith(`${w.dir}/`))
      if (!wt) continue
      const k = `${env.id}/${loc.instance}${wt.dir}`
      let repo = repos.get(k)
      if (!repo) repos.set(k, repo = { branch: wt.branch, ahead: 0, behind: 0, upstream: false, changes: [], diffs: {} })
      return repo
    }
    const project = projectsOf(env, loc.instance).find(([dir]) => loc.dir === dir || loc.dir.startsWith(`${dir}/`))
    if (!project) return null
    const key = `${env.id}/${loc.instance}${project[0]}`
    let repo = repos.get(key)
    if (!repo) {
      // The first project of each instance has work in progress; the others are clean.
      const busy = projectsOf(env, loc.instance)[0]?.[0] === project[0]
      repo = {
        branch: project[1],
        ahead: busy ? 2 : 0,
        behind: 0,
        upstream: project[1] !== null,
        changes: busy ? SAMPLE_CHANGES.map(c => ({ ...c })) : [],
        diffs: busy ? { ...SAMPLE_DIFFS } : {},
      }
      repos.set(key, repo)
    }
    return repo
  }

  /** The main working tree of the repository `projectPath` is in (a worktree's too); throws outside one. */
  function mainOf(projectPath: string) {
    const loc = parseProjectPath(projectPath)
    const env = envOf(loc.hostId)
    running(env, loc.instance)
    const inside = (root: string) => loc.dir === root || loc.dir.startsWith(`${root}/`)
    for (const [key, list] of worktrees) {
      if (key.startsWith(`${env.id}/${loc.instance}/`) && list.some(w => inside(w.dir))) {
        return { key, loc, dir: key.slice(`${env.id}/${loc.instance}`.length) }
      }
    }
    const project = projectsOf(env, loc.instance).find(([dir]) => inside(dir))
    if (!project) throw new Error(`${loc.dir} in ${loc.instance} is not inside a git repository`)
    return { key: `${env.id}/${loc.instance}${project[0]}`, loc, dir: project[0] }
  }

  /** The chats kept in an instance, seeded on first use with a few chats about each of its projects. */
  function store(at: EnvRemote) {
    const key = `${at.hostId}/${at.instance}`
    let m = kept.get(key)
    if (!m) {
      m = new Map()
      const env = lookup(at.hostId)
      if (env && INSTANCES[at.hostId]) {
        for (const [dir] of projectsOf(env, at.instance)) {
          const projectPath = envPath({ hostId: at.hostId, instance: at.instance, dir })
          // Stable ids: the preview reseeds on every page load, and the phone keeps what it saw before.
          const prefix = `demo-${at.hostId}-${at.instance}-${dir.split('/').pop()}`
          for (const t of mockChats(projectPath, dir, prefix)) m.set(t.id, { rev: t.updatedAt, json: toShared(JSON.stringify(t), at) })
        }
      }
      kept.set(key, m)
    }
    return m
  }

  const backend: RemoteBackend = {
    real: false,

    setEnvLookup(fn) {
      lookup = id => fn(id) ?? MOCK_ENVS.find(e => e.id === id) ?? null
    },

    async check(env) {
      await wait()
      if (env.joined?.expiresAt != null && env.joined.expiresAt <= Date.now()) {
        throw new Error(`Your access to ${env.name} ended. Ask whoever shared it (${env.joined.sharedFrom}) for a new link.`)
      }
    },

    async instances(env) {
      await wait()
      return instancesOf(env).map(i => ({ ...i }))
    },

    async projects(env, instance): Promise<RemoteProject[]> {
      await wait()
      validInstance(instance)
      running(env, instance)
      return projectsOf(env, instance).map(([dir, branch]) => ({
        path: envPath({ hostId: env.id, instance, dir }),
        name: dir.split('/').pop() ?? dir,
        branch: repos.get(`${env.id}/${instance}${dir}`)?.branch ?? branch,
      }))
    },

    async agentsInstalled(env, instance): Promise<AgentId[]> {
      await wait(60, 160)
      running(env, instance)
      return ['claude', 'codex']
    },

    async chatsList(at): Promise<RemoteChatEntry[]> {
      await wait(80, 200)
      return [...store(at)].map(([id, c]) => ({ id, rev: c.rev }))
    },

    async chatsFetch(at, ids) {
      await wait(80, 200)
      const m = store(at)
      return ids.flatMap((id) => {
        const c = m.get(id)
        return c && c.rev !== null ? [(c as { json: string }).json] : []
      })
    },

    async chatsPut(at, id, base, rev, data): Promise<RemotePut> {
      await wait(60, 160)
      if (base < 0 || rev <= base) throw new Error("A chat's revision must be newer than the one it replaces.")
      const m = store(at)
      const have = m.get(id)
      if (have && have.rev === null) return 'gone'
      if (have && have.rev > base) return 'stale'
      m.set(id, { rev, json: data })
      return 'ok'
    },

    async attachmentPut(at, id, name) {
      await wait(200, 600)
      return `/home/agent/.local/share/mango/attachments/${id}/${name}`
    },

    async chatsRemove(at, ids) {
      await wait(60, 160)
      const m = store(at)
      for (const id of ids) m.set(id, { rev: null })
    },

    async gitState(projectPath): Promise<GitState> {
      await wait()
      const repo = repoOf(projectPath)
      if (!repo) return { repo: false, branch: null, ahead: 0, behind: 0, upstream: false, changes: [] }
      return { repo: true, branch: repo.branch, ahead: repo.ahead, behind: repo.behind, upstream: repo.upstream, changes: repo.changes.map(c => ({ ...c })) }
    },

    async gitDiff(projectPath, file) {
      await wait(80, 220)
      const repo = repoOf(projectPath)
      if (!repo) throw new Error('This folder is not inside a git repository')
      return repo.diffs[file] ?? ''
    },

    async gitCommit(projectPath, message, files) {
      await wait(300, 700)
      const repo = repoOf(projectPath)
      if (!repo) throw new Error('This folder is not inside a git repository')
      if (!message.trim()) throw new Error('Write a commit message first')
      const taking = repo.changes.filter(c => !files || files.includes(c.path))
      if (!taking.length) throw new Error('Nothing is staged. Stage the changes you want in this commit first.')
      repo.changes = repo.changes.filter(c => !taking.includes(c))
      for (const c of taking) delete repo.diffs[c.path]
      repo.ahead += 1
      return Math.random().toString(16).slice(2, 9)
    },

    async gitPush(projectPath) {
      await wait(500, 1100)
      const repo = repoOf(projectPath)
      if (!repo) throw new Error('This folder is not inside a git repository')
      if (!repo.branch) throw new Error('HEAD is detached, so there is no branch to push. Switch to a branch first.')
      if (!repo.upstream) {
        repo.upstream = true
        repo.ahead = 0
        return `Published ${repo.branch} to origin/${repo.branch}.`
      }
      const n = repo.ahead
      repo.ahead = 0
      return n === 0 ? `Nothing to push. origin/${repo.branch} already has every commit.` : `Pushed ${n} commit${n === 1 ? '' : 's'} to origin/${repo.branch}.`
    },

    async gitWorktrees(projectPath) {
      await wait(120, 300)
      const { key, loc, dir } = mainOf(projectPath)
      const repo = repoOf(envPath({ ...loc, dir }))!
      const added = worktrees.get(key) ?? []
      const path = (d: string) => envPath({ hostId: loc.hostId, instance: loc.instance, dir: d })
      return {
        worktrees: [{ path: path(dir), branch: repo.branch, isMain: true }, ...added.map(w => ({ path: path(w.dir), branch: w.branch, isMain: false }))],
        branches: [...new Set([...(repo.branch ? [repo.branch] : []), 'main', ...added.map(w => w.branch)])],
      }
    },

    async gitWorktreeAdd(projectPath, branch): Promise<GitWorktree> {
      const name = safeRef(branch)
      // Checking out a branch into a new folder takes a moment.
      await wait(700, 1400)
      const { key, loc, dir } = mainOf(projectPath)
      const repo = repoOf(envPath({ ...loc, dir }))!
      const added = worktrees.get(key) ?? []
      if (repo.branch === name || added.some(w => w.branch === name)) throw new Error(`A branch named "${name}" already exists`)
      const folder = worktreeFolder(dir, name)
      validInstanceDir(folder)
      const shown = envPath({ hostId: loc.hostId, instance: loc.instance, dir: folder })
      if (added.some(w => w.dir === folder)) throw new Error(`${shown} already exists; pick another branch name`)
      worktrees.set(key, [...added, { dir: folder, branch: name }])
      return { path: shown, branch: name, isMain: false }
    },

    async chatImage(projectPath, path) {
      parseProjectPath(projectPath)
      checkedPicturePath(path)
      await wait(200, 500)
      if (path !== MOCK_SHOT_PATH) throw new Error(`Could not read ${path}: it does not exist in the environment`)
      return { data: MOCK_SHOT_PNG, mime: 'image/png', size: Math.floor(MOCK_SHOT_PNG.length * 3 / 4) }
    },

    async ghItem(projectPath, ref) {
      ghItemArgv(ref) // the same validation as the real one
      const { instance } = parseProjectPath(projectPath)
      await wait(300, 700)
      const found = MOCK_GITHUB[`github.com/${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase()]
      if (!found) throw new Error(ghFailure(instance, ref, 4, 'To get started with GitHub CLI, please run:  gh auth login'))
      return { ...found }
    },

    spawnFor(agent, projectPath): SpawnFn {
      return simulatedSpawn(agent, projectPath)
    },

    async reset() {},

    // Simulated runs never lose a connection.
    reconnectNow() {},
    watchConnections() { return () => {} },
  }
  return backend
}
