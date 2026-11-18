<script setup lang="ts">
import {
  CircleArrowUp, Columns2, Globe, Download, FlaskConical, Gauge, Folder, FolderOpen, FolderPlus, GitBranch, GitFork, GitPullRequest, Laptop, MessageSquarePlus, Settings,
  FolderCog, FileKey, FolderGit2, Files, Link2, Moon, PanelBottom, PanelLeft, PanelTop, Search, Plug, Server, SquareTerminal, Sun, History, AppWindow,
} from 'lucide-vue-next'
import type { Component } from 'vue'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { useUpdater } from '~/stores/updater'
import { useEnvironments } from '~/stores/environments'
import { useBrowser } from '~/stores/browser'
import { useWindows } from '~/stores/windows'
import { AGENTS, hasUnreadResult } from '~/types/chat'
import { openLocalFolder } from '~/composables/useShortcuts'
import type { ThreadStatus } from '~/types/chat'
import { useOverlay } from '~/composables/useOverlay'
import { useWorktrees } from '~/composables/useWorktrees'
import { parseTerminalTab } from '~/utils/terminalTabs'

/**
 * Mod+K command palette: actions, every thread in the open projects, and
 * recent projects, filtered with a forgiving subsequence match.
 */
const ws = useWorkspace()
const threads = useThreads()
const envs = useEnvironments()
const wts = useWorktrees()
const win = useWindows()
useOverlay(() => ws.paletteOpen)

/** Environments known to be usable right now (from what the store already has). */
function knownPlaces() {
  const out: Array<{ hostId: string; instance: string }> = []
  for (const h of envs.servers) {
    for (const i of envs.instances[h.id] ?? []) if (envState(h.id, i.name).tone === 'ready') out.push({ hostId: h.id, instance: i.name })
  }
  for (const h of envs.joined) {
    if (envState(h.id, h.direct!.instance).tone !== 'bad') out.push({ hostId: h.id, instance: h.direct!.instance })
  }
  return out
}

type Group = 'Actions' | 'Threads' | 'Projects'

interface Item {
  id: string
  group: Group
  label: string
  /** secondary text after the label */
  detail?: string
  icon?: Component
  status?: ThreadStatus
  unseen?: boolean
  keys?: string[]
  /** short state tag, e.g. "Current" */
  badge?: string
  /** extra words that match but aren't shown */
  keywords?: string
  /** order among equals when the query is empty */
  rank?: number
  run: () => unknown
}

interface Scored extends Item { score: number; hits: number[] }

const query = ref('')
const selected = ref(0)
const runError = ref<string | null>(null)
const input = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)
let returnFocus: HTMLElement | null = null
/** error from a command that ran after the palette closed; shown when it reopens */
let carryError: string | null = null

const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
const mod = modLabel()
const shift = isMac ? '⇧' : 'Shift'
const alt = isMac ? '⌥' : 'Alt'

const tildify = (path: string) => path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~')
function errorText(e: unknown): string {
  if (typeof e === 'string') return e
  if (e instanceof Error) return e.message
  try { return JSON.stringify(e) } catch { return String(e) }
}

/* ---------- items ---------- */

