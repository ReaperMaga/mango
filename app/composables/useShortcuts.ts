import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { useFiles } from '~/stores/files'
import { isFileTab } from '~/utils/fileTabs'
import { useBrowser } from '~/stores/browser'
import { pickFolder } from '~/composables/useBackend'
import { projectWhere } from '~/composables/envProjects'

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
  const path = await pickFolder('Open folder')
  if (path) await ws.openProject(path)
}

/**
 * Global keyboard shortcuts.
 *   Mod+K  command palette      Mod+N  new chat         Mod+O  open folder
 *   Mod+`  / Ctrl+J  terminal   Mod+B  sidebar          Mod+\  split chat
 *   Mod+W  close tab            Mod+1..9 switch tab     Mod+Shift+T  new terminal
 *   Mod+Shift+G  changes panel  Mod+,  settings
 *   Mod+Shift+E  files panel    Mod+S  save the file in the active pane
 *   Mod+Shift+U  usage limits   Mod+Shift+P  pull requests panel
 *   Mod+Shift+H  environment panel (where the project runs)
 *   Mod+Shift+B  new browser tab   Mod+Alt+B  show or hide the tool window
 */
export function useShortcuts() {
  const ws = useWorkspace()
  const threads = useThreads()

  function handler(e: KeyboardEvent) {
    if (!isMod(e)) return
    const k = e.key.toLowerCase()
    const inTerminal = (e.target as HTMLElement | null)?.closest?.('.xterm')

    // These two work everywhere, including inside the terminal (xterm stops
    // key events from bubbling, hence the capture-phase listener below).
    if (k === 'k' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); ws.paletteOpen = !ws.paletteOpen; return }
    if (k === '`' || (k === 'j' && !e.shiftKey)) { e.preventDefault(); e.stopPropagation(); if (!ws.settings) ws.toggleTerminal(); return }
    if (inTerminal) return // let the shell have everything else (Ctrl+C, Ctrl+W, …)

    if (k === 'u' && e.shiftKey) { e.preventDefault(); ws.dialog === 'usage' ? (ws.dialog = null) : ws.openUsage(); return }
    if (k === ',') { e.preventDefault(); ws.settings ? (ws.settings = null) : ws.openSettings(); return }
    // Settings covers the workspace: its shortcuts must not act on what is hidden underneath.
    if (ws.settings) return

    if (k === 'n' && e.shiftKey) {
      // A chat whose worktree is made from its first message.
      e.preventDefault()
      if (ws.activeProjectPath) threads.createAwaitingWorktree(ws.activeProjectPath)
      return
    }
    if (k === 'n' && !e.shiftKey) {
      e.preventDefault()
      if (ws.activeProjectPath) threads.create(ws.activeProjectPath)
      else ws.dialog = 'new'
      return
    }
    if (k === 'o') { e.preventDefault(); openFolderFlow(); return }
    if (e.altKey && e.code === 'KeyB') { e.preventDefault(); if (ws.hasProject) ws.toggleToolPanel(); return }
    if (k === 'b' && e.shiftKey) { e.preventDefault(); useBrowser().openNew(); return }
    if (k === 'b') { e.preventDefault(); ws.toggleSidebar(); return }
    if (k === '\\') { e.preventDefault(); threads.isSplit ? threads.closePane(threads.activePaneId) : threads.split(); return }
    if (k === 'g' && e.shiftKey) { e.preventDefault(); if (ws.hasProject) ws.toggleGit(); return }
    if (k === 'e' && e.shiftKey) { e.preventDefault(); if (ws.hasProject) ws.toggleFiles(); return }
    if (k === 'p' && e.shiftKey) { e.preventDefault(); if (ws.hasProject) ws.toggleLinks(); return }
    if (k === 'h' && e.shiftKey) { e.preventDefault(); if (ws.hasProject) ws.toggleEnv(); return }
    if (k === 's' && !e.shiftKey) {
      // Never the browser's "save page"; only a file tab has something to save.
      e.preventDefault()
      const id = threads.activePane.threadId
      if (isFileTab(id)) void useFiles().save(id)
      return
    }
    if (k === 't' && e.shiftKey) { e.preventDefault(); ws.newTerminal(); return }
    if (k === 'w' && !e.shiftKey) {
      const id = threads.activePane.threadId
      if (id) { e.preventDefault(); threads.closeTab(id) }
      return
    }
    if (/^[1-9]$/.test(e.key)) {
      // Numbered as the tab strip shows them: the active project's tabs only.
      const id = threads.visibleTabs[Number(e.key) - 1]
      if (id) { e.preventDefault(); threads.show(id) }
    }
  }

  onMounted(() => window.addEventListener('keydown', handler, true))
  onBeforeUnmount(() => window.removeEventListener('keydown', handler, true))
}
