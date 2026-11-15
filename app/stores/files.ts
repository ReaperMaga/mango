import { defineStore } from 'pinia'
import type { FsEntry } from '~/types/ipc'
import { call } from '~/composables/useBackend'
import { useThreads } from '~/stores/threads'
import { fileTabId, isFileTab, parseFileTab } from '~/utils/fileTabs'
import { disposeEditorModel, editorModel } from '~/utils/editorModels'

/**
 * The Files view and the editor tabs it opens. The tree is read one folder at
 * a time as it is expanded. An open file keeps what was last read from or
 * written to disk here; the text being edited lives in its Monaco model
 * (`utils/editorModels.ts`), which saving reads from.
 */

export interface DirState {
  entries: FsEntry[] | null
  loading: boolean
  error: string | null
  truncated: boolean
}

export interface ProjectTree {
  /** Listings by folder path ("" is the top). */
  dirs: Record<string, DirState>
  /** Folders shown open. */
  expanded: string[]
  /** The row last opened or moved to with the keyboard. */
  selected: string | null
}

export interface OpenFile {
  projectPath: string
  file: string
  loading: boolean
  /** Why it could not be read (or no longer exists). */
  error: string | null
  binary: boolean
  tooLarge: boolean
  size: number
  bom: boolean
  /** The text on disk as of `modifiedMs`; null until read. */
  disk: string | null
  modifiedMs: number
  /** Bumped when `disk` is replaced from outside, so the editor reloads its model. */
  version: number
  /** The editor's text differs from `disk`. */
  dirty: boolean
  saving: boolean
  saveError: string | null
  /** The file changed on disk while it had unsaved edits (found on save or on a recheck). */
  conflict: boolean
  /** A close was asked for while dirty: the pane asks to save first. */
  closing: boolean
}

const reason = (e: unknown) => (typeof e === 'string' ? e : e instanceof Error ? e.message : String(e)).trim() || 'Something went wrong'

const newTree = (): ProjectTree => ({ dirs: {}, expanded: [], selected: null })

