<script setup lang="ts">
import {
  ArrowDown, ArrowDownToLine, ArrowUp, Check, CloudDownload, CloudUpload, GitBranch, GitBranchPlus, GitMerge,
  ListCheck, LogIn, Pencil, Search, Trash2, Waypoints,
} from 'lucide-vue-next'
import type { GitBranchList, GitLocalBranch, GitRemoteBranch } from '~/types/ipc'
import { call } from '~/composables/useBackend'
import { useWorkspace } from '~/stores/workspace'
import { useGit } from '~/stores/git'
import { shortAgo } from '~/utils/time'

/**
 * Branch popup in the manner of JetBrains IDEs: search, quick actions for the
 * current branch, local and remote branches, and per-branch actions
 * (checkout, new branch from, merge, rebase, rename, delete).
 * Wraps its trigger (default slot) and opens under it.
 */
const props = defineProps<{ path: string | null }>()

const ws = useWorkspace()
const git = useGit()

const open = ref(false)
const root = ref<HTMLElement | null>(null)
const pop = ref<HTMLElement | null>(null)
const search = ref<HTMLInputElement | null>(null)
const pos = ref({ left: 0, top: 0, maxHeight: 520 })

const list = ref<GitBranchList | null>(null)
const loading = ref(false)
const query = ref('')

type Row = { key: string; kind: 'local'; b: GitLocalBranch } | { key: string; kind: 'remote'; b: GitRemoteBranch }
const selectedKey = ref<string | null>(null)

/** What the right-hand pane shows for the selected branch. */
const mode = ref<'actions' | 'new' | 'rename' | 'delete'>('actions')
const nameInput = ref('')
const nameField = ref<HTMLInputElement | null>(null)
const busy = ref<string | null>(null)
const message = ref<{ error: boolean; text: string } | null>(null)
/** Delete was refused because the branch has unmerged commits: offer to force it. */
const unmerged = ref(false)

const current = computed(() => list.value?.current ?? null)

const matches = (name: string) => {
  const q = query.value.trim().toLowerCase()
  return !q || name.toLowerCase().includes(q)
}
const locals = computed<Row[]>(() => (list.value?.local ?? []).filter(b => matches(b.name)).map(b => ({ key: `l:${b.name}`, kind: 'local' as const, b })))
const remotes = computed<Row[]>(() => (list.value?.remote ?? []).filter(b => matches(b.name)).map(b => ({ key: `r:${b.name}`, kind: 'remote' as const, b })))
const rows = computed<Row[]>(() => [...locals.value, ...remotes.value])
const selected = computed(() => rows.value.find(r => r.key === selectedKey.value) ?? null)
const currentBranch = computed(() => list.value?.local.find(b => b.isCurrent) ?? null)

watch(rows, (all) => {
  if (!all.some(r => r.key === selectedKey.value)) selectedKey.value = (all.find(r => r.kind === 'local' && r.b.isCurrent) ?? all[0])?.key ?? null
})
watch(selectedKey, () => { mode.value = 'actions'; unmerged.value = false })

/* ---------- open / close / position ---------- */

function place() {
  const el = root.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const width = Math.min(620, window.innerWidth - 16)
  pos.value = {
    left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
    top: r.bottom + 6,
    maxHeight: Math.max(240, window.innerHeight - r.bottom - 24),
  }
}

async function load() {
  if (!props.path) return
  loading.value = true
  try {
    list.value = await call('git_branch_list', { path: props.path })
  } catch (e) {
    message.value = { error: true, text: reason(e) }
  } finally {
    loading.value = false
  }
}

async function show() {
  if (!props.path) return
  place()
  open.value = true
  query.value = ''
  message.value = null
  mode.value = 'actions'
  selectedKey.value = null
  void load()
  await nextTick()
  place()
  search.value?.focus()
}
function close() {
  open.value = false
}
function toggle() {
  open.value ? close() : show()
}

function onDocDown(e: MouseEvent) {
  if (!open.value) return
  const t = e.target as Node
  if (root.value?.contains(t) || pop.value?.contains(t)) return
  close()
}
function onResize() { if (open.value) place() }
onMounted(() => {
  document.addEventListener('mousedown', onDocDown, true)
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocDown, true)
  window.removeEventListener('resize', onResize)
})

/* ---------- running things ---------- */

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).trim()

