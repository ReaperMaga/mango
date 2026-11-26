<script setup lang="ts">
import {
  ArrowDown, ArrowDownToLine, ArrowUp, Check, ChevronDown, ChevronRight, CircleAlert, CircleCheck, CloudDownload, CloudUpload,
  Folder, GitBranch,
  GitBranchPlus, GitMerge, ListCheck, LogIn, Pencil, Search, Trash2, Waypoints,
} from 'lucide-vue-next'
import type { Component } from 'vue'
import type { GitBranchList, GitLocalBranch, GitRemoteBranch, MergePreview } from '~/types/ipc'
import { call } from '~/composables/useBackend'
import { useWorkspace } from '~/stores/workspace'
import { useGit } from '~/stores/git'
import { useFiles } from '~/stores/files'
import { releaseAgents } from '~/agents'
import { useThreads } from '~/stores/threads'
import { shortAgo } from '~/utils/time'
import { useOverlay } from '~/composables/useOverlay'
import { resultLines, vcsTerms } from '~/utils/vcs'

/**
 * Branch popup in the manner of JetBrains IDEs: one column with a search field,
 * actions for the current branch, then local and remote branches as a tree
 * (`feat/x` sits in a `feat` folder). Each branch opens a flyout with its own
 * actions (checkout, new branch from, merge, rebase, rename, delete).
 * Wraps its trigger (default slot) and opens under it.
 *
 * Unity VCS workspaces use it too: branches are paths (`/main/task`), a new
 * branch is a child of the one it starts from, merge asks first with what it
 * brings (the result is pending changes to check in), and the git-only
 * actions (fetch, push, rebase, remote branches) are left out.
 */
const props = defineProps<{ path: string | null }>()

const { t } = useI18n()
const ws = useWorkspace()
const git = useGit()
const fileStore = useFiles()
const threads = useThreads()

const WIDTH = 380
const SUB_WIDTH = 270

const open = ref(false)
useOverlay(() => open.value)
const root = ref<HTMLElement | null>(null)
const pop = ref<HTMLElement | null>(null)
const subEl = ref<HTMLElement | null>(null)
const search = ref<HTMLInputElement | null>(null)
const pos = ref({ left: 0, top: 0, maxHeight: 520 })

/* The last list read for this folder, shown at once; a fresh one replaces it when it arrives. */
const list = computed<GitBranchList | null>(() => (props.path ? git.branchLists[props.path] ?? null : null))
const loading = computed(() => git.readingBranchList(props.path))
const query = ref('')
const busy = ref<string | null>(null)
const message = ref<{ error: boolean; text: string } | null>(null)
const messageLines = computed(() => resultLines(message.value?.text ?? ''))

type Row = { key: string; kind: 'local'; b: GitLocalBranch } | { key: string; kind: 'remote'; b: GitRemoteBranch }

/** The list, or a small form in its place. `target` is the branch the form acts on. */
const view = ref<'list' | 'new' | 'rename' | 'delete' | 'clear' | 'merge'>('list')
const target = ref<Row | null>(null)
const nameInput = ref('')
const nameField = ref<HTMLInputElement | null>(null)
/** Delete was refused because the branch has unmerged commits: offer to force it. */
const unmerged = ref(false)

const status = computed(() => git.status(props.path))
const terms = computed(() => vcsTerms(status.value?.vcs ?? ws.openProjects.find(p => p.path === props.path)?.vcs))
const current = computed(() => list.value?.current ?? null)
const currentBranch = computed(() => list.value?.local.find(b => b.isCurrent) ?? null)
const q = computed(() => query.value.trim().toLowerCase())
const matches = (text: string) => !q.value || text.toLowerCase().includes(q.value)

/* ---------- actions for the current branch ---------- */

interface Action { id: string; label: string; icon: Component; count?: number; disabled: boolean; title?: string; divider?: boolean; run: () => unknown }
/*
 * Where the current branch tracks, and how far apart they are. Git status knows this for the branch
 * checked out, and is kept fresh while the list is still being read; the list is the fallback.
 * Unknown (neither read yet) leaves the actions on: git says why when one can't run.
 */
const tracking = computed(() => {
  const st = status.value
  if (st?.isRepo) return { known: true, upstream: st.upstream, ahead: st.ahead, behind: st.behind }
  const cb = currentBranch.value
  if (cb) return { known: true, upstream: cb.upstream, ahead: cb.ahead, behind: cb.behind }
  return { known: false, upstream: null, ahead: 0, behind: 0 }
})
const actions = computed<Action[]>(() => {
  const tr = tracking.value
  // No remote at all: only known once the list is read (a branch with an upstream implies one).
  const noRemote = !!list.value && !list.value.remotes.length && !tr.upstream
  const { remotes: hasRemotes } = terms.value
  const branch = current.value ?? t('git.thisBranch')
  const all: Action[] = [
    hasRemotes
      ? {
          id: 'pull', label: t('git.branches.update'), icon: ArrowDownToLine, count: tr.behind, disabled: !!busy.value || (tr.known && !tr.upstream),
          title: tr.upstream ? t('git.branches.pullInto', { upstream: tr.upstream, branch }) : tr.known ? t('git.branches.noTracking') : t('git.branches.pullRemote'),
          run: () => update(),
        }
      : {
          id: 'pull', label: t('git.branches.update'), icon: ArrowDownToLine, count: status.value?.behind, disabled: !!busy.value,
          title: status.value?.behind
            ? t('git.branches.updateN', { branch: current.value ?? t('git.panel.theBranch') }, status.value.behind)
            : t('git.branches.updateWorkspace'),
          run: () => update(),
        },
    { id: 'commit', label: hasRemotes ? t('git.branches.commit') : t('git.branches.checkIn'), icon: ListCheck, disabled: !!busy.value, title: hasRemotes ? t('git.branches.commitTitle') : t('git.branches.checkInTitle'), run: commitView },
    {
      id: 'push', label: tr.upstream ? t('git.branches.push') : t('git.branches.publish'), icon: CloudUpload, count: tr.ahead, disabled: !!busy.value || noRemote,
      title: tr.upstream ? t('git.branches.pushTitle', { branch, upstream: tr.upstream }) : t('git.branches.publishTitle', { branch }), run: () => push(),
    },
    { id: 'fetch', label: t('git.branches.fetch'), icon: CloudDownload, disabled: !!busy.value || noRemote, title: t('git.panel.fetch'), run: () => fetchAll() },
    { id: 'new', label: t('git.newBranch'), icon: GitBranchPlus, divider: true, disabled: !!busy.value, title: current.value ? t('git.branches.newFrom', { branch: current.value }) : undefined, run: () => startName('new', null) },
  ]
  // Unity VCS checkins go straight to the server: nothing to push or fetch.
  return all.filter(a => (hasRemotes || (a.id !== 'push' && a.id !== 'fetch')) && matches(a.label))
})