const actions = computed<Item[]>(() => {
  const project = ws.activeProjectPath
  const inWorkspace = ws.hasProject
  const dark = ws.resolvedTheme() === 'dark'
  const items: Item[] = []
  if (project) {
    items.push({ id: 'new-chat', group: 'Actions', label: 'New chat', detail: ws.activeProject?.name, icon: MessageSquarePlus, keys: [mod, 'N'], keywords: 'thread conversation agent', run: () => threads.create(project) })
    if (wts.supported.value) {
      items.push({ id: 'new-worktree-chat', group: 'Actions', label: `New chat in a ${wts.term.value}`, detail: 'Its own folder and branch, named from your first message', icon: FolderGit2, keys: [mod, shift, 'N'], keywords: 'worktree workspace parallel branch isolated new chat thread git unity', run: () => threads.createAwaitingWorktree(project) })
      for (const w of wts.linked.value) {
        if (w.prunable) continue
        items.push({ id: `worktree:${w.path}`, group: 'Actions', label: `Go to ${wts.term.value} ${wts.label(w)}`, detail: wts.hint(w), icon: FolderGit2, keywords: `worktree workspace switch ${w.branch ?? ''}`, run: () => wts.goTo(w) })
      }
    }
    items.push({ id: 'new-browser', group: 'Actions', label: 'New browser tab', detail: ws.activeProject?.name, icon: Globe, keys: [mod, shift, 'B'], keywords: 'browser web page url localhost preview dev server open site', run: () => useBrowser().openNew() })
  }
  // With environments around, say where these put the project (the remembered choice).
  const where = projectWhere()
  const whereDetail = envs.hosts.length ? (where ? envLabels(where.hostId, where.instance).where : 'This computer') : undefined
  // Another window: on this project (it moves there), or a new one on the welcome screen.
  if (project && (win.isMain || ws.openProjects.length > 1)) {
    const blocked = win.moveBlocker(project)
    items.push({ id: 'project-window', group: 'Actions', label: 'Open project in new window', detail: blocked?.hint ?? ws.activeProject?.name, icon: AppWindow, keywords: 'window move separate detach second monitor screen', run: () => win.openInNewWindow(project) })
  }
  items.push({ id: 'new-window', group: 'Actions', label: 'New window', icon: AppWindow, keys: [mod, alt, 'N'], keywords: 'window open another second monitor screen', run: () => win.openInNewWindow(null) })
  items.push(
    { id: 'open-folder', group: 'Actions', label: 'Open folder…', detail: whereDetail, icon: FolderOpen, keys: [mod, 'O'], keywords: 'project directory', run: openFolderFlow },
    { id: 'new-project', group: 'Actions', label: 'New project…', detail: whereDetail, icon: FolderPlus, keywords: 'create folder init', run: () => { ws.dialog = 'new' } },
    { id: 'clone', group: 'Actions', label: 'Clone repository…', detail: whereDetail, icon: GitFork, keywords: 'git github remote', run: () => { ws.dialog = 'clone' } },
  )
  // Straight into a known, usable environment: open a folder there (and make it the place for the next one).
  if (where) {
    items.push({ id: 'open-folder-local', group: 'Actions', label: 'Open folder on this computer…', icon: Laptop, keywords: 'project directory local disk', run: () => { ws.setWhere(null); return openLocalFolder() } })
  }
  for (const p of knownPlaces()) {
    if (samePlace(p, where)) continue
    const l = envLabels(p.hostId, p.instance)
    items.push({
      id: `open-folder-env:${p.hostId}/${p.instance}`,
      group: 'Actions',
      label: `Open folder in ${l.label}…`,
      detail: l.shared ? 'Shared with you' : l.host,
      icon: Server,
      keywords: `project directory remote environment ${l.where}`,
      run: () => { ws.setWhere(p); ws.dialog = 'open-env' },
    })
  }
  items.push(
    { id: 'environments', group: 'Actions', label: 'Environments', detail: 'Remote containers and VMs', icon: Server, keywords: 'remote environment server ssh incus container vm instance cloud machine', run: () => envs.openView() },
    { id: 'join-env', group: 'Actions', label: 'Join a shared environment', detail: 'With a link someone sent you', icon: Link2, keywords: 'join share shared link invite remote environment mango://join paste qr', run: () => envs.openJoin() },
  )
  if (inWorkspace) {
    // Move the terminal in view between the panel and the main area.
    const paneTerm = parseTerminalTab(threads.activePane.threadId)?.terminalId
    if (paneTerm) items.push({ id: 'terminal-to-panel', group: 'Actions', label: 'Move terminal to panel', icon: PanelBottom, keywords: 'terminal shell dock bottom panel editor tab', run: () => ws.moveTerminalToPanel(paneTerm) })
    const panelTerm = ws.terminalOpen ? ws.activeTerminalId : null
    if (panelTerm) items.push({ id: 'terminal-to-editor', group: 'Actions', label: 'Move terminal to editor area', icon: PanelTop, keywords: 'terminal shell tab main pane editor area undock', run: () => ws.moveTerminalToEditor(panelTerm) })
    items.push(
      { id: 'toggle-terminal', group: 'Actions', label: ws.terminalOpen ? 'Hide terminal' : 'Show terminal', icon: PanelBottom, keys: [mod, '`'], keywords: 'toggle terminal shell panel console', run: () => ws.toggleTerminal() },
      { id: 'new-terminal', group: 'Actions', label: 'New terminal', icon: SquareTerminal, keys: [mod, shift, 'T'], keywords: 'shell tab console', run: () => ws.newTerminal() },
      { id: 'new-terminal-editor', group: 'Actions', label: 'New terminal in editor area', icon: SquareTerminal, keywords: 'shell tab console main pane editor', run: () => ws.newTerminal(undefined, undefined, true) },
      { id: 'toggle-env', group: 'Actions', label: ws.toolPanel === 'env' ? 'Hide environment' : 'Show environment', keys: [mod, 'Shift', 'H'], detail: remotePlace(ws.activeProjectPath)?.where ?? 'This computer', icon: remotePlace(ws.activeProjectPath) ? Server : Laptop, keywords: 'environment where runs remote local computer instance server shell desktop sign in components', run: () => ws.toggleEnv() },
      { id: 'toggle-files', group: 'Actions', label: ws.toolPanel === 'files' ? 'Hide files' : 'Show files', icon: Files, keys: [mod, 'Shift', 'E'], keywords: 'files explorer tree folder browse open edit editor', run: () => ws.toggleFiles() },
      { id: 'toggle-git', group: 'Actions', label: ws.toolPanel === 'changes' ? 'Hide changes' : 'Show changes', icon: GitBranch, keys: [mod, 'Shift', 'G'], keywords: 'git source control changes diff commit push pull', run: () => ws.toggleGit() },
      { id: 'toggle-links', group: 'Actions', label: ws.toolPanel === 'links' ? 'Hide pull requests' : 'Show pull requests', icon: GitPullRequest, keys: [mod, 'Shift', 'P'], keywords: 'pull request pr issue github linked link', run: () => ws.toggleLinks() },
      { id: 'toggle-sidebar', group: 'Actions', label: ws.sidebarOpen ? 'Hide sidebar' : 'Show sidebar', icon: PanelLeft, keys: [mod, 'B'], keywords: 'toggle sidebar rail threads', run: () => ws.toggleSidebar() },
      threads.isSplit
        ? { id: 'split', group: 'Actions', label: 'Close split pane', icon: Columns2, keys: [mod, '\\'], keywords: 'split unsplit pane', run: () => threads.closePane(threads.activePaneId) }
        : { id: 'split', group: 'Actions', label: 'Split chat right', icon: Columns2, keys: [mod, '\\'], keywords: 'split pane side by side', run: () => threads.split() },
    )
  }
  if (ws.activeProject) {
    // Names only: what is in the files never reaches the palette.
    items.push(
      { id: 'project-settings', group: 'Actions', label: 'Project settings', detail: ws.activeProject.name, icon: FolderCog, keywords: 'project settings preferences configure name icon color pin archive agent model permissions env environment variables dotenv', run: () => ws.openSettings('projects') },
      { id: 'project-env', group: 'Actions', label: 'Environment variables', detail: ws.activeProject.name, icon: FileKey, keywords: 'env dotenv .env file variables secrets keys api key token config environment project settings', run: () => ws.openProjectEnv() },
      { id: 'project-mcp', group: 'Actions', label: 'Project MCP servers', detail: ws.activeProject.name, icon: Plug, keywords: 'mcp model context protocol servers tools project unity', run: () => ws.openProjectMcp() },
    )
  }
  items.push({ id: 'settings-mcp', group: 'Actions', label: 'MCP servers', icon: Plug, keywords: 'mcp model context protocol servers tools add server claude codex', run: () => ws.openSettings('mcp') })
  items.push({ id: 'settings-terminal', group: 'Actions', label: 'Terminal settings', icon: SquareTerminal, keywords: 'terminal shell bash zsh fish powershell cmd wsl git bash profile font cursor default', run: () => ws.openSettings('terminal') })
  const up = useUpdater()
  items.push(up.update
    ? { id: 'update', group: 'Actions', label: `Update to ${up.update.version} and restart`, icon: CircleArrowUp, keywords: 'update upgrade new version release install restart', run: () => up.install() }
    : { id: 'update', group: 'Actions', label: 'Check for updates', icon: CircleArrowUp, keywords: 'update upgrade new version release', run: () => { ws.openSettings('maintenance'); up.check(true) } })
  items.push({ id: 'usage', group: 'Actions', label: 'Usage limits', detail: '5-hour and weekly', icon: Gauge, keys: [mod, shift, 'U'], keywords: 'usage limits quota rate limit plan weekly 5-hour five hour session reset claude codex', run: () => ws.openUsage() })
  items.push({ id: 'setup', group: 'Actions', label: 'Get started', detail: 'Install and sign in to agents', icon: Download, keywords: 'setup install onboarding first run claude code codex git cli agents download sign in login', run: () => ws.openSetup() })
  items.push({ id: 'changelog', group: 'Actions', label: 'Changelog', icon: History, keywords: 'changelog release notes what is new whats new versions history', run: () => ws.openSettings('changelog') })
  items.push({ id: 'settings', group: 'Actions', label: 'Open settings', icon: Settings, keys: [mod, ','], keywords: 'settings preferences agents sign in login account claude codex', run: () => ws.openSettings() })
  items.push({
    id: 'theme',
    group: 'Actions',
    label: dark ? 'Switch to light theme' : 'Switch to dark theme',
    icon: dark ? Sun : Moon,
    keywords: 'theme appearance dark light mode color',
    run: () => ws.cycleTheme(),
  })
  if (project) {
    items.push({ id: 'demo', group: 'Actions', label: 'Load demo threads', detail: ws.activeProject?.name, icon: FlaskConical, keywords: 'sample example seed', run: () => threads.loadDemo(project) })
  }
  return items.map((it, i) => ({ ...it, rank: i }))
})