/** Run a git action, show what it said, and bring every view of the repository up to date. */
async function run<T>(id: string, action: () => Promise<T>, done?: (result: T) => string | void): Promise<boolean> {
  if (busy.value || !props.path) return false
  busy.value = id
  message.value = null
  try {
    const result = await action()
    const text = done?.(result)
    if (text) message.value = { error: false, text }
    return true
  } catch (e) {
    message.value = { error: true, text: reason(e) }
    return false
  } finally {
    busy.value = null
    await Promise.all([load(), git.refresh(props.path).catch(() => {})])
  }
}

const p = () => props.path!

async function checkout(row: Row) {
  if (row.kind === 'local' && row.b.isCurrent) return
  const ok = row.kind === 'local'
    ? await run('checkout', () => call('git_checkout', { path: p(), branch: row.b.name, create: false }))
    : await run('checkout', () => call('git_checkout_remote', { path: p(), branch: row.b.name }))
  if (ok) close()
}
const update = () => run('pull', () => call('git_pull', { path: p() }), out => out || 'Already up to date.')
const fetchAll = () => run('fetch', () => call('git_fetch', { path: p() }), out => out || 'Fetched. Nothing new.')
const push = () => run('push', () => call('git_push', { path: p() }), out => out || 'Pushed.')
const merge = (row: Row) => run('merge', () => call('git_merge', { path: p(), branch: row.b.name }), out => out || `Merged ${row.b.name}.`)
const rebase = (row: Row) => run('rebase', () => call('git_rebase', { path: p(), onto: row.b.name }), out => out || `Rebased onto ${row.b.name}.`)

function commitView() {
  ws.setSidebarView('changes')
  close()
}

async function startName(kind: 'new' | 'rename') {
  mode.value = kind
  nameInput.value = kind === 'rename' && selected.value ? selected.value.b.name : ''
  message.value = null
  await nextTick()
  nameField.value?.focus()
  nameField.value?.select()
}
/** Branch names can't hold spaces; type them as dashes. */
function onNameInput(e: Event) {
  nameInput.value = (e.target as HTMLInputElement).value.replace(/\s+/g, '-')
}
async function submitName() {
  const name = nameInput.value.trim()
  const row = selected.value
  if (!name) return
  if (mode.value === 'new') {
    const from = row ? row.b.name : null
    const ok = await run('create', () => call('git_branch_create', { path: p(), name, from, checkout: true }))
    if (ok) close()
  } else if (mode.value === 'rename' && row) {
    const ok = await run('rename', () => call('git_branch_rename', { path: p(), from: row.b.name, to: name }), () => `Renamed to ${name}.`)
    if (ok) { mode.value = 'actions'; selectedKey.value = `l:${name}` }
  }
}
async function remove(force: boolean) {
  const row = selected.value
  if (!row || row.kind !== 'local') return
  const name = row.b.name
  const ok = await run('delete', () => call('git_branch_delete', { path: p(), branch: name, force }), () => `Deleted ${name}.`)
  if (ok) { mode.value = 'actions'; unmerged.value = false }
  else if (/not fully merged/i.test(message.value?.text ?? '')) {
    unmerged.value = true
    message.value = { error: true, text: `${name} has commits that are not merged into any other branch. Deleting it loses them.` }
  }
}

/* ---------- keyboard ---------- */

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    if (mode.value !== 'actions') mode.value = 'actions'
    else close()
    return
  }
  if (e.target !== search.value) return
  const all = rows.value
  const at = all.findIndex(r => r.key === selectedKey.value)
  if (e.key === 'ArrowDown') { e.preventDefault(); selectedKey.value = all[Math.min(all.length - 1, at + 1)]?.key ?? selectedKey.value }
  else if (e.key === 'ArrowUp') { e.preventDefault(); selectedKey.value = all[Math.max(0, at - 1)]?.key ?? selectedKey.value }
  else if (e.key === 'Enter' && selected.value) { e.preventDefault(); void checkout(selected.value) }
}
watch(selectedKey, async (key) => {
  if (!key) return
  await nextTick()
  pop.value?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' })
})

const now = () => Date.now()
defineExpose({ show, close })
</script>

