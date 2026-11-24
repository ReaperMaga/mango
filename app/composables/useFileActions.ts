import type { Ref } from 'vue'
import type { FsEntry } from '~/types/ipc'
import { call } from '~/composables/useBackend'
import { t } from '~/i18n'
import { useWorkspace } from '~/stores/workspace'
import { useFiles } from '~/stores/files'
import { excludedPathsOf } from '~/utils/fileTree'
import { copyName, movedPath, nameOf, nameProblem, parentOf, pathIn } from '~/utils/fileOps'
import { SplitError } from '~/utils/companions'
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
/** Windows calls its trash by another name. */
const recycles = () => onPlatform(/Win/)
/** Which file manager the system has. */
export const fileManager = () => (onPlatform(/Win/) ? 'explorer' : onPlatform(/Mac/) ? 'finder' : 'other')

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
        if (!e.error) ws.notify(e.mode === 'rename' ? t('files.op.renameFailed') : t('files.op.createFailed'), problem)
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
        for (const m of await files.renameEntry(project, e.path, name, e.isDir)) moveExclusions(project, m.from, m.to)
      } else {
        await files.createEntry(project, target, e.mode === 'folder')
      }
    } catch (err) {
      // A pair that is apart is said out loud: its row, and the field with it, may be gone.
      if (err instanceof SplitError || (e.mode === 'rename' && edit.value?.id !== e.id)) {
        if (edit.value?.id === e.id) edit.value = null
        ws.notify(t('files.op.renameFailed'), reason(err))
        return
      }
      if (edit.value?.id !== e.id) return
      e.busy = false
      if (!left) e.error = reason(err)
      else {
        edit.value = null
        ws.notify(e.mode === 'rename' ? t('files.op.renameFailed') : t('files.op.createFailed'), reason(err))
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
      ws.notify(t('files.op.duplicateFailed'), reason(err))
    }
  }

  /** Ask, then delete. What the trash cannot take is asked about again, as a delete for good. `asked` runs with each question. */
  async function askDelete(entry: FsEntry, then: () => void, asked: () => void) {
    const project = path.value
    if (!project) return
    const name = nameOf(entry.path)
    // Read from the disk before asking: the question names everything that goes, and only that goes.
    let along: string[]
    try {
      along = await files.companionPaths(project, entry.path, entry.isDir)
    } catch (err) {
      ws.notify(t('files.op.deleteFailed', { name }), reason(err))
      return
    }
    // What is being edited goes to the trash as edited, so there is mostly nothing to lose.
    await files.saveAll(3000, f => f.projectPath === project)
    if (path.value !== project) return
    const unsaved = [entry.path, ...along].flatMap(p => files.unsavedWithin(project, p))
    const losses = unsaved.length === 1
      ? ` ${t('files.delete.unsavedFile', { file: unsaved[0] })}`
      : unsaved.length ? ` ${t('files.delete.unsavedFiles', unsaved.length)}` : ''
    const all = { path: entry.path, names: along.map(nameOf).join(', ') }
    const what = entry.isDir
      ? along.length ? t('files.delete.folderAlong', all) : t('files.delete.folder', all)
      : along.length ? t('files.delete.fileAlong', all) : entry.path

    const run = async (permanent: boolean) => {
      try {
        const got = await files.deleteEntry(project, entry.path, entry.isDir, permanent, along)
        if (got.deleted) {
          if (got.left.length) {
            const why = got.left[0]!.why.trim().replace(/[.!]+$/, '')
            ws.notify(t('files.delete.partly', { name, names: got.left.map(l => nameOf(l.path)).join(', ') }), `${why ? `${why}. ` : ''}${t('files.delete.partlyHint')}`)
          }
          if (path.value === project) await nextTick(then)
        } else {
          forGood(`${got.reason ?? ''} `)
        }
      } catch (err) {
        ws.notify(t('files.op.deleteFailed', { name }), reason(err))
      }
    }
    const forGood = (why: string) => {
      ws.confirm = {
        title: t('files.delete.titleForGood', { name }),
        body: `${why}${t('files.delete.bodyForGood', { what })}${losses}`,
        label: t('files.delete.forGood'),
        danger: true,
        run: () => void run(true),
      }
      asked()
    }

    if (isEnvPath(project)) return forGood(`${t('files.delete.noTrash')} `)
    ws.confirm = {
      title: t('files.delete.title', { name }),
      body: (recycles() ? t('files.delete.bodyRecycleBin', { what }) : t('files.delete.bodyTrash', { what })) + losses,
      label: recycles() ? t('files.delete.toRecycleBin') : t('files.delete.toTrash'),
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
      ws.notify(t(`files.showInFailed.${fileManager()}`), reason(err))
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