const threadItems = computed<Item[]>(() => {
  const many = ws.openProjects.length > 1
  return ws.openProjects
    .flatMap(p => threads.forProject(p.path).map(t => ({ t, p })))
    .sort((a, b) => b.t.updatedAt - a.t.updatedAt)
    .map(({ t, p }, i) => ({
      id: `thread:${t.id}`,
      group: 'Threads' as const,
      label: t.title,
      detail: many ? `${AGENTS[t.agent].name} · ${p.name}` : AGENTS[t.agent].name,
      status: t.status,
      unseen: t.status === 'waiting' || hasUnreadResult(t),
      keywords: `${AGENTS[t.agent].name} ${p.name} ${t.model}`,
      rank: i,
      run: () => {
        if (ws.activeProjectPath !== t.projectPath) ws.setActiveProject(t.projectPath)
        threads.show(t.id)
      },
    }))
})

const projectItems = computed<Item[]>(() =>
  ws.listedRecent.map((p, i) => {
    const isOpen = ws.openProjects.some(o => o.path === p.path)
    const current = p.path === ws.activeProjectPath
    const elsewhere = !!win.projectElsewhere(p.path)
    // A remote project: where it runs, then its folder inside the instance.
    const remote = remotePlace(p.path)
    return {
      id: `project:${p.path}`,
      group: 'Projects' as const,
      label: p.name,
      detail: remote ? `${remote.where} · ${remote.dir}` : tildify(p.path),
      icon: remote ? Server : Folder,
      badge: current ? 'Current' : isOpen ? 'Open' : elsewhere ? 'Other window' : undefined,
      keywords: remote ? `${remote.where} ${remote.dir} remote environment` : `${p.path} ${p.branch ?? ''}`,
      rank: i,
      run: async () => {
        if (isOpen) ws.setActiveProject(p.path)
        else await ws.openProject(p.path)
      },
    }
  }),
)

