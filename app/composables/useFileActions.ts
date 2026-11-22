import type { Ref } from 'vue'
import type { FsEntry } from '~/types/ipc'
import { call } from '~/composables/useBackend'
import { useWorkspace } from '~/stores/workspace'
import { useFiles } from '~/stores/files'
import { excludedPathsOf } from '~/utils/fileTree'
import { copyName, movedPath, nameOf, nameProblem, parentOf, pathIn } from '~/utils/fileOps'
import { envPath, isEnvPath, parseEnvPath } from '~/utils/envPath'
import { sepOf, withTrailingSep } from '~/utils/paths'

/** A name being typed in the tree. */
export interface NameEdit {
  mode: 'file' | 'folder' | 'rename'
  /** A new one each time, so the field starts afresh. */
  id: number
  /** The folder the name is in. */
  dir: string
  /** Renaming: the entry's path. */
  path: string
  isDir: boolean
  error: string | null
  busy: boolean
}

const onPlatform = (pattern: RegExp) => pattern.test(navigator.platform)
const trashName = () => (onPlatform(/Win/) ? 'Recycle Bin' : 'Trash')
/** What the system calls its file manager. */
export const fileManagerName = () => (onPlatform(/Win/) ? 'Explorer' : onPlatform(/Mac/) ? 'Finder' : 'file manager')

const reason = (e: unknown) => (typeof e === 'string' ? e : e instanceof Error ? e.message : String(e))

let editSeq = 0

/**
 * The Files view's file operations as the user meets them: the name field, the questions before
 * deleting, and where focus goes afterwards. The work itself is in stores/files.ts.
 */
