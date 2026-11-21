import { defineStore } from 'pinia'
import type { FileContent, FsAhead, FsEntry } from '~/types/ipc'
import { call } from '~/composables/useBackend'
import { useThreads } from '~/stores/threads'
import { fileTabId, isFileTab, parseFileTab } from '~/utils/fileTabs'
import { disposeEditorModel, editorModel } from '~/utils/editorModels'
import { imageKind, imageMime } from '~/utils/imageFiles'

/**
 * The Files view and the editor tabs it opens. The tree is read as it is
 * expanded, each folder with its subfolders' listings ahead (`fs_list_dir`
 * with `ahead`), so opening a folder shows it at once and reads the next level
 * in the background. Listings stay here between visits: the panel shows them
 * at once when it comes back and re-reads them quietly. A file the pointer
 * rests on is read ahead (`preload`), so clicking it opens it at once. An open file keeps what was last read from or
 * written to disk here; the text being edited lives in its Monaco model
 * (`utils/editorModels.ts`), which saving reads from.
 */

export interface DirState {
  entries: FsEntry[] | null
  loading: boolean
  error: string | null
  truncated: boolean
  /** Its subfolders were read ahead with it (otherwise it was itself read ahead, or refreshed alone). */
  ahead: boolean
  /** When the listing on screen was asked for (ms), so an older answer never replaces a newer one. */
  readAt: number
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
  /** A picture (PNG, JPEG, …) as a data URL, read instead of text; null for everything else. */
  image: string | null
  /** An SVG shows as a picture or as its source. */
  view: 'preview' | 'code'
}

const reason = (e: unknown) => (typeof e === 'string' ? e : e instanceof Error ? e.message : String(e)).trim() || 'Something went wrong'

/** The backend's words for a folder that is not there (any more): unlike a failed connection, not passing. */
const gone = (why: string) => /no longer exists|is not a folder|links to a place outside/.test(why)

const newTree = (): ProjectTree => ({ dirs: {}, expanded: [], selected: null })
const newDir = (): DirState => ({ entries: null, loading: false, error: null, truncated: false, ahead: false, readAt: 0 })

/** A folder opened again after this long is re-read quietly (it shows what was read before meanwhile). */
const STALE_MS = 10_000
/** The panel coming back (reopened, project switched back) re-reads the tree when it is older than this. */
const REVISIT_MS = 3_000

/** Folder reads under way, by project and folder: a second ask joins the first. */
const listing = new Map<string, Promise<void>>()
const dirKey = (projectPath: string, dir: string) => `${projectPath}\0${dir}`

/**
 * Files read ahead of opening (`preload`), by tab id: the read (or its result) and when it was
 * asked for. A few only, kept briefly, dropped when the project is refreshed; opening one that
 * is more than a moment old shows it at once and checks it against the disk right after.
 */
interface Preload { at: number; read: Promise<FileContent> }
const preloads = new Map<string, Preload>()
const PRELOAD_MAX = 10
/** Older reads are not used. */
const PRELOAD_TTL = 30_000
/** Used as read if this recent; otherwise shown and checked again. */
const PRELOAD_FRESH = 2_000
/** Only files up to this size are read ahead (larger ones come back `tooLarge` and are read on open). */
const PRELOAD_LIMIT = 256 * 1024

function takePreload(tabId: string): Preload | null {
  const p = preloads.get(tabId)
  preloads.delete(tabId)
  return p && Date.now() - p.at < PRELOAD_TTL ? p : null
}

/** What a text read says about a file, for an open file's state. */
const textState = (c: FileContent) => ({
  error: null, binary: c.binary, tooLarge: c.tooLarge, size: c.size, bom: c.bom,
  disk: c.text, modifiedMs: c.modifiedMs, dirty: false, conflict: false, saveError: null,
})