/* ---------- matching ---------- */

const isBoundary = (s: string, i: number) => {
  if (i === 0) return true
  const prev = s[i - 1]!
  const ch = s[i]!
  return /[\s\-_./:·]/.test(prev) || (prev === prev.toLowerCase() && ch !== ch.toLowerCase())
}

/** Subsequence match with bonuses for word starts and runs. Tries every start for the first char. */
function fuzzy(q: string, text: string): { score: number; hits: number[] } | null {
  const t = text.toLowerCase()
  if (!q) return { score: 0, hits: [] }
  let best: { score: number; hits: number[] } | null = null
  let start = t.indexOf(q[0]!)
  while (start !== -1) {
    const hits = [start]
    let score = isBoundary(text, start) ? 8 : 1
    if (start === 0) score += 4
    let pos = start
    let ok = true
    for (let qi = 1; qi < q.length; qi++) {
      const ch = q[qi]!
      // Prefer the very next char, then the next word start, then any later match.
      let next = -1
      if (t[pos + 1] === ch) next = pos + 1
      else {
        let any = -1
        for (let j = pos + 1; j < t.length; j++) {
          if (t[j] !== ch) continue
          if (any === -1) any = j
          if (isBoundary(text, j)) { next = j; break }
        }
        if (next === -1) next = any
      }
      if (next === -1) { ok = false; break }
      if (next === pos + 1) score += 6
      else if (isBoundary(text, next)) score += 5
      else score += 1
      score -= Math.min(3, (next - pos - 1) * 0.15)
      hits.push(next)
      pos = next
    }
    if (ok) {
      score -= t.length * 0.02
      if (!best || score > best.score) best = { score, hits }
    }
    start = t.indexOf(q[0]!, start + 1)
  }
  return best
}