/* ---------- branch tree ---------- */

type TreeNode =
  | { kind: 'section'; key: string; name: string; open: boolean; count: number }
  | { kind: 'folder'; key: string; name: string; depth: number; open: boolean }
  | { kind: 'branch'; key: string; label: string; depth: number; row: Row }

/** Folded sections and folders, by key. Searching unfolds everything. The sections start folded. */
const folded = ref(new Set<string>(['local', 'remote']))
function toggleFold(key: string) {
  const next = new Set(folded.value)
  next.has(key) ? next.delete(key) : next.add(key)
  folded.value = next
}
const isOpen = (key: string) => !!q.value || !folded.value.has(key)

function tree(section: string, rows: Row[]): TreeNode[] {
  type Dir = { dirs: Map<string, Dir>; leaves: { row: Row; label: string }[] }
  const top: Dir = { dirs: new Map(), leaves: [] }
  for (const row of rows) {
    // Unity VCS names start at the root (`/main/task`): the tree starts at `main`.
    const parts = row.b.name.replace(/^\/+/, '').split('/')
    let dir = top
    for (const seg of parts.slice(0, -1)) {
      if (!dir.dirs.has(seg)) dir.dirs.set(seg, { dirs: new Map(), leaves: [] })
      dir = dir.dirs.get(seg)!
    }
    dir.leaves.push({ row, label: parts[parts.length - 1]! })
  }
  const out: TreeNode[] = []
  const walk = (dir: Dir, depth: number, prefix: string) => {
    const entries = [
      ...[...dir.dirs].map(([name, d]) => ({ name, d, leaf: null as null | { row: Row; label: string } })),
      ...dir.leaves.map(l => ({ name: l.label, d: null as Dir | null, leaf: l })),
    // A Unity VCS branch can also be the folder of its children (`/main`, `/main/task`): the branch comes first.
    ].sort((a, b) => a.name.localeCompare(b.name) || Number(!a.leaf) - Number(!b.leaf))
    for (const e of entries) {
      if (e.leaf) { out.push({ kind: 'branch', key: e.leaf.row.key, label: e.leaf.label, depth, row: e.leaf.row }); continue }
      const key = `${prefix}/${e.name}`
      const open = isOpen(key)
      out.push({ kind: 'folder', key, name: e.name, depth, open })
      if (open) walk(e.d!, depth + 1, key)
    }
  }
  walk(top, 1, section)
  return out
}

const locals = computed<Row[]>(() => (list.value?.local ?? []).filter(b => matches(b.name)).map(b => ({ key: `l:${b.name}`, kind: 'local' as const, b })))
const remotes = computed<Row[]>(() => (list.value?.remote ?? []).filter(b => matches(b.name)).map(b => ({ key: `r:${b.name}`, kind: 'remote' as const, b })))
const rowsByKey = computed(() => new Map([...locals.value, ...remotes.value].map(r => [r.key, r])))

const nodes = computed<TreeNode[]>(() => {
  const out: TreeNode[] = []
  const localName = terms.value.remotes ? t('git.branches.local') : t('git.branches.title')
  for (const [key, name, rows] of [['local', localName, locals.value], ['remote', t('git.branches.remote'), remotes.value]] as const) {
    if (!rows.length) continue
    const open = isOpen(key)
    out.push({ kind: 'section', key, name, open, count: rows.length })
    if (open) out.push(...tree(key, rows))
  }
  return out
})

/* ---------- keyboard focus: one list across actions and the tree ---------- */

const active = ref<string | null>(null)
const nav = computed(() => [...actions.value.map(a => `a:${a.id}`), ...nodes.value.map(n => n.key)])
watch(nav, (keys) => { if (!active.value || !keys.includes(active.value)) active.value = keys[0] ?? null })
watch(q, () => { active.value = nav.value[0] ?? null; closeSub() })
watch(active, async (key) => {
  if (!key) return
  await nextTick()
  pop.value?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' })
})

/* ---------- open / close / position ---------- */

function place() {
  const el = root.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const width = Math.min(WIDTH, window.innerWidth - 16)
  pos.value = {
    left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
    top: r.bottom + 6,
    maxHeight: Math.max(240, window.innerHeight - r.bottom - 24),
  }
}

/** Read the list again; one started `since` or later is reused. A failure shows in the popup. */
async function load(since?: number) {
  if (!props.path) return
  try {
    await git.loadBranchList(props.path, since)
  } catch (e) {
    if (open.value) message.value = { error: true, text: reason(e) }
  }
}

/* Hovering or focusing the trigger reads the list ahead, so it is (nearly) there when the popup opens. */
const PREFETCH_DELAY_MS = 120
/** A list read this recently is fresh enough for a prefetch (or for opening right after one). */
const FRESH_MS = 4000
let prefetchTimer: ReturnType<typeof setTimeout> | undefined
function prefetch() {
  const path = props.path
  if (!path || open.value) return
  git.loadBranchList(path, Date.now() - FRESH_MS).catch(() => {})
}
function onTriggerEnter() {
  clearTimeout(prefetchTimer)
  prefetchTimer = setTimeout(prefetch, PREFETCH_DELAY_MS)
}
function onTriggerLeave() { clearTimeout(prefetchTimer) }

async function show() {
  if (!props.path) return
  place()
  open.value = true
  query.value = ''
  message.value = null
  view.value = 'list'
  sub.value = null
  active.value = null
  // The kept list shows at once; a read the hover started moments ago is fresh enough.
  void load(Date.now() - FRESH_MS)
  await nextTick()
  place()
  search.value?.focus()
}
function close() {
  open.value = false
  sub.value = null
}
function toggle() {
  open.value ? close() : show()
}