<template>
  <div ref="root" class="bp-anchor">
    <slot :open="open" :toggle="toggle" />
    <Teleport to="body">
      <Transition name="bp">
        <div
          v-if="open"
          ref="pop"
          class="bp"
          role="dialog"
          aria-label="Branches"
          :style="{ left: `${pos.left}px`, top: `${pos.top}px`, maxHeight: `${pos.maxHeight}px` }"
          @keydown="onKey"
        >
          <div class="bp__search">
            <Search aria-hidden="true" />
            <input
              ref="search"
              v-model="query"
              type="text"
              placeholder="Search branches"
              aria-label="Search branches"
              spellcheck="false"
              autocomplete="off"
            >
            <span v-if="loading" class="bp__spin" aria-hidden="true" />
          </div>

          <!-- Quick actions for the branch you are on -->
          <div class="bp__quick" role="toolbar" aria-label="Current branch">
            <button type="button" :disabled="!!busy || !currentBranch?.upstream" :title="currentBranch?.upstream ? `Pull ${currentBranch.upstream} into ${current}` : 'This branch tracks no remote branch yet'" @click="update">
              <span v-if="busy === 'pull'" class="bp__spin" /><ArrowDownToLine v-else />Update<span v-if="currentBranch?.behind" class="bp__n tabular">{{ currentBranch.behind }}</span>
            </button>
            <button type="button" :disabled="!!busy" title="Open the Changes view to commit" @click="commitView">
              <ListCheck />Commit…
            </button>
            <button type="button" :disabled="!!busy || !list?.remotes.length" :title="currentBranch?.upstream ? `Push ${current} to ${currentBranch.upstream}` : `Publish ${current ?? 'this branch'} to the remote`" @click="push">
              <span v-if="busy === 'push'" class="bp__spin" /><CloudUpload v-else />{{ currentBranch?.upstream ? 'Push' : 'Publish' }}<span v-if="currentBranch?.ahead" class="bp__n tabular">{{ currentBranch.ahead }}</span>
            </button>
            <button type="button" :disabled="!!busy || !list?.remotes.length" title="Fetch from the remote" @click="fetchAll">
              <span v-if="busy === 'fetch'" class="bp__spin" /><CloudDownload v-else />Fetch
            </button>
            <button type="button" :disabled="!!busy" title="New branch from the selected one" @click="startName('new')">
              <GitBranchPlus />New branch…
            </button>
          </div>

          <div class="bp__body">
            <!-- Branch list -->
            <div class="bp__list" role="listbox" aria-label="Branches">
              <template v-if="locals.length">
                <div class="bp__group">Local</div>
                <button
                  v-for="r in locals"
                  :key="r.key"
                  type="button"
                  class="bp__row"
                  :class="{ 'is-selected': r.key === selectedKey, 'is-current': r.kind === 'local' && r.b.isCurrent }"
                  role="option"
                  :aria-selected="r.key === selectedKey"
                  :data-key="r.key"
                  :title="r.b.subject"
                  @click="selectedKey = r.key"
                  @dblclick="checkout(r)"
                >
                  <Check v-if="r.kind === 'local' && r.b.isCurrent" class="bp__row-icon bp__row-icon--current" />
                  <GitBranch v-else class="bp__row-icon" />
                  <span class="bp__row-name">{{ r.b.name }}</span>
                  <span v-if="r.kind === 'local' && (r.b.ahead || r.b.behind)" class="bp__track tabular">
                    <template v-if="r.b.ahead"><ArrowUp />{{ r.b.ahead }}</template>
                    <template v-if="r.b.behind"><ArrowDown />{{ r.b.behind }}</template>
                  </span>
                </button>
              </template>
              <template v-if="remotes.length">
                <div class="bp__group">Remote</div>
                <button
                  v-for="r in remotes"
                  :key="r.key"
                  type="button"
                  class="bp__row"
                  :class="{ 'is-selected': r.key === selectedKey }"
                  role="option"
                  :aria-selected="r.key === selectedKey"
                  :data-key="r.key"
                  :title="r.b.subject"
                  @click="selectedKey = r.key"
                  @dblclick="checkout(r)"
                >
                  <Waypoints class="bp__row-icon" />
                  <span class="bp__row-name">{{ r.b.name }}</span>
                </button>
              </template>
              <p v-if="!rows.length" class="bp__empty">
                {{ loading ? 'Reading branches…' : query.trim() ? `No branch matches “${query.trim()}”.` : 'No branches yet.' }}
              </p>
            </div>

            <!-- Actions for the selected branch -->
            <div class="bp__detail">
              <template v-if="mode === 'new'">
                <form class="bp__form" @submit.prevent="submitName">
                  <label class="bp__label" for="bp-name">New branch{{ selected ? ` from ${selected.b.name}` : '' }}</label>
                  <input id="bp-name" ref="nameField" :value="nameInput" class="bp__input" placeholder="branch-name" spellcheck="false" autocomplete="off" @input="onNameInput">
                  <p class="bp__hint">Created and checked out right away.</p>
                  <div class="bp__form-actions">
                    <UiButton size="sm" variant="primary" type="submit" :loading="busy === 'create'" :disabled="!nameInput.trim()">Create</UiButton>
                    <UiButton size="sm" variant="ghost" @click="mode = 'actions'">Cancel</UiButton>
                  </div>
                </form>
              </template>

              <template v-else-if="mode === 'rename' && selected">
                <form class="bp__form" @submit.prevent="submitName">
                  <label class="bp__label" for="bp-rename">Rename {{ selected.b.name }}</label>
                  <input id="bp-rename" ref="nameField" :value="nameInput" class="bp__input" spellcheck="false" autocomplete="off" @input="onNameInput">
                  <div class="bp__form-actions">
                    <UiButton size="sm" variant="primary" type="submit" :loading="busy === 'rename'" :disabled="!nameInput.trim() || nameInput.trim() === selected.b.name">Rename</UiButton>
                    <UiButton size="sm" variant="ghost" @click="mode = 'actions'">Cancel</UiButton>
                  </div>
                </form>
              </template>

              <template v-else-if="mode === 'delete' && selected">
                <div class="bp__form">
                  <p class="bp__label">Delete {{ selected.b.name }}?</p>
                  <p class="bp__hint">Only the local branch is removed. The remote branch, if any, stays.</p>
                  <div class="bp__form-actions">
                    <UiButton size="sm" variant="danger" :loading="busy === 'delete'" data-autofocus @click="remove(unmerged)">{{ unmerged ? 'Delete anyway' : 'Delete' }}</UiButton>
                    <UiButton size="sm" variant="ghost" @click="mode = 'actions'">Cancel</UiButton>
                  </div>
                </div>
              </template>

              <template v-else-if="selected">
                <div class="bp__head">
                  <div class="bp__title">{{ selected.b.name }}</div>
                  <div class="bp__meta">
                    <template v-if="selected.kind === 'local'">
                      <span v-if="selected.b.isCurrent">Current branch</span>
                      <span v-if="selected.b.upstream">{{ selected.b.upstreamGone ? `${selected.b.upstream} (deleted on remote)` : `tracks ${selected.b.upstream}` }}</span>
                      <span v-else>not published</span>
                    </template>
                    <span v-else>on {{ selected.b.remote }}</span>
                    <span v-if="selected.b.time" class="tabular">{{ shortAgo(selected.b.time, now()) }} ago</span>
                  </div>
                  <p v-if="selected.b.subject" class="bp__subject">{{ selected.b.subject }}</p>
                </div>

                <div class="bp__actions" role="menu">
                  <template v-if="!(selected.kind === 'local' && selected.b.isCurrent)">
                    <button type="button" role="menuitem" :disabled="!!busy" @click="checkout(selected)">
                      <span v-if="busy === 'checkout'" class="bp__spin" /><LogIn v-else />Checkout<kbd>Enter</kbd>
                    </button>
                  </template>
                  <button type="button" role="menuitem" :disabled="!!busy" @click="startName('new')">
                    <GitBranchPlus />New branch from {{ selected.b.name }}…
                  </button>
                  <template v-if="!(selected.kind === 'local' && selected.b.isCurrent) && current">
                    <button type="button" role="menuitem" :disabled="!!busy" @click="merge(selected)">
                      <span v-if="busy === 'merge'" class="bp__spin" /><GitMerge v-else />Merge into {{ current }}
                    </button>
                    <button type="button" role="menuitem" :disabled="!!busy" @click="rebase(selected)">
                      <span v-if="busy === 'rebase'" class="bp__spin" /><Waypoints v-else />Rebase {{ current }} onto this
                    </button>
                  </template>
                  <template v-if="selected.kind === 'local'">
                    <div class="bp__sep" role="separator" />
                    <button type="button" role="menuitem" :disabled="!!busy" @click="startName('rename')">
                      <Pencil />Rename…
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      class="is-danger"
                      :disabled="!!busy || selected.b.isCurrent"
                      :title="selected.b.isCurrent ? 'Switch to another branch first' : undefined"
                      @click="mode = 'delete'; unmerged = false; message = null"
                    >
                      <Trash2 />Delete…
                    </button>
                  </template>
                </div>
              </template>

              <p v-else class="bp__empty">Select a branch to see what you can do with it.</p>
            </div>
          </div>

          <pre v-if="message" class="bp__msg selectable" :class="{ 'is-error': message.error }" :role="message.error ? 'alert' : 'status'">{{ message.text }}</pre>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.bp-anchor { display: inline-flex; min-width: 0; }