const GROUP_ORDER: Group[] = ['Actions', 'Threads', 'Projects']
const EMPTY_LIMIT: Record<Group, number> = { Actions: 20, Threads: 8, Projects: 6 }

const groups = computed(() => {
  const q = query.value.trim().toLowerCase().replace(/\s+/g, ' ')
  const all = [...actions.value, ...threadItems.value, ...projectItems.value]
  const out: { group: Group; items: Scored[]; best: number }[] = []

  const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const wordRes = q ? q.split(' ').map(w => new RegExp(`(?:^|[\\s/._-])${escape(w)}`)) : []

  for (const group of GROUP_ORDER) {
    let items: Scored[] = []
    for (const it of all) {
      if (it.group !== group) continue
      if (!q) { items.push({ ...it, score: 0, hits: [] }); continue }
      const onLabel = fuzzy(q, it.label)
      // Scattered single-letter hits across a long label are noise, not a match.
      if (onLabel && onLabel.score >= q.length * 2) { items.push({ ...it, score: onLabel.score, hits: onLabel.hits }); continue }
      // Hidden words (agent, path, synonyms) only match as whole-word prefixes.
      const hay = `${it.label} ${it.detail ?? ''} ${it.keywords ?? ''}`.toLowerCase()
      if (wordRes.every(re => re.test(hay))) {
        items.push({ ...it, score: q.length - 2, hits: [] })
      }
    }
    if (q) items.sort((a, b) => b.score - a.score || (a.rank ?? 0) - (b.rank ?? 0))
    items = items.slice(0, q ? 12 : EMPTY_LIMIT[group])
    if (items.length) out.push({ group, items, best: q ? items[0]!.score : 0 })
  }
  // With a query, the group holding the best match leads.
  if (q) out.sort((a, b) => b.best - a.best)
  let index = 0
  return out.map(g => ({ ...g, items: g.items.map(it => ({ ...it, index: index++ })) }))
})

const flat = computed(() => groups.value.flatMap(g => g.items))

function segments(label: string, hits: number[]) {
  if (!hits.length) return [{ text: label, hit: false }]
  const set = new Set(hits)
  const out: { text: string; hit: boolean }[] = []
  for (let i = 0; i < label.length; i++) {
    const hit = set.has(i)
    const last = out[out.length - 1]
    if (last && last.hit === hit) last.text += label[i]
    else out.push({ text: label[i]!, hit })
  }
  return out
}

/* ---------- open / close ---------- */

watch(() => ws.paletteOpen, async (open) => {
  if (open) {
    // Environments not checked yet this session: once, so "Open folder in …" can list them.
    void refreshEnvs({ once: true })
    returnFocus = document.activeElement as HTMLElement | null
    query.value = ''
    selected.value = 0
    runError.value = carryError
    carryError = null
    await nextTick()
    input.value?.focus()
  } else if (returnFocus?.isConnected && !ws.dialog) {
    returnFocus.focus()
    returnFocus = null
  }
})

watch(query, () => {
  selected.value = 0
  list.value?.scrollTo({ top: 0 })
})

watch(flat, (items) => {
  if (selected.value >= items.length) selected.value = Math.max(0, items.length - 1)
})

watch(selected, async (i) => {
  await nextTick()
  list.value?.querySelector<HTMLElement>(`[data-index="${i}"]`)?.scrollIntoView({ block: 'nearest' })
})