export function useFileActions(path: Ref<string | null>, focus: (key: string) => void) {
  const ws = useWorkspace()
  const files = useFiles()

  const edit = ref<NameEdit | null>(null)
  watch(path, () => { edit.value = null })

  function open(next: Omit<NameEdit, 'id' | 'error' | 'busy'>) {
    if (edit.value?.busy) return
    edit.value = { ...next, id: ++editSeq, error: null, busy: false }
  }

  function startNew(mode: 'file' | 'folder', dir: string) {
    const project = path.value
    if (!project) return
    // Every folder on the way shows, so the field has a row to sit under.
    const parts = dir ? dir.split('/') : []
    for (let i = 1; i <= parts.length; i++) files.toggleDir(project, parts.slice(0, i).join('/'), true)
    open({ mode, dir, path: '', isDir: mode === 'folder' })
  }

  function startRename(entry: FsEntry) {
    open({ mode: 'rename', dir: parentOf(entry.path), path: entry.path, isDir: entry.isDir })
  }

  function cancel(left: boolean) {
    const was = edit.value
    edit.value = null
    if (!left && was) nextTick(() => focus(was.mode === 'rename' ? was.path : was.dir))
  }

  function clearError() {
    if (edit.value) edit.value.error = null
  }

  /** Exclusions follow what they name. A worktree's rename is not the project's. */
  function moveExclusions(project: string, from: string, to: string) {
    if (project !== ws.activeProjectPath) return
    const marks = excludedPathsOf(ws.projectPrefs[project]?.excluded)
    const next = marks.map(m => movedPath(m, from, to) ?? m)
    if (next.some((m, i) => m !== marks[i])) ws.setProjectPref(project, { excluded: next })
  }

  async function commit(name: string, left: boolean) {
    const e = edit.value
    const project = path.value
    if (!e || !project || e.busy) return
    const problem = nameProblem(name)
    if (problem) {
      if (!left) e.error = problem
      else {
        // Leaving a field that already showed its problem gives the name up.
        if (!e.error) ws.notify(e.mode === 'rename' ? 'Could not rename' : 'Could not create', problem)
        edit.value = null
      }
      return
    }
    const target = pathIn(e.dir, name)
    if (e.mode === 'rename' && target === e.path) return cancel(left)

    e.error = null
    e.busy = true
    try {
      if (e.mode === 'rename') {
        await files.renameEntry(project, e.path, name)
        moveExclusions(project, e.path, target)
      } else {
        await files.createEntry(project, target, e.mode === 'folder')
      }
    } catch (err) {
      if (edit.value?.id !== e.id) return
      e.busy = false
      if (!left) e.error = reason(err)
      else {
        edit.value = null
        ws.notify(e.mode === 'rename' ? 'Could not rename' : 'Could not create', reason(err))
      }
      return
    }
    if (edit.value?.id === e.id) edit.value = null
    // The user moved on to another project meanwhile.
    if (path.value !== project) return
    await files.reveal(project, target)
    if (e.mode === 'file') await files.openFile(project, target, true)
    else if (!left) await nextTick(() => focus(target))
  }

  async function duplicate(entry: FsEntry) {
    const project = path.value
    if (!project) return
    const dir = parentOf(entry.path)
    const taken = files.treeOf(project).dirs[dir]?.entries?.map(e => e.name) ?? []
    const name = copyName(nameOf(entry.path), taken)
    try {
      await files.duplicateFile(project, entry.path, name)
      if (path.value !== project) return
      const copy = pathIn(dir, name)
      await files.reveal(project, copy)
      const made = files.treeOf(project).dirs[dir]?.entries?.find(e => e.path === copy)
      // The copy's name is ready to be changed.
      if (made) await nextTick(() => startRename(made))
    } catch (err) {
      ws.notify('Could not duplicate', reason(err))
    }
  }

  /** Ask, then delete. What the trash cannot take is asked about again, as a delete for good. `asked` runs with each question. */
  function askDelete(entry: FsEntry, then: () => void, asked: () => void) {
    const project = path.value
    if (!project) return
    const name = nameOf(entry.path)
    const unsaved = files.unsavedWithin(project, entry.path)
    const losses = unsaved.length === 1
      ? ` Your unsaved changes to ${unsaved[0]} will be lost.`
      : unsaved.length ? ` Your unsaved changes to ${unsaved.length} files will be lost.` : ''
    const what = entry.isDir ? `${entry.path} and everything in it` : entry.path

    const run = async (permanent: boolean) => {
      try {
        const got = await files.deleteEntry(project, entry.path, entry.isDir, permanent)
        if (got.deleted) {
          if (path.value === project) await nextTick(then)
        } else {
          forGood(`${got.reason ?? ''} `)
        }
      } catch (err) {
        ws.notify(`Could not delete ${name}`, reason(err))
      }
    }
    const forGood = (why: string) => {
      ws.confirm = {
        title: `Delete ${name} permanently?`,
        body: `${why}This deletes ${what} for good and cannot be undone.${losses}`,
        label: 'Delete permanently',
        danger: true,
        run: () => void run(true),
      }
      asked()
    }

    if (isEnvPath(project)) return forGood('Remote environments have no trash. ')
    ws.confirm = {
      title: `Delete ${name}?`,
      body: `This moves ${what} to the ${trashName()}.${losses}`,
      label: `Move to ${trashName()}`,
      danger: true,
      run: () => void run(false),
    }
    asked()
  }

  async function showInFileManager(rel: string) {
    if (!path.value) return
    try {
      await call('fs_reveal', { root: path.value, path: rel })
    } catch (err) {
      ws.notify(`Could not show it in ${fileManagerName()}`, reason(err))
    }
  }

  function openTerminal(dir: string) {
    const project = path.value
    if (!project) return
    const env = parseEnvPath(project)
    if (!dir) ws.newTerminal(project)
    else if (env) ws.newTerminal(envPath({ ...env, dir: withTrailingSep(env.dir) + dir }))
    else ws.newTerminal(withTrailingSep(project) + dir.split('/').join(sepOf(project)))
  }

  return { edit, startNew, startRename, cancel, clearError, commit, duplicate, askDelete, showInFileManager, openTerminal }
}