function onDocDown(e: MouseEvent) {
  if (!open.value) return
  const on = e.target as Node
  if (root.value?.contains(on) || pop.value?.contains(on) || subEl.value?.contains(on)) return
  close()
}
function onResize() { if (open.value) { place(); closeSub() } }
onMounted(() => {
  document.addEventListener('mousedown', onDocDown, true)
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => {
  clearTimeout(prefetchTimer)
  document.removeEventListener('mousedown', onDocDown, true)
  window.removeEventListener('resize', onResize)
})

/* ---------- a branch's flyout ---------- */

const sub = ref<{ key: string; left: number; top: number } | null>(null)
const subRow = computed(() => (sub.value ? rowsByKey.value.get(sub.value.key) ?? null : null))

async function openSub(key: string, focusFirst = false) {
  const rowEl = pop.value?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)
  const box = pop.value?.getBoundingClientRect()
  if (!rowEl || !box) return
  const r = rowEl.getBoundingClientRect()
  const right = box.right + 4
  const left = right + SUB_WIDTH <= window.innerWidth - 8 ? right : Math.max(8, box.left - SUB_WIDTH - 4)
  active.value = key
  sub.value = { key, left, top: r.top - 5 }
  await nextTick()
  // Keep the whole flyout on screen.
  const h = subEl.value?.offsetHeight ?? 0
  if (sub.value && sub.value.top + h > window.innerHeight - 8) sub.value.top = Math.max(8, window.innerHeight - h - 8)
  if (focusFirst) subEl.value?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
}
function closeSub(refocus = false) {
  sub.value = null
  if (refocus) search.value?.focus()
}
function onRowClick(key: string) {
  sub.value?.key === key ? closeSub() : void openSub(key)
}

/* ---------- running things ---------- */

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).trim()

/** Actions that change the working copy's files, and ones that only read them. */
const CHANGES_FILES = ['checkout', 'pull', 'merge', 'rebase', 'create']
const READS_FILES = ['fetch', 'push']

/**
 * Run a git action, show what it said, and bring every view of the repository up to date. The
 * action is given the folder it was asked for: saving open files first takes a moment.
 */
async function run<T>(id: string, action: (path: string) => Promise<T>, done?: (result: T) => string | void): Promise<boolean> {
  const at = props.path
  if (busy.value || !at) return false
  busy.value = id
  message.value = null
  try {
    const work = () => action(at)
    const result = await (CHANGES_FILES.includes(id)
      ? fileStore.aroundChange([at], work)
      : READS_FILES.includes(id) ? fileStore.aroundRead([at], work) : work())
    const text = done?.(result)
    if (text) message.value = { error: false, text }
    return true
  } catch (e) {
    message.value = { error: true, text: reason(e) }
    return false
  } finally {
    busy.value = null
    // Status first: its read then reuses this list read instead of starting another.
    const refreshed = git.refresh(at).catch(() => {})
    await Promise.all([load(), refreshed])
  }
}

const p = () => props.path!

async function checkout(row: Row) {
  if (row.kind === 'local' && row.b.isCurrent) return
  closeSub()
  const ok = row.kind === 'local'
    ? await run('checkout', path => call('git_checkout', { path, branch: row.b.name, create: false }))
    : await run('checkout', path => call('git_checkout_remote', { path, branch: row.b.name }))
  if (ok) close()
}
const update = () => run('pull', path => call('git_pull', { path }), out => out || t('git.result.upToDate'))
const fetchAll = () => run('fetch', path => call('git_fetch', { path }), out => out || t('git.branches.fetched'))
const push = () => run('push', path => call('git_push', { path }), out => out || t('git.result.pushed'))
/** Unity VCS: what the merge in the confirm would do; null while it is read. */
const mergePlan = ref<MergePreview | null>(null)

async function merge(row: Row) {
  if (!terms.value.mergePreview) {
    closeSub(true)
    return run('merge', path => call('git_merge', { path, branch: row.b.name }), out => out || t('git.result.merged', { branch: row.b.name }))
  }
  // Unity VCS: confirm first, with what the merge brings and anything that stops it.
  closeSub()
  target.value = row
  view.value = 'merge'
  mergePlan.value = null
  message.value = null
  const branch = row.b.name
  try {
    const plan = await call('git_merge_preview', { path: p(), branch })
    if (view.value !== 'merge' || target.value?.b.name !== branch) return
    mergePlan.value = plan
  } catch (e) {
    if (view.value === 'merge') message.value = { error: true, text: reason(e) }
  }
  await nextTick()
  pop.value?.querySelector<HTMLElement>('[data-merge-go]:not(:disabled), [data-cancel]')?.focus()
}
const mergeReady = computed(() => !!mergePlan.value && !mergePlan.value.blocker && !mergePlan.value.conflicts.length && mergePlan.value.files.length > 0)
async function confirmMerge() {
  const row = target.value
  if (!row || !mergeReady.value) return
  const ok = await run('merge', path => call('git_merge', { path, branch: row.b.name }), out => out || t('git.result.merged', { branch: row.b.name }))
  if (ok) await backToList()
}
function rebase(row: Row) {
  closeSub(true)
  return run('rebase', path => call('git_rebase', { path, onto: row.b.name }), out => out || t('git.branches.rebased', { branch: row.b.name }))
}

function commitView() {
  ws.openTool('changes')
  close()
}

/** Unity VCS renames a branch in place, so only its last segment is edited. */
const leafOf = (name: string) => name.slice(name.lastIndexOf('/') + 1)
const parentOf = (name: string) => name.slice(0, Math.max(0, name.lastIndexOf('/')))
const renameFrom = computed(() => (target.value ? (terms.value.pathBranches ? leafOf(target.value.b.name) : target.value.b.name) : ''))
/** Unity VCS: the full name a new branch gets, a child of where it starts unless typed from the root. */
const newFullName = computed(() => {
  const name = nameInput.value.trim()
  if (!terms.value.pathBranches || !name) return null
  if (name.startsWith('/')) return name
  const base = target.value?.b.name ?? current.value
  return base ? `${base.replace(/\/+$/, '')}/${name}` : `/${name}`
})