function close() {
  ws.paletteOpen = false
}

async function run(item: Item | undefined) {
  if (!item) return
  runError.value = null
  close()
  try {
    await item.run()
  } catch (e) {
    // Reopen with the reason so the failure isn't silent.
    carryError = `${item.group === 'Projects' ? `Couldn't open ${item.label}` : `${item.label} failed`}: ${errorText(e).replace(/\.$/, '')}.`
    if (item.group === 'Projects') carryError += ' If the folder moved, open it again with Open folder…'
    await nextTick() // let the close settle so reopening runs the open path
    ws.paletteOpen = true
  }
}

function move(step: number) {
  const n = flat.value.length
  if (!n) return
  selected.value = (selected.value + step + n) % n
}

function onKeydown(e: KeyboardEvent) {
  const ctrlOnly = e.ctrlKey && !e.metaKey && !e.altKey
  if (e.key === 'ArrowDown' || (ctrlOnly && e.key === 'n' && isMac)) { e.preventDefault(); move(1) }
  else if (e.key === 'ArrowUp' || (ctrlOnly && e.key === 'p' && isMac)) { e.preventDefault(); move(-1) }
  else if (e.key === 'PageDown') { e.preventDefault(); selected.value = Math.min(flat.value.length - 1, selected.value + 8) }
  else if (e.key === 'PageUp') { e.preventDefault(); selected.value = Math.max(0, selected.value - 8) }
  else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); run(flat.value[selected.value]) }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
  else if (e.key === 'Tab') { e.preventDefault() }
}

const activeId = computed(() => (flat.value.length ? `cmdk-opt-${selected.value}` : undefined))
</script>

<template>
  <Teleport to="body">
    <Transition name="cmdk">
      <div v-if="ws.paletteOpen" class="cmdk" @mousedown.self="close">
        <div class="cmdk__panel" role="dialog" aria-modal="true" aria-label="Command palette">
          <div class="cmdk__search">
            <Search class="cmdk__search-icon" aria-hidden="true" />
            <input
              ref="input"
              v-model="query"
              class="cmdk__input"
              type="text"
              placeholder="Run a command, jump to a thread or project"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls="cmdk-list"
              :aria-activedescendant="activeId"
              autocomplete="off"
              spellcheck="false"
              @keydown="onKeydown"
            >
            <kbd class="cmdk__esc" aria-hidden="true">Esc</kbd>
          </div>

          <p v-if="runError" class="cmdk__error" role="alert">{{ runError }}</p>

          <div id="cmdk-list" ref="list" class="cmdk__list" role="listbox" aria-label="Results">
            <div v-for="g in groups" :key="g.group" role="group" :aria-labelledby="`cmdk-g-${g.group}`" class="cmdk__group">
              <div :id="`cmdk-g-${g.group}`" class="cmdk__group-label" role="presentation">{{ g.group }}</div>
              <div
                v-for="it in g.items"
                :id="`cmdk-opt-${it.index}`"
                :key="it.id"
                class="cmdk__item"
                :class="{ 'is-selected': it.index === selected }"
                role="option"
                :aria-selected="it.index === selected"
                :data-index="it.index"
                @mousemove="selected = it.index"
                @mousedown.prevent
                @click="run(it)"
              >
                <span class="cmdk__item-icon">
                  <UiRipenessDot v-if="it.status" :status="it.status" :unseen="it.unseen" :size="10" />
                  <component :is="it.icon" v-else-if="it.icon" aria-hidden="true" />
                </span>
                <span class="cmdk__item-text">
                  <span class="cmdk__item-label"><template v-for="(s, si) in segments(it.label, it.hits)" :key="si"><mark v-if="s.hit">{{ s.text }}</mark><template v-else>{{ s.text }}</template></template></span>
                  <span v-if="it.detail" class="cmdk__item-detail" :class="{ 'is-mono': it.group === 'Projects' }">{{ it.detail }}</span>
                </span>
                <span v-if="it.badge" class="cmdk__badge">{{ it.badge }}</span>
                <span v-else-if="it.keys" class="cmdk__keys" aria-hidden="true">
                  <kbd v-for="k in it.keys" :key="k">{{ k }}</kbd>
                </span>
              </div>
            </div>

            <div v-if="!flat.length" class="cmdk__empty" role="presentation">
              Nothing matches <span class="cmdk__empty-q">“{{ query.trim() }}”</span>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.cmdk {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 12vh var(--space-4) 0;
  background: color-mix(in oklch, var(--scrim) 70%, transparent);
}
.cmdk__panel {
  display: flex;
  flex-direction: column;
  width: 600px;
  max-width: 100%;
  max-height: min(520px, 76vh);
  background: var(--bg-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-pop);
  overflow: hidden;
}