</style>

<!-- The popup is teleported to <body>, outside this component's scoped subtree. -->
<style>
.bp {
  position: fixed;
  z-index: 80;
  width: min(620px, calc(100vw - 16px));
  display: flex;
  flex-direction: column;
  background: var(--bg-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-pop);
  overflow: hidden;
  font-size: var(--text-sm);
}
.bp-enter-active, .bp-leave-active { transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out); transform-origin: top left; }
.bp-enter-from, .bp-leave-to { opacity: 0; transform: scale(0.98) translateY(-2px); }

.bp__search {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 40px;
  padding: 0 var(--space-3);
  border-bottom: 1px solid var(--line-soft);
}
.bp__search svg { width: 15px; height: 15px; color: var(--fg-subtle); flex: none; }
.bp__search input { flex: 1; min-width: 0; border: 0; background: transparent; font-size: var(--text-md); color: var(--fg); }
.bp__search input::placeholder { color: var(--fg-faint); }
.bp__search input:focus-visible { outline: none; }

.bp__quick {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--line-soft);
}
.bp__quick button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  font-weight: 540;
  color: var(--fg-muted);
  white-space: nowrap;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.bp__quick button:hover:not(:disabled) { background: var(--bg-hover); color: var(--fg); }
.bp__quick button:disabled { color: var(--fg-faint); }
.bp__quick svg { width: 14px; height: 14px; stroke-width: 1.75; }
.bp__n { padding: 0 5px; border-radius: var(--radius-pill); background: var(--bg-active); font-size: var(--text-2xs); color: var(--fg); }

