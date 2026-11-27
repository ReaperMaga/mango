import { mergeResultTab } from '~/utils/mergeTabs'
import { t } from '~/i18n'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { useFiles } from '~/stores/files'
import { isFileTab } from '~/utils/fileTabs'
import { useBrowser } from '~/stores/browser'
import { useGitLog } from '~/stores/gitLog'
import { useWindows } from '~/stores/windows'
import { pickFolder } from '~/composables/useBackend'
import { projectWhere } from '~/composables/envProjects'
import { SHORTCUTS, eventCombo, ownsKey } from '~/utils/shortcuts'
import { reg as pluginReg, report as reportPlugin } from '~/plugin-host/registry'
import { vcsTerms } from '~/utils/vcs'

/** True when the platform's primary modifier is held (Cmd on macOS, Ctrl elsewhere). */
export const isMod = (e: KeyboardEvent | MouseEvent) =>
  /Mac|iPhone|iPad/.test(navigator.platform) ? e.metaKey : e.ctrlKey

export const modLabel = () => (/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl')

/**
 * Open folder: where the user last chose (`ws.where`). On this computer that is the system's
 * folder picker; in an environment, Mango's own picker that browses the folders there.
 */
export async function openFolderFlow() {
  const ws = useWorkspace()
  if (projectWhere()) {
    ws.dialog = 'open-env'
    return
  }
  await openLocalFolder()
}

/** The system's folder picker, then open what was picked. */
export async function openLocalFolder() {
  const ws = useWorkspace()
  const path = await pickFolder(t('shell.shortcuts.labels.open-folder'))
  if (path) await ws.openProjectAsking(path)
}

/** The keys an editor claims for itself while the focus is in it (`data-own-keys`). */
function keyClaims(target: EventTarget | null): string[] {
  const claims: string[] = []
  for (let el = target instanceof Element ? target.closest('[data-own-keys]') : null; el; el = el.parentElement?.closest('[data-own-keys]') ?? null) {
    claims.push(el.getAttribute('data-own-keys') ?? '')
  }
  return claims
}

/**
 * Global keyboard shortcuts. The keys are `utils/shortcuts.ts`'s defaults unless the user
 * rebound them in Settings > Shortcuts (`ws.bindings`). Besides those: Mod+1..9 switch tab, and
 * Mod+J still toggles the terminal when nothing else has taken it.
 */
export function useShortcuts() {
  const ws = useWorkspace()
  const threads = useThreads()

  /** A chat window holds its one chat: new chats are made in a project's window. */
  const inChatWindow = () => useWindows().spec.kind === 'chat'

  /** What each action does; `scope` (in utils/shortcuts) decides where it may run. */
  const actions: Record<string, () => void> = {
    palette: () => { ws.paletteOpen = !ws.paletteOpen },
    terminal: () => { if (!ws.settings) ws.toggleTerminal() },
    usage: () => { ws.dialog === 'usage' ? (ws.dialog = null) : ws.openUsage() },
    settings: () => { ws.settings ? (ws.settings = null) : ws.openSettings() },
    'new-window': () => { void useWindows().openInNewWindow(null) },
    // A chat whose worktree is made from its first message.
    'new-chat-worktree': () => { if (!inChatWindow() && ws.activeProjectPath) threads.createAwaitingWorktree(ws.activeProjectPath) },
    'new-chat': () => {
      if (inChatWindow()) return
      ws.activeProjectPath ? threads.create(ws.activeProjectPath) : (ws.dialog = 'new')
    },
    'open-folder': () => { void openFolderFlow() },
    'new-browser': () => { void useBrowser().openNew() },
    sidebar: () => ws.toggleSidebar(),
    'tool-panel': () => { if (ws.hasProject) ws.toggleToolPanel() },
    split: () => { threads.isSplit ? threads.closePane(threads.activePaneId) : threads.split() },
    changes: () => { if (ws.hasProject) ws.toggleGit() },
    files: () => { if (ws.hasProject) ws.toggleFiles() },
    links: () => { if (ws.hasProject && vcsTerms(ws.activeProject?.vcs).forge) ws.toggleLinks() },
    releases: () => { if (ws.hasProject && vcsTerms(ws.activeProject?.vcs).forge) ws.toggleReleases() },
    actions: () => { if (ws.hasProject && vcsTerms(ws.activeProject?.vcs).forge) ws.toggleActions() },
    'git-log': () => { if (ws.hasProject) useGitLog().open() },
    env: () => { if (ws.hasProject) ws.toggleEnv() },
    // Never the browser's "save page"; only a file tab has something to save.
    'save-file': () => {
      const id = threads.activePane.threadId
      // The merge editor saves its Result, which is the file's own open copy.
      const target = isFileTab(id) ? id : mergeResultTab(id)
      if (target && useFiles().file(target)) void useFiles().save(target)
    },
    'find-chat': () => { findRequest.value++ },
    'new-terminal': () => ws.newTerminal(),
    'close-tab': () => {
      const id = threads.activePane.threadId
      if (id) threads.closeTab(id)
    },
  }
  const scopeOf = new Map(SHORTCUTS.map(s => [s.id, s.scope]))

  function handler(e: KeyboardEvent) {
    if (!isMod(e) || ws.recordingShortcut) return
    const combo = eventCombo(e)
    if (!combo) return
    if (ownsKey(keyClaims(e.target), combo)) return
    const inTerminal = (e.target as HTMLElement | null)?.closest?.('.xterm')

    const builtin = SHORTCUTS.find(s => ws.bindings[s.id] === combo)?.id
      // Mod+J has always toggled the terminal too; unless the user gave it away.
      ?? (combo === 'Mod+J' ? 'terminal' : undefined)
    // A plugin's shortcut (`plugin:<pluginId>.<id>`): bindings never give it a key a built-in has.
    const plugin = builtin ? undefined : pluginReg.shortcuts.find(s => ws.bindings[s.fullId] === combo)
    const id = builtin ?? plugin?.fullId
    const scope = builtin ? scopeOf.get(builtin) : plugin ? plugin.scope ?? 'workspace' : undefined
    if (plugin) {
      const run = () => {
        try { plugin.run() } catch (err) { reportPlugin(plugin.pluginId, err, `shortcut ${plugin.id}`) }
      }
      if (scope === 'always') { e.preventDefault(); e.stopPropagation(); run(); return }
      if (inTerminal) return
      if (scope === 'workspace' && ws.settings) return
      e.preventDefault()
      run()
      return
    }

    // 'always' works everywhere, including inside the terminal (xterm stops key events from
    // bubbling, hence the capture-phase listener below).
    if (id && scope === 'always') { e.preventDefault(); e.stopPropagation(); actions[id]?.(); return }
    if (inTerminal) return // let the shell have everything else (Ctrl+C, Ctrl+W, …)
    if (id && scope === 'app') { e.preventDefault(); actions[id]?.(); return }
    // Settings covers the workspace: its shortcuts must not act on what is hidden underneath.
    if (ws.settings) return

    if (id) {
      // Close tab only claims the key when there is a tab to close.
      if (id === 'close-tab' && !threads.activePane.threadId) return
      // Find in chat only claims the key in front of a chat: an editor, or a view with a search of its own, keeps its find.
      if (id === 'find-chat' && (!threads.byId(threads.activePane.threadId) || (e.target as HTMLElement | null)?.closest?.('[data-own-find]'))) return
      e.preventDefault()
      actions[id]?.()
      return
    }
    if (/^Mod\+[1-9]$/.test(combo)) {
      // Numbered as the active pane's tab strip shows them: the active project's tabs in that pane only.
      const tab = threads.groupTabs(threads.activePaneId)[Number(combo.slice(-1)) - 1]
      if (tab) { e.preventDefault(); threads.show(tab) }
    }
  }

  onMounted(() => window.addEventListener('keydown', handler, true))
  onBeforeUnmount(() => window.removeEventListener('keydown', handler, true))
}
