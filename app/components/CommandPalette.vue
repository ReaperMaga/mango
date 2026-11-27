<script setup lang="ts">
import {
  CircleArrowUp, Columns2, Globe, Download, FlaskConical, Gauge, Folder, FolderOpen, FolderPlus, GitBranch, GitCommitHorizontal, GitFork, GitGraph, GitPullRequest, Laptop, Tag, Workflow, MessageSquarePlus, Settings,
  Bell, Keyboard, FolderCog, FileKey, FilePen, FolderGit2, Files, Link2, Moon, PanelBottom, PanelLeft, PanelTop, Search, Plug, Puzzle, Server, SquareTerminal, Sun, History, AppWindow,
} from 'lucide-vue-next'
import type { Component } from 'vue'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { useUpdater } from '~/stores/updater'
import { useEnvironments } from '~/stores/environments'
import { useBrowser } from '~/stores/browser'
import { useGitLog } from '~/stores/gitLog'
import { useWindows } from '~/stores/windows'
import { useForge } from '~/stores/forge'
import { AGENTS, hasUnreadResult } from '~/types/chat'
import { openLocalFolder } from '~/composables/useShortcuts'
import type { ThreadStatus } from '~/types/chat'
import { useOverlay } from '~/composables/useOverlay'
import { useWorktrees } from '~/composables/useWorktrees'
import { openPlugins } from '~/composables/pluginsView'
import { parseTerminalTab } from '~/utils/terminalTabs'
import { pluginNames, reg, setBuiltinCommands, shown } from '~/plugin-host/registry'
import { iconComponent } from '~/plugin-host/icons'
import { vcsTerms } from '~/utils/vcs'
import { isEnvPath } from '~/utils/envPath'
import { useLore } from '~/stores/lore'

/**
 * Mod+K command palette: actions, every thread in the open projects, and
 * recent projects, filtered with a forgiving subsequence match.
 */
const { t } = useI18n()
const ws = useWorkspace()
const threads = useThreads()
const envs = useEnvironments()
const forge = useForge()
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