.bp__body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 250px; }
.bp__list { min-height: 180px; max-height: 380px; overflow-y: auto; padding: var(--space-1); border-right: 1px solid var(--line-soft); }
.bp__group { padding: var(--space-2) var(--space-2) 2px; font-size: var(--text-2xs); font-weight: 600; color: var(--fg-subtle); }
.bp__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 28px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--fg-muted);
}
.bp__row:hover { background: var(--bg-hover); }
.bp__row.is-selected { background: var(--bg-active); color: var(--fg); }
.bp__row.is-current .bp__row-name { color: var(--fg); font-weight: 600; }
.bp__row-icon { width: 14px; height: 14px; flex: none; stroke-width: 1.75; color: var(--fg-faint); }
.bp__row-icon--current { color: var(--accent-ink); stroke-width: 2.25; }
.bp__row-name { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bp__track { flex: none; display: inline-flex; align-items: center; gap: 1px; font-size: var(--text-2xs); color: var(--fg-subtle); }
.bp__track svg { width: 11px; height: 11px; }
.bp__empty { margin: 0; padding: var(--space-4) var(--space-3); font-size: var(--text-xs); color: var(--fg-subtle); }

.bp__detail { min-width: 0; max-height: 380px; overflow-y: auto; padding: var(--space-3); }
.bp__title { font-family: var(--font-mono); font-size: var(--text-sm); font-weight: 600; color: var(--fg); overflow-wrap: anywhere; }
.bp__meta { display: flex; flex-wrap: wrap; gap: 2px var(--space-2); margin-top: 2px; font-size: var(--text-2xs); color: var(--fg-subtle); }
.bp__subject { margin: var(--space-2) 0 0; font-size: var(--text-xs); color: var(--fg-subtle); overflow-wrap: anywhere; }
.bp__actions { display: grid; gap: 1px; margin: var(--space-3) calc(var(--space-2) * -1) 0; }
.bp__actions button {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 30px;
  padding: 4px var(--space-2);
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--fg);
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}
.bp__actions button:hover:not(:disabled) { background: var(--bg-hover); }
.bp__actions button:disabled { color: var(--fg-faint); }
.bp__actions button svg { width: 15px; height: 15px; flex: none; stroke-width: 1.75; color: var(--fg-subtle); }
.bp__actions button.is-danger:not(:disabled) { color: var(--ripe-error-fg); }
.bp__actions button.is-danger:not(:disabled) svg { color: inherit; }
.bp__actions kbd { margin-left: auto; }
.bp__sep { height: 1px; margin: var(--space-1) var(--space-2); background: var(--line-soft); }

.bp__form { display: grid; gap: var(--space-2); }
.bp__label { margin: 0; font-size: var(--text-xs); font-weight: 560; color: var(--fg-muted); overflow-wrap: anywhere; }
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
.bp__form-actions { display: flex; gap: var(--space-2); margin-top: var(--space-1); }

.bp__msg {
  flex: none;
  margin: 0;
  max-height: 120px;
  overflow: auto;
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--line-soft);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.5;
  color: var(--fg-muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.bp__msg.is-error { color: var(--ripe-error-fg); }

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

@media (max-width: 620px) {
  .bp__body { grid-template-columns: 1fr; }
  .bp__list { border-right: 0; border-bottom: 1px solid var(--line-soft); max-height: 200px; }
}
</style>
