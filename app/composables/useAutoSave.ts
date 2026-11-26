import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { useFiles } from '~/stores/files'
import { onEditorModelEdit } from '~/utils/editorModels'

/**
 * When open files save by themselves (Settings > Editor) besides after typing rests
 * (`utils/autoSave.ts`): whenever attention leaves the editor or the window, as in JetBrains IDEs.
 * That is also before anything is typed into a chat or a terminal. Closing is `stores/windows.ts`'s.
 */
export function useAutoSave() {
  const ws = useWorkspace()
  const threads = useThreads()
  const files = useFiles()

  const stopEdits = onEditorModelEdit(id => files.edited(id))

  watch(() => ws.editorAutoSave, (on) => { if (on) files.autoSaveTurnedOn() })
  // Another tab, pane or project takes over, or Settings covers them.
  watch(
    () => [ws.activeProjectPath, ws.settings, threads.activePaneId, ...threads.panes.map(p => p.threadId)].join('\n'),
    () => files.saveSoon(),
  )

  const inEditor = (el: EventTarget | null) => el instanceof Element && !!el.closest('.monaco-editor')
  function onFocusOut(e: FocusEvent) {
    if (inEditor(e.target) && !inEditor(e.relatedTarget)) files.saveSoon()
  }
  function onHidden() {
    if (document.hidden) files.saveSoon()
  }
  const onLeft = () => files.saveSoon()
  // A reload waits for no promise: the saves start, and the user can stay until they are through.
  function onUnload(e: BeforeUnloadEvent) {
    if (!ws.editorAutoSave || !Object.values(files.open).some(f => f.dirty)) return
    files.saveSoon()
    e.preventDefault()
    e.returnValue = ''
  }

  onMounted(() => {
    window.addEventListener('blur', onLeft)
    window.addEventListener('pagehide', onLeft)
    window.addEventListener('beforeunload', onUnload)
    document.addEventListener('visibilitychange', onHidden)
    document.addEventListener('focusout', onFocusOut, true)
  })
  onBeforeUnmount(() => {
    stopEdits()
    window.removeEventListener('blur', onLeft)
    window.removeEventListener('pagehide', onLeft)
    window.removeEventListener('beforeunload', onUnload)
    document.removeEventListener('visibilitychange', onHidden)
    document.removeEventListener('focusout', onFocusOut, true)
  })
}