async function startName(kind: 'new' | 'rename', row: Row | null) {
  closeSub()
  target.value = row
  view.value = kind
  nameInput.value = kind === 'rename' && row ? (terms.value.pathBranches ? leafOf(row.b.name) : row.b.name) : ''
  message.value = null
  await nextTick()
  nameField.value?.focus()
  nameField.value?.select()
}
function startDelete(row: Row) {
  closeSub()
  target.value = row
  view.value = 'delete'
  unmerged.value = false
  message.value = null
  void readTrees()
}
async function backToList() {
  view.value = 'list'
  unmerged.value = false
  await nextTick()
  search.value?.focus()
}
/** Branch names can't hold spaces; type them as dashes. */
function onNameInput(e: Event) {
  nameInput.value = (e.target as HTMLInputElement).value.replace(/\s+/g, '-')
}
async function submitName() {
  const name = nameInput.value.trim()
  const row = target.value
  if (!name) return
  if (view.value === 'new') {
    const from = row ? row.b.name : null
    const ok = await run('create', path => call('git_branch_create', { path, name, from, checkout: true }))
    if (ok) close()
  } else if (view.value === 'rename' && row) {
    const full = terms.value.pathBranches && !name.includes('/') ? `${parentOf(row.b.name)}/${name}` : name
    const ok = await run('rename', path => call('git_branch_rename', { path, from: row.b.name, to: name }), () => t('git.branches.renamedTo', { name: full }))
    if (ok) { await backToList(); active.value = `l:${full}` }
  }
}
/**
 * Linked git worktrees by the branch they have checked out (the main one and the one this
 * folder is in left out): deleting such a branch removes its worktree too. `main` is the
 * repository's main folder, whose worktree list the Changes view shows.
 */
const trees = ref<{ main: string | null; byBranch: Record<string, string> }>({ main: null, byBranch: {} })
let treesRead: Promise<void> | null = null
function readTrees() {
  trees.value = { main: null, byBranch: {} }
  if (!terms.value.remotes || !props.path) return (treesRead = Promise.resolve())
  const at = p()
  return (treesRead = call('git_worktrees', { path: at }).then((list) => {
    if (at !== props.path) return
    const byBranch: Record<string, string> = {}
    for (const w of list) if (!w.isMain && !w.isCurrent && w.branch) byBranch[w.branch] = w.path
    trees.value = { main: list.find(w => w.isMain)?.path ?? null, byBranch }
  }, () => {}))
}
/** Delete a local branch and the worktree it is checked out in, if any. Resolves to whether a worktree went. */
async function deleteBranch(name: string, force: boolean): Promise<boolean> {
  const at = p()
  await treesRead
  const folder = trees.value.byBranch[name]
  if (folder && threads.threads.some(x => x.worktree === folder && threads.isBusyChat(x.id))) {
    throw new Error(t('git.branches.chatWorking', { folder }))
  }
  const main = trees.value.main ?? at
  // A process in the folder would keep Windows from removing it.
  if (folder) await releaseAgents(k => k.folder === folder)
  const remove = () => call('git_branch_delete', { path: at, branch: name, force, withWorktree: true })
  const removed = await (folder ? fileStore.aroundChange([folder], remove) : remove())
  if (removed) threads.forgetWorktree(main, removed)
  return !!removed
}

async function remove(force: boolean) {
  const row = target.value
  if (!row || row.kind !== 'local') return
  const name = row.b.name
  const ok = await run('delete', () => deleteBranch(name, force), tree => tree ? t('git.branches.deletedWithTree', { name }) : t('git.branches.deletedOne', { name }))
  if (ok) await backToList()
  else if (/not fully merged/i.test(message.value?.text ?? '')) {
    unmerged.value = true
    message.value = { error: true, text: t('git.branches.unmergedOne', { name }) }
  }
}

/* ---------- clearing local branches (git only) ---------- */

/** Long-lived branches that clearing never touches, besides the current one. */
const KEPT = new Set(['main', 'master', 'develop', 'trunk'])
const clearable = computed(() => (list.value?.local ?? []).filter(b => !b.isCurrent && !KEPT.has(b.name)).map(b => b.name))
const clearKept = computed(() => (list.value?.local ?? []).filter(b => b.isCurrent || KEPT.has(b.name)).map(b => b.name))
/** Branches the last clear skipped because they hold unmerged commits: deleting them needs one more confirmation. */
const clearUnmerged = ref<string[]>([])

async function startClear() {
  closeSub()
  view.value = 'clear'
  clearUnmerged.value = []
  message.value = null
  void readTrees()
  // Focus lands on Cancel, so Enter alone never deletes.
  await nextTick()
  pop.value?.querySelector<HTMLElement>('[data-cancel]')?.focus()
}
async function clearLocal(force: boolean) {
  const names = force ? clearUnmerged.value : clearable.value
  if (busy.value || !names.length) return
  const deleted: string[] = []
  const unmergedNames: string[] = []
  const failed: string[] = []
  let treesGone = 0
  await run('clear', async () => {
    for (const name of names) {
      try {
        if (await deleteBranch(name, force)) treesGone++
        deleted.push(name)
      } catch (e) {
        if (!force && /not fully merged/i.test(reason(e))) unmergedNames.push(name)
        else failed.push(`${name}: ${reason(e)}`)
      }
    }
  })
  clearUnmerged.value = unmergedNames
  const branches = t('git.branches.count', deleted.length)
  const result = treesGone
    ? t('git.branches.deletedAndTrees', { branches, trees: t('git.branches.treeCount', treesGone) })
    : t('git.branches.deleted', { branches })
  const done = deleted.length ? `${result} ` : ''
  if (unmergedNames.length) {
    message.value = { error: true, text: `${done}${t('git.branches.unmerged', unmergedNames.length)}\n${unmergedNames.join('\n')}` }
  } else if (failed.length) {
    message.value = { error: true, text: `${done}${t('git.branches.notDeleted', failed.length)}\n${failed.join('\n')}` }
  } else {
    await backToList()
    message.value = { error: false, text: result }
  }
}

/* ---------- keyboard ---------- */

function activate(key: string) {
  if (key.startsWith('a:')) {
    const a = actions.value.find(x => `a:${x.id}` === key)
    if (a && !a.disabled) void a.run()
    return
  }
  const node = nodes.value.find(n => n.key === key)
  if (!node) return
  if (node.kind === 'branch') void checkout(node.row)
  else toggleFold(node.key)
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    if (sub.value) closeSub(true)
    else if (view.value !== 'list') void backToList()
    else close()
    return
  }
  if (view.value !== 'list' || e.target !== search.value) return
  const keys = nav.value
  const at = keys.indexOf(active.value ?? '')
  const node = nodes.value.find(n => n.key === active.value)
  if (e.key === 'ArrowDown') { e.preventDefault(); closeSub(); active.value = keys[Math.min(keys.length - 1, at + 1)] ?? active.value }
  else if (e.key === 'ArrowUp') { e.preventDefault(); closeSub(); active.value = keys[Math.max(0, at - 1)] ?? active.value }
  else if (e.key === 'Enter' && active.value) { e.preventDefault(); activate(active.value) }
  else if (e.key === 'ArrowRight' && node && !query.value.length) {
    e.preventDefault()
    if (node.kind === 'branch') void openSub(node.key, true)
    else if (!node.open) toggleFold(node.key)
  } else if (e.key === 'ArrowLeft' && node && node.kind !== 'branch' && node.open && !query.value.length) {
    e.preventDefault()
    toggleFold(node.key)
  }
}