type Group = 'Actions' | 'Plugins' | 'Threads' | 'Projects'

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
  if (project && win.spec.kind !== 'chat') {
    items.push({ id: 'new-chat', group: 'Actions', label: t('shell.chat.new'), detail: ws.activeProject?.name, icon: MessageSquarePlus, keys: ws.keyParts('new-chat'), keywords: 'thread conversation agent', run: () => threads.create(project) })
    if (wts.supported.value) {
      items.push({ id: 'new-worktree-chat', group: 'Actions', label: t('shell.chat.newInTerm', { term: wts.term.value }), detail: t('shell.palette.worktreeDetail'), icon: FolderGit2, keys: ws.keyParts('new-chat-worktree'), keywords: 'worktree workspace parallel branch isolated new chat thread git unity', run: () => threads.createAwaitingWorktree(project) })
      for (const w of wts.linked.value) {
        if (w.prunable) continue
        items.push({ id: `worktree:${w.path}`, group: 'Actions', label: t('shell.palette.goToTerm', { term: wts.term.value, name: wts.label(w) }), detail: wts.hint(w), icon: FolderGit2, keywords: `worktree workspace switch ${w.branch ?? ''}`, run: () => wts.goTo(w) })
      }
    }
    items.push({ id: 'new-browser', group: 'Actions', label: t('shell.tabs.newBrowser'), detail: ws.activeProject?.name, icon: Globe, keys: ws.keyParts('new-browser'), keywords: 'browser web page url localhost preview dev server open site', run: () => useBrowser().openNew() })
  }
  // With environments around, say where these put the project (the remembered choice).
  const where = projectWhere()
  const whereDetail = envs.hosts.length ? (where ? envLabels(where.hostId, where.instance).where : t('shell.titlebar.thisComputer')) : undefined
  // Another window: on this project (it moves there), or a new one on the welcome screen.
  if (project && (win.isMain || ws.openProjects.length > 1)) {
    const blocked = win.moveBlocker(project)
    items.push({ id: 'project-window', group: 'Actions', label: t('shell.palette.projectWindow'), detail: blocked?.hint ?? ws.activeProject?.name, icon: AppWindow, keywords: 'window move separate detach second monitor screen', run: () => win.openInNewWindow(project) })
  }
  // The chat in front: out into a window of its own, or (its own window) back.
  const chat = threads.activeThread
  if (chat) {
    const move = win.moveChatAction(chat.id)
    const back = win.isOwnChat(chat.id)
    items.push({ id: 'chat-window', group: 'Actions', label: back ? t('shell.palette.returnChat') : t('shell.palette.moveChat'), detail: move.hint ?? chatTitle(chat.title), icon: AppWindow, keywords: 'window move separate detach tear off pop out second monitor screen', run: move.onSelect })
  }
  items.push({ id: 'new-window', group: 'Actions', label: t('shell.project.newWindow'), icon: AppWindow, keys: ws.keyParts('new-window'), keywords: 'window open another second monitor screen', run: () => win.openInNewWindow(null) })
  items.push(
    { id: 'open-folder', group: 'Actions', label: t('shell.project.openFolder'), detail: whereDetail, icon: FolderOpen, keys: ws.keyParts('open-folder'), keywords: 'project directory', run: openFolderFlow },
    { id: 'new-project', group: 'Actions', label: t('shell.project.new'), detail: whereDetail, icon: FolderPlus, keywords: 'create folder init', run: () => { ws.dialog = 'new' } },
    { id: 'clone', group: 'Actions', label: t('shell.project.clone'), detail: whereDetail, icon: GitFork, keywords: 'git github gitlab remote', run: () => { ws.dialog = 'clone' } },
  )
  // Straight into a known, usable environment: open a folder there (and make it the place for the next one).
  if (where) {
    items.push({ id: 'open-folder-local', group: 'Actions', label: t('shell.palette.openLocal'), icon: Laptop, keywords: 'project directory local disk', run: () => { ws.setWhere(null); return openLocalFolder() } })
  }
  for (const p of knownPlaces()) {
    if (samePlace(p, where)) continue
    const l = envLabels(p.hostId, p.instance)
    items.push({
      id: `open-folder-env:${p.hostId}/${p.instance}`,
      group: 'Actions',
      label: t('shell.palette.openIn', { name: l.label }),
      detail: l.shared ? t('shell.palette.sharedWithYou') : l.host,
      icon: Server,
      keywords: `project directory remote environment ${l.where}`,
      run: () => { ws.setWhere(p); ws.dialog = 'open-env' },
    })
  }
  items.push(
    { id: 'environments', group: 'Actions', label: t('shell.palette.environments'), detail: t('shell.palette.environmentsDetail'), icon: Server, keywords: 'remote environment server ssh incus container vm instance cloud machine', run: () => envs.openView() },
    { id: 'join-env', group: 'Actions', label: t('shell.palette.join'), detail: t('shell.palette.joinDetail'), icon: Link2, keywords: 'join share shared link invite remote environment mango://join paste qr', run: () => envs.openJoin() },
  )
  if (inWorkspace) {
    // Move the terminal in view between the panel and the main area.
    const paneTerm = parseTerminalTab(threads.activePane.threadId)?.terminalId
    if (paneTerm) items.push({ id: 'terminal-to-panel', group: 'Actions', label: t('shell.palette.terminalToPanel'), icon: PanelBottom, keywords: 'terminal shell dock bottom panel editor tab', run: () => ws.moveTerminalToPanel(paneTerm) })
    const panelTerm = ws.terminalOpen ? ws.activeTerminalId : null
    if (panelTerm) items.push({ id: 'terminal-to-editor', group: 'Actions', label: t('shell.palette.terminalToEditor'), icon: PanelTop, keywords: 'terminal shell tab main pane editor area undock', run: () => ws.moveTerminalToEditor(panelTerm) })
    items.push(
      { id: 'toggle-terminal', group: 'Actions', label: ws.terminalOpen ? t('shell.palette.hideTerminal') : t('shell.palette.showTerminal'), icon: PanelBottom, keys: ws.keyParts('terminal'), keywords: 'toggle terminal shell panel console', run: () => ws.toggleTerminal() },
      { id: 'new-terminal', group: 'Actions', label: t('shell.palette.newTerminal'), icon: SquareTerminal, keys: ws.keyParts('new-terminal'), keywords: 'shell tab console', run: () => ws.newTerminal() },
      { id: 'new-terminal-editor', group: 'Actions', label: t('shell.palette.newTerminalEditor'), icon: SquareTerminal, keywords: 'shell tab console main pane editor', run: () => ws.newTerminal(undefined, undefined, true) },
      { id: 'toggle-env', group: 'Actions', label: ws.toolPanel === 'env' ? t('shell.palette.hideEnv') : t('shell.palette.showEnv'), keys: ws.keyParts('env'), detail: remotePlace(ws.activeProjectPath)?.where ?? t('shell.titlebar.thisComputer'), icon: remotePlace(ws.activeProjectPath) ? Server : Laptop, keywords: 'environment where runs remote local computer instance server shell desktop sign in components', run: () => ws.toggleEnv() },
      { id: 'toggle-files', group: 'Actions', label: ws.toolPanel === 'files' ? t('shell.palette.hideFiles') : t('shell.palette.showFiles'), icon: Files, keys: ws.keyParts('files'), keywords: 'files explorer tree folder browse open edit editor', run: () => ws.toggleFiles() },
      { id: 'toggle-git', group: 'Actions', label: ws.toolPanel === 'changes' ? t('shell.palette.hideChanges') : t('shell.palette.showChanges'), icon: GitBranch, keys: ws.keyParts('changes'), keywords: 'git source control changes diff commit push pull', run: () => ws.toggleGit() },
      { id: 'git-log.show', group: 'Actions', label: t('shell.palette.showGitLog'), icon: GitGraph, keys: ws.keyParts('git-log'), keywords: 'git log history commits graph branches', run: () => useGitLog().open() },
      { id: 'git-log.go-to-commit', group: 'Actions', label: t('shell.palette.goToCommit'), detail: t('shell.tools.gitLog'), icon: GitCommitHorizontal, keywords: 'git log hash sha revision branch tag', run: () => useGitLog().goToCommit() },
      ...(!vcsTerms(ws.activeProject?.vcs).forge ? [] : [{ id: 'toggle-links', group: 'Actions' as const, label: forge.providerOf(ws.activeProjectPath) === 'gitlab' ? (ws.toolPanel === 'links' ? t('shell.palette.hideMerges') : t('shell.palette.showMerges')) : (ws.toolPanel === 'links' ? t('shell.palette.hidePulls') : t('shell.palette.showPulls')), icon: GitPullRequest, keys: ws.keyParts('links'), keywords: 'pull request pr merge request mr issue github gitlab linked link', run: () => ws.toggleLinks() }]),
      ...(!vcsTerms(ws.activeProject?.vcs).forge || !forge.connected(ws.activeProjectPath) ? [] : [{ id: 'toggle-releases', group: 'Actions' as const, label: ws.toolPanel === 'releases' ? t('shell.palette.hideReleases') : t('shell.palette.showReleases'), icon: Tag, keys: ws.keyParts('releases'), keywords: 'releases github gitlab tags versions builds actions workflow runs pipelines assets download', run: () => ws.toggleReleases() }]),
      ...(!vcsTerms(ws.activeProject?.vcs).forge || !forge.connected(ws.activeProjectPath) ? [] : [{ id: 'toggle-actions', group: 'Actions' as const, label: ws.toolPanel === 'actions' ? t('shell.palette.hideActions') : t('shell.palette.showActions'), icon: Workflow, keys: ws.keyParts('actions'), keywords: 'actions github gitlab ci workflow runs pipelines jobs checks builds rerun cancel', run: () => ws.toggleActions() }]),
      { id: 'toggle-sidebar', group: 'Actions', label: ws.sidebarOpen ? t('shell.sidebar.hide') : t('shell.sidebar.show'), icon: PanelLeft, keys: ws.keyParts('sidebar'), keywords: 'toggle sidebar rail threads', run: () => ws.toggleSidebar() },
      threads.isSplit
        ? { id: 'split', group: 'Actions', label: t('shell.palette.closeSplit'), icon: Columns2, keys: ws.keyParts('split'), keywords: 'split unsplit pane', run: () => threads.closePane(threads.activePaneId) }
        : { id: 'split', group: 'Actions', label: t('shell.palette.splitChat'), icon: Columns2, keys: ws.keyParts('split'), keywords: 'split pane side by side', run: () => threads.split() },
    )
  }
  if (ws.activeProject) {
    // Names only: what is in the files never reaches the palette.
    items.push(
      { id: 'project-settings', group: 'Actions', label: t('shell.palette.projectSettings'), detail: ws.activeProject.name, icon: FolderCog, keywords: 'project settings preferences configure name icon color pin archive agent model permissions env environment variables dotenv', run: () => ws.openSettings('projects') },
      { id: 'project-env', group: 'Actions', label: t('shell.palette.projectEnv'), detail: ws.activeProject.name, icon: FileKey, keywords: 'env dotenv .env file variables secrets keys api key token config environment project settings', run: () => ws.openProjectEnv() },
      { id: 'project-mcp', group: 'Actions', label: t('shell.palette.projectMcp'), detail: ws.activeProject.name, icon: Plug, keywords: 'mcp model context protocol servers tools project unity', run: () => ws.openProjectMcp() },
    )
    const p = ws.activeProject
    if (!isEnvPath(p.path) && p.vcs !== 'lore') {
      items.push({ id: 'lore-init', group: 'Actions', label: t('shell.palette.loreInit'), detail: p.name, icon: FolderGit2, keywords: 'lore epic repository create init version control unity loreignore', run: () => { useLore().initFor = { path: p.path, name: p.name } } })
    }
  }
  items.push({ id: 'settings-mcp', group: 'Actions', label: t('shell.palette.mcp'), icon: Plug, keywords: 'mcp model context protocol servers tools add server claude codex', run: () => ws.openSettings('mcp') })
  items.push({ id: 'plugins-browse', group: 'Actions', label: t('shell.palette.browsePlugins'), icon: Puzzle, keywords: 'plugins extensions addons catalog install marketplace', run: () => openPlugins({ tab: 'browse' }) })
  items.push({ id: 'plugins-add', group: 'Actions', label: t('shell.palette.addPlugin'), icon: Puzzle, keywords: 'plugins install git repository url extension', run: () => openPlugins({ add: true }) })
  items.push({ id: 'settings-editor', group: 'Actions', label: t('shell.palette.editorSettings'), icon: FilePen, keywords: 'editor autosave auto save files smooth caret cursor language servers lsp completion', run: () => ws.openSettings('editor') })
  items.push({ id: 'settings-terminal', group: 'Actions', label: t('shell.palette.terminalSettings'), icon: SquareTerminal, keywords: 'terminal shell bash zsh fish powershell cmd wsl git bash profile font cursor default', run: () => ws.openSettings('terminal') })
  items.push({ id: 'settings-notifications', group: 'Actions', label: t('shell.palette.notificationSettings'), icon: Bell, keywords: 'notifications notify alert sound desktop finished approval fails background', run: () => ws.openSettings('notifications') })
  items.push({ id: 'settings-shortcuts', group: 'Actions', label: t('shell.palette.shortcuts'), icon: Keyboard, keywords: 'keyboard shortcuts keys keybindings bindings hotkeys rebind remap', run: () => ws.openSettings('shortcuts') })
  const up = useUpdater()
  items.push(up.update
    ? { id: 'update', group: 'Actions', label: t('shell.palette.updateTo', { version: up.update.version }), icon: CircleArrowUp, keywords: 'update upgrade new version release install restart', run: () => up.install() }
    : { id: 'update', group: 'Actions', label: t('shell.update.check'), icon: CircleArrowUp, keywords: 'update upgrade new version release', run: () => { ws.openSettings('maintenance'); up.check(true) } })
  items.push({ id: 'usage', group: 'Actions', label: t('shell.usage.title'), detail: t('shell.palette.usageDetail'), icon: Gauge, keys: ws.keyParts('usage'), keywords: 'usage limits quota rate limit plan weekly 5-hour five hour session reset claude codex', run: () => ws.openUsage() })
  items.push({ id: 'setup', group: 'Actions', label: t('shell.usage.getStarted'), detail: t('shell.palette.setupDetail'), icon: Download, keywords: 'setup install onboarding first run claude code codex git cli agents download sign in login', run: () => ws.openSetup() })
  items.push({ id: 'changelog', group: 'Actions', label: t('shell.palette.changelog'), icon: History, keywords: 'changelog release notes what is new whats new versions history', run: () => ws.openSettings('changelog') })
  items.push({ id: 'settings', group: 'Actions', label: t('shell.palette.openSettings'), icon: Settings, keys: ws.keyParts('settings'), keywords: 'settings preferences agents sign in login account claude codex', run: () => ws.openSettings() })
  items.push({
    id: 'theme',
    group: 'Actions',
    label: dark ? t('shell.palette.lightTheme') : t('shell.palette.darkTheme'),
    icon: dark ? Sun : Moon,
    keywords: 'theme appearance dark light mode color',
    run: () => ws.cycleTheme(),
  })
  if (project) {
    items.push({ id: 'demo', group: 'Actions', label: t('shell.palette.demo'), detail: ws.activeProject?.name, icon: FlaskConical, keywords: 'sample example seed', run: () => threads.loadDemo(project) })
  }
  return items.map((it, i) => ({ ...it, rank: i }))
})