/* ---------- search ---------- */
.cmdk__search {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: none;
  height: 50px;
  padding: 0 var(--space-4);
  border-bottom: 1px solid var(--line-soft);
}
.cmdk__search-icon { width: 17px; height: 17px; stroke-width: 1.85; color: var(--fg-subtle); flex: none; }
.cmdk__input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0;
  font-size: var(--text-lg);
  letter-spacing: -0.005em;
  background: transparent;
  border: 0;
  outline: none;
}
.cmdk__input::placeholder { color: var(--fg-faint); }
.cmdk__esc { flex: none; }

.cmdk__error {
  margin: 0;
  padding: var(--space-2) var(--space-4);
  font-size: var(--text-sm);
  color: var(--fg);
  background: color-mix(in oklch, var(--ripe-error) 10%, transparent);
  border-bottom: 1px solid color-mix(in oklch, var(--ripe-error) 30%, transparent);
}

/* ---------- results ---------- */
.cmdk__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--space-1) var(--space-2) var(--space-2);
  scroll-padding: var(--space-2) 0;
}
.cmdk__group + .cmdk__group { margin-top: var(--space-1); }
.cmdk__group-label {
  padding: var(--space-2) var(--space-2) var(--space-1);
  font-size: var(--text-xs);
  font-weight: 560;
  color: var(--fg-subtle);
}

.cmdk__item {
  display: grid;
  grid-template-columns: 18px 1fr auto;
  align-items: center;
  gap: var(--space-3);
  height: 34px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--fg);
  cursor: pointer;
}
.cmdk__item.is-selected { background: var(--bg-active); }
.cmdk__item-icon { display: grid; place-items: center; color: var(--fg-subtle); }
.cmdk__item-icon > :deep(svg) { width: 16px; height: 16px; stroke-width: 1.75; }
.cmdk__item.is-selected .cmdk__item-icon { color: var(--fg); }

.cmdk__item-text {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
  white-space: nowrap;
}
.cmdk__item-label {
  flex: none;
  max-width: 70%;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: var(--text-md);
}
.cmdk__item-label mark {
  background: none;
  color: var(--accent-ink);
  font-weight: 600;
}
.cmdk__item-detail {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: var(--text-sm);
  color: var(--fg-subtle);
}
.cmdk__item-detail.is-mono { font-family: var(--font-mono); font-size: var(--text-xs); }

.cmdk__keys { display: inline-flex; gap: 3px; }
.cmdk__badge { font-size: var(--text-xs); color: var(--fg-subtle); }
.cmdk__item.is-selected .cmdk__keys kbd { color: var(--fg-muted); border-color: var(--line); }

.cmdk__empty {
  padding: var(--space-8) var(--space-4);
  text-align: center;
  font-size: var(--text-sm);
  color: var(--fg-subtle);
}
.cmdk__empty-q { color: var(--fg-muted); }

/* ---------- motion: quick, from nearly-there ---------- */
.cmdk-enter-active { transition: opacity 120ms var(--ease-out); }
.cmdk-leave-active { transition: opacity 90ms var(--ease-out); }
.cmdk-enter-active .cmdk__panel { transition: transform 150ms var(--ease-out), opacity 120ms var(--ease-out); }
.cmdk-leave-active .cmdk__panel { transition: transform 90ms var(--ease-out), opacity 90ms var(--ease-out); }
.cmdk-enter-from, .cmdk-leave-to { opacity: 0; }
.cmdk-enter-from .cmdk__panel, .cmdk-leave-to .cmdk__panel { opacity: 0; transform: translateY(-6px) scale(0.985); }

@media (prefers-reduced-motion: reduce) {
  .cmdk-enter-from .cmdk__panel, .cmdk-leave-to .cmdk__panel { transform: none; }
}
</style>