/** Arrow keys inside the flyout move between its items; left or Escape goes back to the list. */
function onSubKey(e: KeyboardEvent) {
  const items = [...(subEl.value?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])]
  const at = items.indexOf(document.activeElement as HTMLElement)
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(at + 1) % items.length]?.focus() }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(at - 1 + items.length) % items.length]?.focus() }
  else if (e.key === 'ArrowLeft' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSub(true) }
}

const now = () => Date.now()
defineExpose({ show, close })
</script>

<template>
  <div ref="root" class="bp-anchor" @pointerenter="onTriggerEnter" @pointerleave="onTriggerLeave" @focusin="prefetch">
    <slot :open="open" :toggle="toggle" />
    <Teleport to="body">
      <Transition name="bp">
        <div
          v-if="open"
          ref="pop"
          class="bp"
          role="dialog"
          :aria-label="t('git.branches.title')"
          :style="{ left: `${pos.left}px`, top: `${pos.top}px`, maxHeight: `${pos.maxHeight}px`, width: `min(${WIDTH}px, calc(100vw - 16px))` }"
          @keydown="onKey"
        >
          <template v-if="view === 'list'">
            <div class="bp__search">
              <Search aria-hidden="true" />
              <input
                ref="search"
                v-model="query"
                type="text"
                :placeholder="t('git.branches.search')"
                :aria-label="t('git.branches.search')"
                spellcheck="false"
                autocomplete="off"
              >
              <span v-if="loading" class="bp__spin" aria-hidden="true" />
            </div>

            <div class="bp__scroll" role="listbox" :aria-label="t('git.branches.list')" @scroll="closeSub()">
              <template v-for="a in actions" :key="a.id">
                <div v-if="a.divider" class="bp__sep" role="separator" />
                <button
                  type="button"
                  class="bp__item"
                  :class="{ 'is-active': active === `a:${a.id}` }"
                  role="option"
                  :aria-selected="active === `a:${a.id}`"
                  :data-key="`a:${a.id}`"
                  :disabled="a.disabled"
                  :title="a.title"
                  @mousemove="active = `a:${a.id}`"
                  @click="a.run()"
                >
                  <span class="bp__icon"><span v-if="busy === a.id" class="bp__spin" /><component :is="a.icon" v-else /></span>
                  <span class="bp__label">{{ a.label }}</span>
                  <span v-if="a.count" class="bp__n tabular">{{ a.count }}</span>
                </button>
              </template>

              <div v-if="actions.length && nodes.length" class="bp__sep" role="separator" />

              <template v-for="n in nodes" :key="n.key">
                <div v-if="n.kind === 'section' || n.kind === 'folder'" class="bp__fold-row" :class="{ 'is-active': active === n.key }">
                  <button
                    type="button"
                    class="bp__item bp__item--fold"
                    :class="{ 'is-active': active === n.key, 'bp__item--section': n.kind === 'section' }"
                    :style="n.kind === 'folder' ? { '--depth': n.depth } : undefined"
                    :aria-expanded="n.open"
                    :data-key="n.key"
                    @mousemove="active = n.key"
                    @click="closeSub(); toggleFold(n.key)"
                  >
                    <component :is="n.open ? ChevronDown : ChevronRight" class="bp__caret" />
                    <Folder v-if="n.kind === 'folder'" class="bp__folder" />
                    <span class="bp__label" :class="{ 'bp__label--mono': n.kind === 'folder' }">{{ n.name }}</span>
                    <span v-if="n.kind === 'section'" class="bp__count tabular">{{ n.count }}</span>
                  </button>
                  <UiIconButton
                    v-if="n.key === 'local' && terms.clearBranches && clearable.length"
                    size="sm"
                    class="bp__row-btn"
                    :label="t('git.branches.clearItem')"
                    :disabled="!!busy"
                    @mousemove="active = n.key"
                    @click="startClear"
                  >
                    <Trash2 />
                  </UiIconButton>
                </div>
                <button
                  v-else
                  type="button"
                  class="bp__item bp__item--branch"
                  :class="{
                    'is-active': active === n.key || sub?.key === n.key,
                    'is-current': n.row.kind === 'local' && n.row.b.isCurrent,
                  }"
                  :style="{ '--depth': n.depth }"
                  role="option"
                  :aria-selected="active === n.key"
                  aria-haspopup="menu"
                  :aria-expanded="sub?.key === n.key"
                  :data-key="n.key"
                  :title="n.row.b.subject || undefined"
                  @mousemove="active = n.key"
                  @click="onRowClick(n.key)"
                  @dblclick="checkout(n.row)"
                >
                  <Check v-if="n.row.kind === 'local' && n.row.b.isCurrent" class="bp__branch-icon bp__branch-icon--current" />
                  <GitBranch v-else class="bp__branch-icon" />
                  <span class="bp__label bp__label--mono">{{ n.label }}</span>
                  <template v-if="n.row.kind === 'local'">
                    <span v-if="n.row.b.ahead || n.row.b.behind" class="bp__track tabular">
                      <template v-if="n.row.b.ahead"><ArrowUp />{{ n.row.b.ahead }}</template>
                      <template v-if="n.row.b.behind"><ArrowDown />{{ n.row.b.behind }}</template>
                    </span>
                    <span v-if="n.row.b.upstream" class="bp__upstream">{{ n.row.b.upstream }}</span>
                  </template>
                  <ChevronRight class="bp__more" />
                </button>
              </template>

              <p v-if="!actions.length && !nodes.length" class="bp__empty">
                {{ loading ? t('git.branches.reading') : q ? t('git.branches.noMatch', { query: query.trim() }) : t('git.branches.none') }}
              </p>
              <p v-else-if="!nodes.length && loading" class="bp__empty">{{ t('git.branches.reading') }}</p>
            </div>
          </template>

          <form v-else-if="view === 'new' || view === 'rename'" class="bp__form" @submit.prevent="submitName">
            <label class="bp__form-title" for="bp-name">
              <i18n-t v-if="view === 'new'" keypath="git.branches.newFrom" scope="global"><template #branch><span class="bp__mono">{{ target?.b.name ?? current ?? 'HEAD' }}</span></template></i18n-t>
              <i18n-t v-else keypath="git.branches.renameTitle" scope="global"><template #branch><span class="bp__mono">{{ target?.b.name }}</span></template></i18n-t>
            </label>
            <input id="bp-name" ref="nameField" :value="nameInput" class="bp__input" :placeholder="terms.pathBranches ? 'task-name' : 'branch-name'" spellcheck="false" autocomplete="off" @input="onNameInput">
            <p v-if="view === 'new' && newFullName" class="bp__hint"><i18n-t keypath="git.branches.createdAs" scope="global"><template #name><span class="bp__mono">{{ newFullName }}</span></template></i18n-t></p>
            <p v-else-if="view === 'new'" class="bp__hint">{{ t('git.branches.createdHint') }}</p>
            <p v-else-if="terms.pathBranches" class="bp__hint">{{ t('git.branches.renameHint') }}</p>
            <div class="bp__form-actions">
              <UiButton v-if="view === 'new'" size="sm" variant="primary" type="submit" :loading="busy === 'create'" :disabled="!nameInput.trim()">{{ t('git.branches.create') }}</UiButton>
              <UiButton v-else size="sm" variant="primary" type="submit" :loading="busy === 'rename'" :disabled="!nameInput.trim() || nameInput.trim() === renameFrom">{{ t('common.actions.rename') }}</UiButton>
              <UiButton size="sm" variant="ghost" @click="backToList">{{ t('common.actions.cancel') }}</UiButton>
            </div>
          </form>

          <div v-else-if="view === 'delete' && target" class="bp__form">
            <p class="bp__form-title"><i18n-t keypath="git.branches.deleteAsk" scope="global"><template #branch><span class="bp__mono">{{ target.b.name }}</span></template></i18n-t></p>
            <p class="bp__hint">
              {{ terms.deleteHint }}
              <i18n-t v-if="trees.byBranch[target.b.name]" keypath="git.branches.deleteTreeHint" scope="global">
                <template #folder><span class="bp__mono">{{ trees.byBranch[target.b.name] }}</span></template>
              </i18n-t>
            </p>
            <div class="bp__form-actions">
              <UiButton size="sm" variant="danger" :loading="busy === 'delete'" data-autofocus @click="remove(unmerged)">{{ unmerged ? t('git.branches.deleteAnyway') : t('common.actions.delete') }}</UiButton>
              <UiButton size="sm" variant="ghost" @click="backToList">{{ t('common.actions.cancel') }}</UiButton>
            </div>
          </div>

          <div v-else-if="view === 'merge' && target" class="bp__form" aria-live="polite">
            <p class="bp__form-title"><i18n-t keypath="git.branches.mergeAsk" scope="global"><template #from><span class="bp__mono">{{ target.b.name }}</span></template><template #into><span class="bp__mono">{{ current }}</span></template></i18n-t></p>
            <p v-if="!mergePlan && !message" class="bp__hint bp__reading"><span class="bp__spin" aria-hidden="true" />{{ t('git.branches.mergeReading') }}</p>
            <template v-else-if="mergePlan">
              <p v-if="mergePlan.blocker" class="bp__note"><CircleAlert aria-hidden="true" />{{ mergePlan.blocker }}</p>
              <template v-else-if="mergePlan.conflicts.length">
                <p class="bp__note">
                  <CircleAlert aria-hidden="true" />
                  <span>
                    {{ t('git.branches.conflicts', mergePlan.conflicts.length) }}
                    {{ t('git.branches.conflictsHint') }}
                  </span>
                </p>
                <ul class="bp__names">
                  <li v-for="f in mergePlan.conflicts" :key="f" class="bp__mono" :title="f">{{ f }}</li>
                </ul>
              </template>
              <p v-else-if="!mergePlan.files.length" class="bp__hint"><i18n-t keypath="git.branches.mergeNothing" scope="global"><template #branch><span class="bp__mono">{{ current }}</span></template></i18n-t></p>
              <template v-else>
                <ul class="bp__names">
                  <li v-for="f in mergePlan.files" :key="f" class="bp__mono" :title="f">{{ f }}</li>
                </ul>
                <p class="bp__hint">
                  <span class="tabular">{{ t('git.branches.filesChange', mergePlan.files.length) }}</span>
                  {{ t('git.branches.mergeHint') }}
                </p>
              </template>
            </template>
            <div class="bp__form-actions">
              <UiButton v-if="mergeReady" size="sm" variant="primary" data-merge-go :loading="busy === 'merge'" @click="confirmMerge">
                {{ t('git.branches.mergeFiles', mergePlan!.files.length) }}
              </UiButton>
              <UiButton size="sm" variant="ghost" data-cancel :disabled="busy === 'merge'" @click="backToList">{{ mergeReady || !mergePlan ? t('common.actions.cancel') : t('common.actions.back') }}</UiButton>
            </div>
          </div>

          <div v-else-if="view === 'clear'" class="bp__form">
            <template v-if="clearUnmerged.length">
              <p class="bp__form-title">{{ t('git.branches.clearAnywayAsk', clearUnmerged.length) }}</p>
              <p class="bp__hint">{{ t('git.branches.clearLost') }}</p>
            </template>
            <template v-else>
              <p class="bp__form-title">{{ t('git.branches.clearAsk', clearable.length) }}</p>
              <ul class="bp__names">
                <li v-for="name in clearable" :key="name" class="bp__mono">
                  {{ name }}<span v-if="trees.byBranch[name]" class="bp__names-note">{{ ` ${t('git.branches.plusTree')}` }}</span>
                </li>
              </ul>
              <p class="bp__hint">
                {{ t('git.branches.clearHint') }}
                <template v-if="clearable.some(n => trees.byBranch[n])">{{ t('git.branches.clearTrees') }}{{ ' ' }}</template>
                <i18n-t v-if="clearKept.length" keypath="git.branches.clearKept" scope="global"><template #names><span class="bp__mono">{{ clearKept.join(', ') }}</span></template></i18n-t>
              </p>
            </template>
            <div class="bp__form-actions">
              <UiButton
                size="sm"
                variant="danger"
                :loading="busy === 'clear'"
                :disabled="!(clearUnmerged.length || clearable.length)"
                @click="clearLocal(clearUnmerged.length > 0)"
              >
                {{ clearUnmerged.length ? t('git.branches.clearAnyway', { n: clearUnmerged.length }) : t('git.branches.clear', { n: clearable.length }) }}
              </UiButton>
              <UiButton size="sm" variant="ghost" data-cancel @click="backToList">{{ clearUnmerged.length ? t('git.branches.keepThem') : t('common.actions.cancel') }}</UiButton>
            </div>
          </div>

          <div v-if="message" class="bp__msg" :class="{ 'is-error': message.error }" :role="message.error ? 'alert' : 'status'">
            <CircleAlert v-if="message.error" class="bp__msg-icon" aria-hidden="true" />
            <CircleCheck v-else class="bp__msg-icon" aria-hidden="true" />
            <div class="bp__msg-body selectable">
              <p class="bp__msg-title">{{ messageLines.title }}</p>
              <p v-if="messageLines.detail" class="bp__msg-detail">{{ messageLines.detail }}</p>
            </div>
          </div>
        </div>
      </Transition>

      <!-- One branch's actions, beside the popup -->
      <Transition name="bp-sub">
        <div
          v-if="open && sub && subRow"
          ref="subEl"
          class="bp-sub"
          role="menu"
          :aria-label="t('git.branches.actionsFor', { branch: subRow.b.name })"
          :style="{ left: `${sub.left}px`, top: `${sub.top}px`, width: `${SUB_WIDTH}px` }"
          @keydown="onSubKey"
        >
          <div class="bp-sub__head">
            <div class="bp-sub__name">{{ subRow.b.name }}</div>
            <div class="bp-sub__meta">
              <template v-if="subRow.kind === 'local'">
                <span v-if="subRow.b.isCurrent">{{ t('git.branches.current') }}</span>
                <span v-if="subRow.b.upstream">{{ subRow.b.upstreamGone ? t('git.branches.upstreamGone', { upstream: subRow.b.upstream }) : t('git.branches.tracks', { upstream: subRow.b.upstream }) }}</span>
                <span v-else-if="terms.remotes">{{ t('git.branches.notPublished') }}</span>
              </template>
              <span v-else>{{ t('git.branches.onRemote', { remote: subRow.b.remote }) }}</span>
              <span v-if="subRow.b.time" class="tabular">{{ t('git.branches.ago', { time: shortAgo(subRow.b.time, now()) }) }}</span>
            </div>
            <p v-if="subRow.b.subject" class="bp-sub__subject">{{ subRow.b.subject }}</p>
          </div>
          <div class="bp__sep" role="separator" />
          <button v-if="!(subRow.kind === 'local' && subRow.b.isCurrent)" type="button" role="menuitem" class="bp__item" :disabled="!!busy" @click="checkout(subRow)">
            <span class="bp__icon"><span v-if="busy === 'checkout'" class="bp__spin" /><LogIn v-else /></span>
            <span class="bp__label">{{ t('git.branches.checkout') }}</span>
          </button>
          <button type="button" role="menuitem" class="bp__item" :disabled="!!busy" @click="startName('new', subRow)">
            <span class="bp__icon"><GitBranchPlus /></span>
            <span class="bp__label">{{ t('git.branches.newFromHere') }}</span>
          </button>
          <template v-if="!(subRow.kind === 'local' && subRow.b.isCurrent) && current">
            <button v-if="terms.merge" type="button" role="menuitem" class="bp__item" :disabled="!!busy" @click="merge(subRow)">
              <span class="bp__icon"><GitMerge /></span>
              <i18n-t :keypath="terms.mergePreview ? 'git.branches.mergeIntoAsk' : 'git.branches.mergeInto'" tag="span" class="bp__label" scope="global"><template #branch><span class="bp__mono">{{ current }}</span></template></i18n-t>
            </button>
            <button v-if="terms.rebase" type="button" role="menuitem" class="bp__item" :disabled="!!busy" @click="rebase(subRow)">
              <span class="bp__icon"><Waypoints /></span>
              <i18n-t keypath="git.branches.rebaseOnto" tag="span" class="bp__label" scope="global"><template #branch><span class="bp__mono">{{ current }}</span></template></i18n-t>
            </button>
          </template>
          <template v-if="subRow.kind === 'local'">
            <div class="bp__sep" role="separator" />
            <button v-if="terms.rename" type="button" role="menuitem" class="bp__item" :disabled="!!busy" @click="startName('rename', subRow)">
              <span class="bp__icon"><Pencil /></span>
              <span class="bp__label">{{ t('git.branches.renameItem') }}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              class="bp__item is-danger"
              :disabled="!!busy || subRow.b.isCurrent"
              :title="subRow.b.isCurrent ? t('git.branches.switchFirst') : undefined"
              @click="startDelete(subRow)"
            >
              <span class="bp__icon"><Trash2 /></span>
              <span class="bp__label">{{ t('git.branches.deleteItem') }}</span>
            </button>
          </template>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.bp-anchor { display: inline-flex; min-width: 0; }