/* Plugins' actions can run Mango's own by id (`mango.commands.execute('toggle-git')`). */
setBuiltinCommands(() => actions.value.map(a => ({ id: a.id, title: a.label, run: a.run })))

/** Commands plugins registered, with the plugin's name as the detail (or the command's own). */
const pluginItems = computed<Item[]>(() =>
  reg.commands.filter(c => shown(c)).map((c, i) => {
    const plugin = pluginNames[c.pluginId] ?? c.pluginId
    return {
      id: `plugin:${c.fullId}`,
      group: 'Plugins' as const,
      label: chatTitle(c.title),
      detail: c.detail || plugin,
      icon: iconComponent(c.icon) ?? iconComponent('puzzle'),
      keywords: `${plugin} plugin ${c.keywords ?? ''}`,
      rank: i,
      run: () => c.run(),
    }
  }))

const threadItems = computed<Item[]>(() => {
  const many = ws.openProjects.length > 1
  return ws.openProjects
    .flatMap(p => threads.forProject(p.path).map(chat => ({ chat, p })))
    .sort((a, b) => b.chat.updatedAt - a.chat.updatedAt)
    .map(({ chat, p }, i) => ({
      id: `thread:${chat.id}`,
      group: 'Threads' as const,
      label: chatTitle(chat.title),
      detail: many ? `${AGENTS[chat.agent].name} · ${p.name}` : AGENTS[chat.agent].name,
      status: chat.status,
      unseen: chat.status === 'waiting' || hasUnreadResult(chat),
      keywords: `${AGENTS[chat.agent].name} ${p.name} ${chat.model}`,
      rank: i,
      run: () => {
        if (ws.activeProjectPath !== chat.projectPath) ws.setActiveProject(chat.projectPath)
        threads.show(chat.id)
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
      badge: current ? t('shell.palette.current') : isOpen ? t('shell.palette.openBadge') : elsewhere ? t('shell.palette.otherWindow') : undefined,
      keywords: remote ? `${remote.where} ${remote.dir} remote environment` : `${p.path} ${p.branch ?? ''}`,
      rank: i,
      run: async () => {
        if (isOpen) ws.setActiveProject(p.path)
        else await ws.openProjectAsking(p.path)
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
  const lower = text.toLowerCase()
  if (!q) return { score: 0, hits: [] }
  let best: { score: number; hits: number[] } | null = null
  let start = lower.indexOf(q[0]!)
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
      if (lower[pos + 1] === ch) next = pos + 1
      else {
        let any = -1
        for (let j = pos + 1; j < lower.length; j++) {
          if (lower[j] !== ch) continue
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
      score -= lower.length * 0.02
      if (!best || score > best.score) best = { score, hits }
    }
    start = lower.indexOf(q[0]!, start + 1)
  }
  return best
}

const GROUP_ORDER: Group[] = ['Actions', 'Plugins', 'Threads', 'Projects']
const groupTitles = computed<Record<Group, string>>(() => ({ Actions: t('shell.palette.groups.actions'), Plugins: t('shell.palette.groups.plugins'), Threads: t('shell.palette.groups.threads'), Projects: t('shell.palette.groups.projects') }))
const EMPTY_LIMIT: Record<Group, number> = { Actions: 20, Plugins: 8, Threads: 8, Projects: 6 }

const groups = computed(() => {
  const q = query.value.trim().toLowerCase().replace(/\s+/g, ' ')
  const all = [...actions.value, ...pluginItems.value, ...threadItems.value, ...projectItems.value]
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
    const why = errorText(e).replace(/\.$/, '')
    carryError = item.group === 'Projects' ? t('shell.palette.openFailed', { name: item.label, why }) : t('shell.palette.failed', { name: item.label, why })
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
        <div class="cmdk__panel" role="dialog" aria-modal="true" :aria-label="t('shell.palette.label')">
          <div class="cmdk__search">
            <Search class="cmdk__search-icon" aria-hidden="true" />
            <input
              ref="input"
              v-model="query"
              class="cmdk__input"
              type="text"
              :placeholder="t('shell.palette.placeholder')"
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

          <div id="cmdk-list" ref="list" class="cmdk__list" role="listbox" :aria-label="t('shell.palette.results')">
            <div v-for="g in groups" :key="g.group" role="group" :aria-labelledby="`cmdk-g-${g.group}`" class="cmdk__group">
              <div :id="`cmdk-g-${g.group}`" class="cmdk__group-label" role="presentation">{{ groupTitles[g.group] }}</div>
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
              <i18n-t keypath="shell.palette.nothing" scope="global">
                <template #query><span class="cmdk__empty-q">{{ t('shell.palette.query', { query: query.trim() }) }}</span></template>
              </i18n-t>
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