export const useFiles = defineStore('files', {
  state: () => ({
    trees: {} as Record<string, ProjectTree>,
    open: {} as Record<string, OpenFile>,
    /**
     * Per project, the tab opened with a single click. The next single click
     * replaces it instead of piling up tabs; editing it or double-clicking keeps it.
     */
    preview: {} as Record<string, string | null>,
    /** A line to bring into view in a file tab once its editor shows it (1-based), by tab id. */
    lines: {} as Record<string, number>,
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

    /**
     * Read one folder. `quiet` keeps the old entries on screen while it reloads. `ahead` reads
     * some of its subfolders in the same call and keeps their listings, so they open at once.
     * A read of the same folder already under way is joined, not repeated.
     */
    loadDir(projectPath: string, dir: string, quiet = false, ahead = true): Promise<void> {
      const key = dirKey(projectPath, dir)
      const running = listing.get(key)
      if (running) return running
      const read = this._readDir(projectPath, dir, quiet, ahead).finally(() => listing.delete(key))
      listing.set(key, read)
      return read
    },

    async _readDir(projectPath: string, dir: string, quiet: boolean, ahead: boolean) {
      const tree = this.treeOf(projectPath)
      if (!tree.dirs[dir]) tree.dirs[dir] = newDir()
      const state = tree.dirs[dir]!
      if (!quiet) state.loading = true
      const asked = Date.now()
      try {
        const got = await call('fs_list_dir', { root: projectPath, dir, ahead })
        state.entries = got.entries
        state.truncated = got.truncated
        state.error = null
        state.readAt = asked
        if (ahead) state.ahead = true
        for (const sub of got.ahead ?? []) this._seed(projectPath, sub, asked)
      } catch (e) {
        const why = reason(e)
        if (quiet && state.entries && !gone(why)) {
          // A connection that dropped (a remote project) or another passing failure: keep what is
          // shown, the next refresh (or the connection coming back) reads it again.
        } else if (dir && quiet) {
          // A folder that went away (deleted, branch switched) closes quietly.
          delete tree.dirs[dir]
          tree.expanded = tree.expanded.filter(d => d !== dir && !d.startsWith(`${dir}/`))
        } else {
          state.error = why
        }
      } finally {
        state.loading = false
      }
    },

    /** Keep a subfolder's listing read ahead, unless a newer one is here or on its way. */
    _seed(projectPath: string, sub: FsAhead, asked: number) {
      const tree = this.treeOf(projectPath)
      const had = tree.dirs[sub.dir]
      if (had && had.readAt > asked || listing.has(dirKey(projectPath, sub.dir))) return
      if (!had) {
        tree.dirs[sub.dir] = { ...newDir(), entries: sub.entries, readAt: asked }
        return
      }
      Object.assign(had, { entries: sub.entries, truncated: false, error: null, readAt: asked })
    },

    /**
     * Show a project's tree. The first time, read its top folder; when it comes back into view
     * (panel reopened, project switched back), show what was read before and re-read it quietly.
     */
    ensureTree(projectPath: string) {
      const top = this.treeOf(projectPath).dirs['']
      if (!top || !top.entries && !top.loading) void this.loadDir(projectPath, '')
      else if (top.entries && Date.now() - top.readAt > REVISIT_MS) void this.refreshTree(projectPath)
    },

    /** A folder with a listing already here: re-read it quietly when it was only read ahead or is old. */
    _freshen(projectPath: string, dir: string) {
      const state = this.treeOf(projectPath).dirs[dir]
      if (!state?.entries) return false
      if (!state.ahead || Date.now() - state.readAt > STALE_MS) void this.loadDir(projectPath, dir, true)
      return true
    },

    toggleDir(projectPath: string, dir: string, open?: boolean) {
      const tree = this.treeOf(projectPath)
      const isOpen = tree.expanded.includes(dir)
      const next = open ?? !isOpen
      if (next === isOpen) return
      if (next) {
        tree.expanded.push(dir)
        if (!this._freshen(projectPath, dir)) void this.loadDir(projectPath, dir)
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
        if (!this._freshen(projectPath, dir)) await this.loadDir(projectPath, dir)
      }
      tree.selected = file
    },

    /** Re-read what is on screen: open folders and open files. After focus, an agent's turn, a git action. */
    async refresh(projectPath: string) {
      // Files read ahead may be out of date now.
      for (const id of preloads.keys()) if (parseFileTab(id)?.projectPath === projectPath) preloads.delete(id)
      await this.refreshTree(projectPath)
      await Promise.all(Object.keys(this.open)
        .filter(id => this.open[id]!.projectPath === projectPath)
        .map(id => this.recheck(id)))
    },

    /**
     * Re-read the open folders, quietly. Without reading ahead: it runs often (focus, every
     * change), and a folder read ahead is read again when it opens.
     */
    async refreshTree(projectPath: string) {
      const tree = this.trees[projectPath]
      if (!tree) return
      const dirs = ['', ...tree.expanded].filter(d => tree.dirs[d]?.entries)
      await Promise.all(dirs.map(d => this.loadDir(projectPath, d, true, false)))
    },

    /* ---------- open files ---------- */

    /**
     * Read a file ahead of opening it (the pointer rests on it, or the keyboard moved to it), so a
     * click shows it at once. Text files up to 256 KB only; pictures, open files and files already
     * read (or being read) are left alone.
     */
    preload(projectPath: string, file: string) {
      const id = fileTabId(projectPath, file)
      if (this.open[id] || imageKind(file) === 'raster') return
      const had = preloads.get(id)
      if (had && Date.now() - had.at < PRELOAD_TTL) return
      const read = call('fs_read_file', { root: projectPath, file, limit: PRELOAD_LIMIT })
      const entry = { at: Date.now(), read }
      preloads.delete(id)
      preloads.set(id, entry)
      // Least recently asked for goes first.
      while (preloads.size > PRELOAD_MAX) preloads.delete(preloads.keys().next().value!)
      // A failed read is not kept; a file too large to read ahead is remembered as such (and read when it opens).
      read.catch(() => { if (preloads.get(id) === entry) preloads.delete(id) })
    },

    /** The first read of a file just opened: what `preload` read when there is one, else from disk. */
    async _firstRead(tabId: string) {
      const f = this.open[tabId]
      const pre = takePreload(tabId)
      if (f && pre) {
        try {
          const c = await pre.read
          if (this.open[tabId] === f && !c.tooLarge) {
            Object.assign(f, textState(c), { loading: false })
            f.version++
            // Read a while ago: show it, then make sure it is still what is on disk.
            if (Date.now() - pre.at > PRELOAD_FRESH) void this.recheck(tabId)
            return
          }
        } catch { /* read it again below, for its error */ }
      }
      if (this.open[tabId] === f) await this.read(tabId)
    },

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
          image: null, view: 'preview',
        }
        void this._firstRead(id)
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

    /** Show a line of an open file tab: its editor scrolls there and puts the cursor on it (now, or once it shows the file). */
    revealLine(tabId: string, line: number) {
      if (Number.isFinite(line) && line >= 1) this.lines[tabId] = Math.floor(line)
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
        if (imageKind(f.file) === 'raster') {
          const b = await call('fs_read_bytes', { root: f.projectPath, file: f.file })
          Object.assign(f, {
            error: null, binary: false, tooLarge: false, size: b.size, bom: false, disk: null,
            image: `data:${imageMime(f.file)};base64,${b.data}`, modifiedMs: b.modifiedMs, dirty: false, conflict: false, saveError: null,
          })
          f.version++
          return
        }
        const c = await call('fs_read_file', { root: f.projectPath, file: f.file })
        Object.assign(f, textState(c))
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
      if (!f || f.loading || f.saving || f.disk === null && !f.image && !f.error) return
      if (imageKind(f.file) === 'raster') {
        try {
          const b = await call('fs_read_bytes', { root: f.projectPath, file: f.file })
          if (b.modifiedMs === f.modifiedMs && !f.error) return
          Object.assign(f, { error: null, size: b.size, modifiedMs: b.modifiedMs, image: `data:${imageMime(f.file)};base64,${b.data}` })
          f.version++
        } catch (e) {
          f.error = reason(e)
        }
        return
      }
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
      preloads.delete(tabId)
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

    /** Show an SVG as a picture or as its source. */
    setView(tabId: string, view: 'preview' | 'code') {
      const f = this.open[tabId]
      if (f) f.view = view
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