</style>

<!-- The popup and its flyout are teleported to <body>, outside this component's scoped subtree. -->
<style>
.bp, .bp-sub {
  position: fixed;
  z-index: 80;
  display: flex;
  flex-direction: column;
  background: var(--bg-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-pop);
  font-size: var(--text-sm);
}
.bp { overflow: hidden; }
.bp-sub { z-index: 81; max-height: calc(100vh - 16px); overflow-y: auto; padding: var(--space-1); border-radius: var(--radius-md); }
.bp-enter-active, .bp-leave-active { transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out); transform-origin: top left; }
.bp-enter-from, .bp-leave-to { opacity: 0; transform: scale(0.98) translateY(-2px); }
.bp-sub-enter-active, .bp-sub-leave-active { transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out); }
.bp-sub-enter-from, .bp-sub-leave-to { opacity: 0; transform: translateX(-3px); }

.bp__search {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 38px;
  margin: var(--space-2) var(--space-2) 0;
  padding: 0 var(--space-2);
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}
.bp__search:focus-within { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.bp__search svg { width: 15px; height: 15px; color: var(--fg-subtle); flex: none; }
.bp__search input { flex: 1; min-width: 0; border: 0; background: transparent; font-size: var(--text-sm); color: var(--fg); }
.bp__search input::placeholder { color: var(--fg-faint); }
.bp__search input:focus-visible { outline: none; }

.bp__scroll { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-1); }
.bp__sep { flex: none; height: 1px; margin: var(--space-1) var(--space-2); background: var(--line-soft); }