export const useFiles = defineStore('files', {
  state: () => ({
    trees: {} as Record<string, ProjectTree>,
    open: {} as Record<string, OpenFile>,
    /**
     * Per project, the tab opened with a single click. The next single click
     * replaces it instead of piling up tabs; editing it or double-clicking keeps it.
     */
    preview: {} as Record<string, string | null>,
  }),

  getters: {
    tree: s => (path: string | null | undefined): ProjectTree | null => (path ? s.trees[path] ?? null : null),
    file: s => (tabId: string | null | undefined): OpenFile | null => (tabId ? s.open[tabId] ?? null : null),
    isDirty: s => (tabId: string | null | undefined) => !!(tabId && s.open[tabId]?.dirty),
    isPreview: s => (tabId: string) => {
      const p = parseFileTab(tabId)
      return !!p && s.preview[p.projectPath] === tabId
    },
  },

  actions: {
    treeOf(path: string): ProjectTree {
      // Read back through the store: `??=` would hand out the raw, non-reactive object.
      if (!this.trees[path]) this.trees[path] = newTree()
      return this.trees[path]!
    },

    /* ---------- tree ---------- */

    /** Read one folder. `quiet` keeps the old entries on screen while it reloads. */
    async loadDir(projectPath: string, dir: string, quiet = false) {
      const tree = this.treeOf(projectPath)
      if (!tree.dirs[dir]) tree.dirs[dir] = { entries: null, loading: false, error: null, truncated: false }
      const state = tree.dirs[dir]!
      if (!quiet) state.loading = true
      try {
        const listing = await call('fs_list_dir', { root: projectPath, dir })
        state.entries = listing.entries
        state.truncated = listing.truncated
        state.error = null
      } catch (e) {
        // A folder that went away (deleted, branch switched) closes quietly.
        if (dir && quiet) {
          delete tree.dirs[dir]
          tree.expanded = tree.expanded.filter(d => d !== dir && !d.startsWith(`${dir}/`))
        } else {
          state.error = reason(e)
        }
      } finally {
        state.loading = false
      }
    },

    /** First look at a project: list its top folder. */
    ensureTree(projectPath: string) {
      const tree = this.treeOf(projectPath)
      if (!tree.dirs['']) void this.loadDir(projectPath, '')
    },

    toggleDir(projectPath: string, dir: string, open?: boolean) {
      const tree = this.treeOf(projectPath)
      const isOpen = tree.expanded.includes(dir)
      const next = open ?? !isOpen
      if (next === isOpen) return
      if (next) {
        tree.expanded.push(dir)
        if (!tree.dirs[dir]?.entries) void this.loadDir(projectPath, dir)
      } else {
        tree.expanded = tree.expanded.filter(d => d !== dir)
      }
    },

    collapseAll(projectPath: string) {
      this.treeOf(projectPath).expanded = []
    },

    /** Open every folder on the way to `file` and select it. */
    async reveal(projectPath: string, file: string) {
      const tree = this.treeOf(projectPath)
      const parts = file.split('/')
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/')
        if (!tree.expanded.includes(dir)) tree.expanded.push(dir)
        if (!tree.dirs[dir]?.entries) await this.loadDir(projectPath, dir)
      }
      tree.selected = file
    },

    /** Re-read what is on screen: open folders and open files. After focus, an agent's turn, a git action. */
    async refresh(projectPath: string) {
      const tree = this.trees[projectPath]
      if (tree) {
        const dirs = ['', ...tree.expanded].filter(d => tree.dirs[d]?.entries)
        await Promise.all(dirs.map(d => this.loadDir(projectPath, d, true)))
      }
      await Promise.all(Object.keys(this.open)
        .filter(id => this.open[id]!.projectPath === projectPath)
        .map(id => this.recheck(id)))
    },

    /* ---------- open files ---------- */

    /**
     * Show a file in the active pane. A single click (`pin` false) reuses the
     * project's preview tab; `pin` opens a tab that stays.
     */
    async openFile(projectPath: string, file: string, pin = false) {
      const threads = useThreads()
      const id = fileTabId(projectPath, file)
      this.treeOf(projectPath).selected = file
      if (!this.open[id]) {
        this.open[id] = {
          projectPath, file, loading: true, error: null, binary: false, tooLarge: false, size: 0, bom: false,
          disk: null, modifiedMs: 0, version: 0, dirty: false, saving: false, saveError: null, conflict: false, closing: false,
        }
        void this.read(id)
      }
      const wasOpen = threads.tabs.includes(id)
      const preview = this.preview[projectPath] ?? null
      if (!wasOpen && !pin && preview && preview !== id && threads.tabs.includes(preview) && !this.open[preview]?.dirty) {
        threads.replaceTab(preview, id)
        this.forget(preview)
      }
      threads.show(id)
      if (pin) this.pin(id)
      else if (!wasOpen) this.preview[projectPath] = id
    },

    /** Keep a preview tab open (it was edited or double-clicked). */
    pin(tabId: string) {
      const p = parseFileTab(tabId)
      if (p && this.preview[p.projectPath] === tabId) this.preview[p.projectPath] = null
    },

    async read(tabId: string) {
      const f = this.open[tabId]
      if (!f) return
      f.loading = true
      try {
        const c = await call('fs_read_file', { root: f.projectPath, file: f.file })
        Object.assign(f, {
          error: null, binary: c.binary, tooLarge: c.tooLarge, size: c.size, bom: c.bom,
          disk: c.text, modifiedMs: c.modifiedMs, dirty: false, conflict: false, saveError: null,
        })
        f.version++
      } catch (e) {
        f.error = reason(e)
      } finally {
        f.loading = false
      }
    },

    /** Has the file changed on disk? Reload a clean one; flag a dirty one. */
    async recheck(tabId: string) {
      const f = this.open[tabId]
      if (!f || f.loading || f.saving || f.disk === null && !f.error) return
      try {
        const c = await call('fs_read_file', { root: f.projectPath, file: f.file })
        if (c.modifiedMs === f.modifiedMs && !f.error) return
        if (f.dirty) {
          if (c.text !== f.disk) f.conflict = true
          return
        }
        Object.assign(f, { error: null, binary: c.binary, tooLarge: c.tooLarge, size: c.size, bom: c.bom, modifiedMs: c.modifiedMs })
        if (c.text !== f.disk) {
          f.disk = c.text
          f.version++
        }
      } catch (e) {
        if (!f.dirty) f.error = reason(e)
      }
    },

    /** The editor reports whether its text differs from disk. */
    setDirty(tabId: string, dirty: boolean) {
      const f = this.open[tabId]
      if (!f || f.dirty === dirty) return
      f.dirty = dirty
      if (dirty) this.pin(tabId)
    },

    /** Write the editor's text. `force` overwrites a file that changed on disk. Resolves true when saved. */
    async save(tabId: string, force = false): Promise<boolean> {
      const f = this.open[tabId]
      const entry = editorModel(tabId)
      if (!f || !entry || entry.model.isDisposed() || f.saving) return false
      const text = entry.model.getValue()
      const version = entry.model.getAlternativeVersionId()
      f.saving = true
      f.saveError = null
      try {
        const res = await call('fs_write_file', {
          root: f.projectPath, file: f.file, text, bom: f.bom, expectedModifiedMs: force ? null : f.modifiedMs,
        })
        if (!res.saved) {
          f.conflict = true
          return false
        }
        f.disk = text
        f.modifiedMs = res.modifiedMs
        entry.savedVersion = version
        // Typing went on while it saved: still dirty.
        f.dirty = !entry.model.isDisposed() && entry.model.getAlternativeVersionId() !== version
        f.conflict = false
        return true
      } catch (e) {
        f.saveError = reason(e)
        return false
      } finally {
        f.saving = false
      }
    },

    /** Throw away the edits and show what is on disk now. */
    async revert(tabId: string) {
      const f = this.open[tabId]
      if (!f) return
      f.dirty = false
      await this.read(tabId)
    },

    /** A tab is closing: the editor model goes with it. */
    forget(tabId: string) {
      delete this.open[tabId]
      disposeEditorModel(tabId)
      const p = parseFileTab(tabId)
      if (p && this.preview[p.projectPath] === tabId) this.preview[p.projectPath] = null
    },

    /** The pane's "save before closing?" bar. */
    askClose(tabId: string) {
      const f = this.open[tabId]
      if (f) f.closing = true
    },
    cancelClose(tabId: string) {
      const f = this.open[tabId]
      if (f) f.closing = false
    },
  },
})

/** Close a file tab even with unsaved edits (after the user said so). */
export function closeFileTab(tabId: string) {
  if (!isFileTab(tabId)) return
  const files = useFiles()
  const f = files.open[tabId]
  if (f) { f.dirty = false; f.closing = false }
  useThreads().closeTab(tabId)
}