.bp__item {
  --depth: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 30px;
  padding: 4px var(--space-2) 4px calc(var(--space-2) + var(--depth) * 16px);
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--fg);
}
.bp__item.is-active:not(:disabled) { background: var(--bg-active); }
.bp-sub .bp__item:hover:not(:disabled), .bp-sub .bp__item:focus-visible { background: var(--bg-hover); outline: none; }
.bp__item:disabled { color: var(--fg-faint); }
.bp__item:disabled svg { color: var(--fg-faint); }
.bp__item.is-danger:not(:disabled), .bp__item.is-danger:not(:disabled) svg { color: var(--ripe-error-fg); }

.bp__icon { width: 16px; display: grid; place-items: center; flex: none; color: var(--fg-subtle); }
.bp__icon svg { width: 15px; height: 15px; stroke-width: 1.75; }
.bp__label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bp__label--mono, .bp__mono { font-family: var(--font-mono); font-size: var(--text-xs); }
.bp__n { flex: none; padding: 0 5px; border-radius: var(--radius-pill); background: var(--bg-active); font-size: var(--text-2xs); color: var(--fg); }

.bp__fold-row { position: relative; display: flex; align-items: center; }
.bp__fold-row .bp__row-btn { position: absolute; right: 4px; opacity: 0; }
.bp__fold-row:hover .bp__row-btn, .bp__fold-row.is-active .bp__row-btn, .bp__row-btn:focus-visible { opacity: 1; }
.bp__fold-row:has(.bp__row-btn) .bp__item--fold { padding-right: 32px; }
.bp__fold-row .bp__row-btn:hover:not(:disabled) { color: var(--ripe-error-fg); }
.bp__item--fold { min-height: 28px; color: var(--fg-muted); }
.bp__item--section { font-weight: 560; }
.bp__caret { width: 13px; height: 13px; flex: none; stroke-width: 2; color: var(--fg-faint); }
.bp__folder { width: 14px; height: 14px; flex: none; stroke-width: 1.75; color: var(--fg-subtle); }
.bp__count { flex: none; font-size: var(--text-2xs); color: var(--fg-faint); }

/* Branch rows line their icon up with the folder icons beside them (caret 13px + gap 8px). */
.bp__item--branch { padding-left: calc(var(--space-2) + 21px + var(--depth) * 16px); color: var(--fg-muted); }
.bp__item--branch.is-active, .bp__item--branch.is-current { color: var(--fg); }
.bp__item--branch.is-current .bp__label { font-weight: 600; }
.bp__branch-icon { width: 14px; height: 14px; flex: none; stroke-width: 1.75; color: var(--fg-faint); }
.bp__branch-icon--current { color: var(--accent-ink); stroke-width: 2.25; }
.bp__track { flex: none; display: inline-flex; align-items: center; gap: 1px; font-size: var(--text-2xs); color: var(--fg-subtle); }
.bp__track svg { width: 11px; height: 11px; }
.bp__upstream {
  flex: 0 1 auto;
  max-width: 45%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--fg-faint);
}
.bp__more { width: 13px; height: 13px; flex: none; stroke-width: 2; color: var(--fg-faint); }
.bp__item--branch.is-active .bp__more { color: var(--fg-subtle); }

.bp__empty { margin: 0; padding: var(--space-4) var(--space-3); font-size: var(--text-xs); color: var(--fg-subtle); }

.bp-sub__head { padding: var(--space-2) var(--space-2) var(--space-1); }
.bp-sub__name { font-family: var(--font-mono); font-size: var(--text-xs); font-weight: 600; color: var(--fg); overflow-wrap: anywhere; }
.bp-sub__meta { display: flex; flex-wrap: wrap; gap: 2px var(--space-2); margin-top: 2px; font-size: var(--text-2xs); color: var(--fg-subtle); }
.bp-sub__subject { margin: var(--space-1) 0 0; font-size: var(--text-xs); color: var(--fg-subtle); overflow-wrap: anywhere; }

.bp__form { display: grid; gap: var(--space-2); padding: var(--space-3); }
.bp__form-title { margin: 0; font-size: var(--text-sm); font-weight: 560; color: var(--fg); overflow-wrap: anywhere; }
.bp__input {
  height: 30px;
  width: 100%;
  padding: 0 var(--space-2);
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.bp__input:focus-visible { outline: none; border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.bp__hint { margin: 0; font-size: var(--text-xs); color: var(--fg-subtle); }
.bp__names {
  margin: 0;
  padding: var(--space-1) var(--space-2);
  max-height: 160px;
  overflow-y: auto;
  list-style: none;
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  color: var(--fg-muted);
}
.bp__names li { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.7; }
.bp__names-note { font-family: var(--font-ui); font-size: var(--text-xs); color: var(--fg-muted); }
.bp__reading { display: flex; align-items: center; gap: var(--space-2); }
.bp__note { display: flex; align-items: flex-start; gap: var(--space-2); margin: 0; font-size: var(--text-xs); line-height: 1.5; color: var(--fg-muted); }
.bp__note svg { width: 14px; height: 14px; flex: none; margin-top: 2px; stroke-width: 1.85; color: var(--ripe-waiting-fg); }
.bp__form-actions { display: flex; gap: var(--space-2); margin-top: var(--space-1); }

.bp__msg {
  flex: none;
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  max-height: 140px;
  overflow: auto;
  padding: var(--space-2) var(--space-3) var(--space-3);
  border-top: 1px solid var(--line-soft);
}
.bp__msg-icon { width: 15px; height: 15px; flex: none; margin-top: 2px; stroke-width: 1.85; color: var(--ripe-queued-fg); }
.bp__msg.is-error .bp__msg-icon { color: var(--ripe-error-fg); }
.bp__msg-body { flex: 1; min-width: 0; }
.bp__msg-title { margin: 0; font-size: var(--text-sm); font-weight: 560; line-height: 1.45; color: var(--fg); overflow-wrap: anywhere; }
.bp__msg-detail {
  margin: 2px 0 0;
  font-size: var(--text-xs);
  line-height: 1.5;
  color: var(--fg-subtle);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* Failures keep git's own words (paths, commands), so the detail reads as output. */
.bp__msg.is-error .bp__msg-title { color: var(--ripe-error-fg); }
.bp__msg.is-error .bp__msg-detail { font-family: var(--font-mono); color: var(--fg-muted); }

.bp__spin {
  width: 12px;
  height: 12px;
  flex: none;
  border-radius: 50%;
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  animation: bp-spin 0.8s linear infinite;
}
@keyframes bp-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .bp__spin { animation-duration: 2s; }
}
</style>
