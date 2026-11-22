import { defineStore } from 'pinia'
import type { FileContent, FsAhead, FsDeleted, FsEntry } from '~/types/ipc'
import { call } from '~/composables/useBackend'
import { useGit } from '~/stores/git'
import { useThreads } from '~/stores/threads'
import { useWorkspace } from '~/stores/workspace'
import { canAutoSave, compareDisk, createAutoSave, keepsBackup, overlaps, saveFailure, saveTiming } from '~/utils/autoSave'
import { envPath, movedEnvPath, parseEnvPath } from '~/utils/envPath'
import { useLanguageServers } from '~/lsp/store'
import { fileTabId, isFileTab, parseFileTab } from '~/utils/fileTabs'
import { disposeEditorModel, editorModel, moveEditorModel } from '~/utils/editorModels'
import { imageKind, imageMime } from '~/utils/imageFiles'
import { isWithin, movedPath, nameOf, parentOf, pathIn } from '~/utils/fileOps'
import { requiredSuffixes } from '~/plugin-host/fileHooks'
import { SplitError, companionsOf, removeTogether, renameTogether, type Folder, type Move } from '~/utils/companions'

/**
 * The Files view and the editor tabs it opens. The tree is read as it is
 * expanded, each folder with its subfolders' listings ahead (`fs_list_dir`
 * with `ahead`), so opening a folder shows it at once and reads the next level
 * in the background. Listings stay here between visits: the panel shows them
 * at once when it comes back and re-reads them quietly. A file the pointer
 * rests on is read ahead (`preload`), so clicking it opens it at once. An open file keeps what was last read from or
 * written to disk here; the text being edited lives in its Monaco model
 * (`utils/editorModels.ts`), which saving reads from.
 *
 * Files save themselves unless Settings > Editor says not to: `utils/autoSave.ts` decides when, this
 * store writes. What changes project files from outside the editor goes through `aroundChange`, and
 * what only reads them through `aroundRead` or `saveAll` first.
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
  /**
   * The file last asked for by name (`reveal`): the panel scrolls to it, and shows it even where
   * the view hides it. A new object each time, so asking again scrolls again.
   */
  revealed: { file: string } | null
  /** Folders a row's name depends on (compact folders): refreshed with the open ones. */
  chained: string[]
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
  /** The hash of those bytes (`FileContent.hash`): what a save expects to find. */
  hash: string | null
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

/** What became of a delete, with the companions that stayed behind (`ui.files.companions`) and why. */
export interface EntryDeleted extends FsDeleted {
  left: { path: string, why: string }[]
}

/** The backend's words for a folder that is not there (any more): unlike a failed connection, not passing. */
const gone = (why: string) => /no longer exists|is not a folder|links to a place outside/.test(why)

const newTree = (): ProjectTree => ({ dirs: {}, expanded: [], selected: null, revealed: null, chained: [] })
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
  disk: c.text, modifiedMs: c.modifiedMs, hash: c.hash ?? null, dirty: false, conflict: false, saveError: null,
})

/* ---------- saving ---------- */

/** Picks open files: by their project, folder or path. */
type Match = (f: OpenFile) => boolean
const unsaved = (f: OpenFile) => f.dirty || f.saving
const autoSaves = () => useWorkspace().editorAutoSave

/** The text a write under way, or one that failed, sent: found on disk, it was written after all. */
const attempted = new WeakMap<OpenFile, string>()
/** Moves with every read and write of a file, so an answer that was overtaken is dropped. */
const revs = new WeakMap<OpenFile, number>()
function nextRev(f: OpenFile) {
  const rev = (revs.get(f) ?? 0) + 1
  revs.set(f, rev)
  return rev
}

/** Projects whose open files are being rechecked (`recheckOpen`), and whether to once more. */
const rechecking = new Map<string, boolean>()
/** Changes that come together are read once. */
const RECHECK_GATHER_MS = 150

let saver: ReturnType<typeof createAutoSave<OpenFile>> | null = null
function autoSave() {
  return saver ??= createAutoSave<OpenFile>({
    on: autoSaves,
    open: () => Object.values(useFiles().open),
    timing: f => saveTiming(!!parseEnvPath(f.projectPath), f.disk?.length ?? 0),
    lane: f => (parseEnvPath(f.projectPath) ? f.projectPath : null),
    write: (f, force) => useFiles()._write(f, force),
  })
}

export const useFiles = defineStore('files', {
  state: () => ({
    trees: {} as Record<string, ProjectTree>,
    open: {} as Record<string, OpenFile>,
    /**
     * Per project, the tab opened with a single click. The next single click
     * replaces it instead of piling up tabs; editing it or double-clicking keeps it.
     */
    preview: {} as Record<string, string | null>,
    /** Entries being deleted, as `dirKey`: a big folder takes a while. */
    deleting: [] as string[],
    /** A line to bring into view in a file tab once its editor shows it (1-based), by tab id. */
    lines: {} as Record<string, number>,
  }),

  getters: {
    tree: s => (path: string | null | undefined): ProjectTree | null => (path ? s.trees[path] ?? null : null),
    file: s => (tabId: string | null | undefined): OpenFile | null => (tabId ? s.open[tabId] ?? null : null),
    isDeleting: s => (projectPath: string, path: string) => s.deleting.includes(dirKey(projectPath, path)),
    /** Open files at or inside `path` with unsaved edits. */
    unsavedWithin: s => (projectPath: string, path: string) =>
      Object.values(s.open).filter(f => f.projectPath === projectPath && f.dirty && isWithin(f.file, path)).map(f => f.file),
    isDirty: s => (tabId: string | null | undefined) => !!(tabId && s.open[tabId]?.dirty),
    /** Closing it now would lose text: edited, or still being written. */
    isUnsaved: s => (tabId: string | null | undefined) => {
      const f = tabId ? s.open[tabId] : null
      return !!f && unsaved(f)
    },
    /** Some open file has text that is not saved. */
    hasUnsaved: s => Object.values(s.open).some(unsaved),
    /** Those files, by whether a save may still get them there (under way, waiting) or can't by itself. */
    unsavedByCause: s => () => {
      const failed: string[] = []
      const saving: string[] = []
      for (const f of Object.values(s.open)) {
        if (unsaved(f)) (f.saving || (!f.saveError && canAutoSave(f)) ? saving : failed).push(f.file)
      }
      return { failed, saving }
    },
    /** Unsaved edits to point out: all of them, or with autosave those it cannot save by itself. */
    showsUnsaved: s => (tabId: string | null | undefined) => {
      const f = tabId ? s.open[tabId] : null
      return !!f?.dirty && (!autoSaves() || f.conflict || f.closing || !!f.saveError)
    },
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
      const tree = this.treeOf(projectPath)
      tree.expanded = []
      tree.revealed = null
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
      tree.revealed = { file }
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
     * Something says it changed files here (`mango:files-changed`): read the open files again, not
     * the folders (whoever changes those reads them). One round at a time, and one after it for what
     * changed meanwhile: each read in a remote project is an SSH round trip.
     */
    async recheckOpen(projectPath: string) {
      for (const id of preloads.keys()) if (parseFileTab(id)?.projectPath === projectPath) preloads.delete(id)
      if (rechecking.has(projectPath)) {
        rechecking.set(projectPath, true)
        return
      }
      try {
        do {
          rechecking.set(projectPath, false)
          await new Promise(resolve => setTimeout(resolve, RECHECK_GATHER_MS))
          rechecking.set(projectPath, false)
          await Promise.all(Object.keys(this.open)
            .filter(id => this.open[id]!.projectPath === projectPath)
            .map(id => this.recheck(id)))
        } while (rechecking.get(projectPath))
      } finally {
        rechecking.delete(projectPath)
      }
    },

    /**
     * Re-read the open folders, quietly. Without reading ahead: it runs often (focus, every
     * change), and a folder read ahead is read again when it opens.
     */
    async refreshTree(projectPath: string) {
      const tree = this.trees[projectPath]
      if (!tree) return
      const dirs = [...new Set(['', ...tree.expanded, ...tree.chained])].filter(d => tree.dirs[d]?.entries)
      await Promise.all(dirs.map(d => this.loadDir(projectPath, d, true, false)))
    },

    /* ---------- file operations ---------- */

    async createEntry(projectPath: string, path: string, folder: boolean) {
      if (folder) await call('fs_create_dir', { root: projectPath, dir: path })
      else await call('fs_create_file', { root: projectPath, file: path, text: '' })
      await this._changed(projectPath, parentOf(path))
    },

    async duplicateFile(projectPath: string, file: string, name: string) {
      await autoSave().flush(f => f.projectPath === projectPath && f.file === file)
      await call('fs_duplicate', { root: projectPath, file, name })
      await this._changed(projectPath, parentOf(file))
    },

    /**
     * Rename in place, with the files that go with it (`ui.files.companions`): all of them or none.
     * Open tabs follow, with their edits, undo history and scroll position. Resolves with every path moved.
     */
    async renameEntry(projectPath: string, from: string, name: string, isDir: boolean): Promise<Move[]> {
      const dir = parentOf(from)
      const to = pathIn(dir, name)
      const suffixes = requiredSuffixes(projectPath, from, isDir)
      const inProject = (moves: Move[]) => moves.map(m => ({ from: pathIn(dir, m.from), to: pathIn(dir, m.to) }))
      let moved: Move[]
      // Nothing is written to the old path meanwhile; edits are saved to the new one afterwards.
      const release = await this._keepStill(f => f.projectPath === projectPath)
      try {
        moved = inProject(await renameTogether(this._folder(projectPath, dir), nameOf(from), name, suffixes, (moves) => {
          for (const m of inProject(moves)) {
            this._refuseWhileSaving(projectPath, m.from)
            // A tab left over from a file that had the new name: it would be replaced, edits and all.
            for (const id of this._tabsWithin(projectPath, m.from)) {
              const next = fileTabId(projectPath, movedPath(this.open[id]!.file, m.from, m.to)!)
              if (next !== id && this.open[next]?.dirty) throw new Error(`A tab with unsaved changes is open as ${this.open[next]!.file}. Close it first.`)
            }
          }
        }))
      } catch (e) {
        if (e instanceof SplitError) for (const m of inProject(e.moved)) this._moveTabs(projectPath, m.from, m.to)
        release()
        if (suffixes.length) await this._changed(projectPath, dir)
        throw e
      }
      for (const m of moved) this._moveTabs(projectPath, m.from, m.to)
      release()

      const tree = this.treeOf(projectPath)
      tree.expanded = tree.expanded.map(d => movedPath(d, from, to) ?? d)
      if (tree.selected) tree.selected = movedPath(tree.selected, from, to) ?? tree.selected
      for (const dir of Object.keys(tree.dirs)) if (dir && isWithin(dir, from)) delete tree.dirs[dir]
      await this._changed(projectPath, parentOf(from))
      await Promise.all(tree.expanded.filter(d => isWithin(d, to)).map(d => this.loadDir(projectPath, d)))
      return moved
    },

    /** The files that go with an entry and are there, read from the disk: what a delete has to name. */
    async companionPaths(projectPath: string, path: string, isDir: boolean): Promise<string[]> {
      const dir = parentOf(path)
      const { found } = await companionsOf(this._folder(projectPath, dir), nameOf(path), requiredSuffixes(projectPath, path, isDir))
      return found.map(c => pathIn(dir, c.name))
    },

    /**
     * Delete, and then `along` (its companions, as `companionPaths` named them and the user was asked
     * about; those that would not go are in `left`). A result that is not `deleted` means the trash
     * cannot take it and nothing happened.
     */
    async deleteEntry(projectPath: string, path: string, isDir: boolean, permanent: boolean, along: string[] = []): Promise<EntryDeleted> {
      // With autosave a save is under way often: it is waited for below.
      if (!autoSaves()) for (const p of [path, ...along]) this._refuseWhileSaving(projectPath, p)
      const key = dirKey(projectPath, path)
      if (this.deleting.includes(key)) throw new Error('It is already being deleted.')
      this.deleting.push(key)
      const going: Match = f => f.projectPath === projectPath && [path, ...along].some(p => isWithin(f.file, p))
      let release = () => {}
      try {
        // The trash gets the text as edited; from then on nothing writes to what goes.
        if (!permanent) await autoSave().flush(going)
        release = await this._keepStill(going)
        const dir = parentOf(path)
        const entry = nameOf(path)
        const got = await removeTogether(this._folder(projectPath, dir), entry, along.map(nameOf), n =>
          call('fs_delete', { root: projectPath, path: pathIn(dir, n), isDir: n === entry && isDir, permanent }))
        const left = got.left.map(l => ({ path: pathIn(dir, l.name), why: l.why }))
        if (!got.deleted) return { deleted: false, reason: got.reason, left }
        for (const id of got.gone.flatMap(n => this._tabsWithin(projectPath, pathIn(dir, n)))) {
          closeFileTab(id)
          if (this.open[id]) this.forget(id)
        }
        const tree = this.treeOf(projectPath)
        tree.expanded = tree.expanded.filter(d => !isWithin(d, path))
        for (const dir of Object.keys(tree.dirs)) if (dir && isWithin(dir, path)) delete tree.dirs[dir]
        if (tree.revealed && isWithin(tree.revealed.file, path)) tree.revealed = null
        await this._changed(projectPath, parentOf(path))
        return { deleted: true, reason: got.reason, left }
      } catch (e) {
        // A folder can be partly gone when deleting it fails.
        await this._changed(projectPath, parentOf(path))
        throw e
      } finally {
        release()
        this.deleting = this.deleting.filter(k => k !== key)
      }
    },

    /** A folder as utils/companions.ts works on it. */
    _folder(projectPath: string, dir: string): Folder {
      return {
        list: async () => {
          const got = await call('fs_list_dir', { root: projectPath, dir })
          return got.truncated ? null : new Set(got.entries.map(e => e.name))
        },
        has: async (name) => {
          try {
            await call('fs_read_file', { root: projectPath, file: pathIn(dir, name), limit: 1 })
            return true
          } catch (e) {
            if (/no longer exists|is not a file/.test(reason(e))) return false
            throw e
          }
        },
        rename: async (from, to) => { await call('fs_rename', { root: projectPath, path: pathIn(dir, from), name: to }) },
      }
    },

    _tabsWithin(projectPath: string, path: string) {
      return Object.keys(this.open).filter(id => this.open[id]!.projectPath === projectPath && isWithin(this.open[id]!.file, path))
    },

    _refuseWhileSaving(projectPath: string, path: string) {
      const saving = this._tabsWithin(projectPath, path).find(id => this.open[id]!.saving)
      if (saving) throw new Error(`${this.open[saving]!.file} is being saved. Try again in a moment.`)
    },

    _moveTabs(projectPath: string, from: string, to: string) {
      const threads = useThreads()
      for (const id of this._tabsWithin(projectPath, from)) {
        const f = this.open[id]!
        const was = f.file
        const file = movedPath(was, from, to)!
        const next = fileTabId(projectPath, file)
        if (next === id) continue
        if (this.open[next]) closeFileTab(next)
        // The same object, so a read under way still lands in it.
        delete this.open[id]
        f.file = file
        this.open[next] = f
        moveEditorModel(id, next)
        if (this.lines[id]) {
          this.lines[next] = this.lines[id]!
          delete this.lines[id]
        }
        if (this.preview[projectPath] === id) this.preview[projectPath] = next
        if (threads.tabs.includes(id)) threads.replaceTab(id, next)
        const asPicture = imageKind(file) === 'raster'
        // A read still under way asked for the old path; a picture and text are read differently.
        if (!f.dirty && (f.loading || asPicture !== (imageKind(was) === 'raster'))) {
          f.image = null
          f.disk = null
          disposeEditorModel(next)
          void this.read(next)
        } else {
          void this.recheck(next)
        }
      }
      threads.persistLayout()
    },

    /** The disk changed under `dir`: read it again (not joining a read that began before) and let git catch up. */
    async _changed(projectPath: string, dir: string) {
      preloads.clear()
      await listing.get(dirKey(projectPath, dir))
      await this.loadDir(projectPath, dir, true)
      window.dispatchEvent(new CustomEvent('mango:files-changed', { detail: { path: projectPath } }))
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
      // Language servers may run only in the folder the user allowed: is it still that one?
      void useLanguageServers().checkFolder(projectPath)
      if (!this.open[id]) {
        this.open[id] = {
          projectPath, file, loading: true, error: null, binary: false, tooLarge: false, size: 0, bom: false,
          disk: null, modifiedMs: 0, hash: null, version: 0, dirty: false, saving: false, saveError: null, conflict: false, closing: false,
          image: null, view: 'preview',
        }
        void this._firstRead(id)
      }
      const wasOpen = threads.tabs.includes(id)
      const preview = this.preview[projectPath] ?? null
      if (!wasOpen && !pin && preview && preview !== id && threads.tabs.includes(preview) && !this.isUnsaved(preview)) {
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
      nextRev(f)
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
      const { file } = f
      const rev = nextRev(f)
      // An answer from before a save (or a newer read, or a rename) would put old text back in the editor.
      const overtaken = () => f.saving || f.loading || f.file !== file || revs.get(f) !== rev
      try {
        const c = await call('fs_read_file', { root: f.projectPath, file })
        if (overtaken()) return
        // Times can be as coarse as a second: the text decides too.
        if (c.modifiedMs === f.modifiedMs && c.text === f.disk && (c.hash ?? null) === f.hash && !f.error && !f.conflict) {
          // A read that works may mean a save that failed works now (the connection is back).
          if (f.dirty && f.saveError) autoSave().edited(f)
          return
        }
        if (f.dirty) {
          const entry = editorModel(fileTabId(f.projectPath, file))
          const editing = () => (entry && !entry.model.isDisposed() ? entry.model.getValue() : null)
          const found = compareDisk(c.text, f.disk, attempted.get(f), editing)
          if (found === 'changed') {
            // What a failed save broke is nobody's edit: a conflict would hide where the backup is,
            // and offer to load the broken text in place of the edits.
            if (!keepsBackup(f.saveError)) f.conflict = true
            return
          }
          // Touched, or written by us: nothing to ask about, and the next save expects this time.
          Object.assign(f, { disk: c.text, bom: c.bom, modifiedMs: c.modifiedMs, hash: c.hash ?? null, conflict: false })
          if (found === 'same' && entry) {
            entry.savedVersion = entry.model.getAlternativeVersionId()
            f.dirty = false
            f.saveError = null
          } else {
            autoSave().edited(f)
          }
          return
        }
        Object.assign(f, {
          error: null, conflict: false, binary: c.binary, tooLarge: c.tooLarge, size: c.size, bom: c.bom, modifiedMs: c.modifiedMs, hash: c.hash ?? null,
        })
        if (c.text !== f.disk) {
          f.disk = c.text
          f.version++
        }
      } catch (e) {
        if (!f.dirty && !overtaken()) f.error = reason(e)
      }
    },

    /** The editor reports whether its text differs from disk. */
    setDirty(tabId: string, dirty: boolean) {
      const f = this.open[tabId]
      if (!f || f.dirty === dirty) return
      f.dirty = dirty
      if (dirty) this.pin(tabId)
    },

    /** The editor's text changed, whether or not a pane shows it. */
    edited(tabId: string) {
      const f = this.open[tabId]
      const entry = editorModel(tabId)
      // Not yet filled with what was last read: it is out of date, and never saves by itself.
      if (!f || !entry || entry.loadedVersion !== f.version) return
      this.setDirty(tabId, entry.model.getAlternativeVersionId() !== entry.savedVersion)
      autoSave().edited(f)
    },

    /**
     * Write the editor's text: the user's own save, which always goes (after the write under way).
     * `force` overwrites a file that changed on disk. Resolves true when saved.
     */
    async save(tabId: string, force = false): Promise<boolean> {
      const f = this.open[tabId]
      if (!f) return false
      // Where a backup is stays on show until the text is saved.
      if (!keepsBackup(f.saveError)) f.saveError = null
      return autoSave().save(f, force)
    },

    /** One write of `f`'s text as it is now. Only `utils/autoSave.ts` calls it, one at a time per file. */
    async _write(f: OpenFile, force: boolean): Promise<boolean> {
      const { projectPath: root, file } = f
      const id = fileTabId(root, file)
      const entry = editorModel(id)
      if (this.open[id] !== f || f.loading || !entry || entry.model.isDisposed()) return false
      if (!force && entry.loadedVersion !== f.version) {
        // The editor still has the text from before the file was read again.
        if (f.dirty) f.conflict = true
        return false
      }
      const text = entry.model.getValue()
      const version = entry.model.getAlternativeVersionId()
      const before = attempted.get(f)
      const put = () => call('fs_write_file', {
        root, file, text, bom: f.bom, expectedModifiedMs: force ? null : f.modifiedMs, expectedHash: force ? null : f.hash,
      })
      attempted.set(f, text)
      nextRev(f)
      f.saving = true
      preloads.delete(id)
      try {
        let res = await put()
        if (!res.saved) {
          // A newer time need not mean other text: touched, written back the same, or our own write.
          const now = await call('fs_read_file', { root, file })
          const found = compareDisk(now.text, f.disk, before, () => text)
          if (found !== 'changed') {
            Object.assign(f, { disk: now.text, bom: now.bom, modifiedMs: now.modifiedMs, hash: now.hash ?? null })
            res = found === 'same' ? { saved: true, modifiedMs: now.modifiedMs, hash: now.hash } : await put()
          }
        }
        if (!res.saved) {
          attempted.delete(f)
          if (keepsBackup(f.saveError)) {
            // Likely what the failed save left. The next try writes over exactly this, nothing newer.
            const now = await call('fs_read_file', { root, file })
            Object.assign(f, { modifiedMs: now.modifiedMs, hash: now.hash ?? null })
            f.saveError = saveFailure(f.saveError, 'the file holds other text now. Try again to write over it.')
            return false
          }
          f.conflict = true
          f.saveError = null
          // The bar that lets the user pick takes the place of "save before closing?".
          if (autoSaves()) f.closing = false
          return false
        }
        attempted.delete(f)
        f.disk = text
        f.modifiedMs = res.modifiedMs
        f.hash = res.hash ?? null
        entry.savedVersion = version
        entry.loadedVersion = f.version
        // Typing went on while it saved (or was undone back to what was there before): still dirty.
        f.dirty = !entry.model.isDisposed() && entry.model.getAlternativeVersionId() !== version
        f.conflict = false
        f.saveError = null
        if (autoSaves()) f.closing = false
        return true
      } catch (e) {
        f.saveError = saveFailure(f.saveError, reason(e))
        // Also where the user chose to write over a conflict: its bar would hide where the backup is.
        if (keepsBackup(f.saveError)) f.conflict = false
        return false
      } finally {
        nextRev(f)
        f.saving = false
      }
    },

    /** Throw away the edits and show what is on disk now. */
    async revert(tabId: string) {
      const f = this.open[tabId]
      if (!f) return
      await autoSave().settle(x => x === f)
      if (this.open[tabId] !== f) return
      f.dirty = false
      await this.read(tabId)
    },

    /* ---------- saving by itself ---------- */

    /** Attention left the editor: save what can be saved, without waiting. */
    saveSoon() {
      autoSave().soon()
    },

    /** Autosave was turned on: what is dirty saves, also what a close was asking about. */
    autoSaveTurnedOn() {
      for (const f of Object.values(this.open)) f.closing = false
      autoSave().soon()
    },

    /** Picks the open files of the working copies at `paths`, their repositories included. */
    touching(...paths: string[]): Match {
      const git = useGit()
      const at = paths.flatMap((path) => {
        const root = git.status(path)?.root
        if (!root) return [path]
        const loc = parseEnvPath(path)
        return [path, loc ? envPath({ ...loc, dir: root }) : root]
      })
      return f => at.some(a => overlaps(f.projectPath, a))
    },

    /**
     * Save now, waiting no longer than `ms`. Resolves with the files that still have unsaved text
     * (conflicts, failures, too slow); none while autosave is off.
     */
    async saveAll(ms: number, match: Match = () => true): Promise<string[]> {
      if (!autoSaves()) return []
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([autoSave().flush(match), new Promise<void>(resolve => (timer = setTimeout(resolve, ms)))])
      clearTimeout(timer)
      return Object.values(this.open).filter(f => unsaved(f) && match(f)).map(f => f.file)
    },

    /** Run `work`, which reads the working copies at `paths`: it sees the saved text. */
    aroundRead<T>(paths: string[], work: () => Promise<T>): Promise<T> {
      return autoSave().around(this.touching(...paths), work)
    },

    /**
     * Run `work`, which changes the working copies at `paths` (a checkout, a discard): it sees the
     * saved text, and no save by itself undoes it.
     */
    aroundChange<T>(paths: string[], work: () => Promise<T>): Promise<T> {
      const match = this.touching(...paths)
      return autoSave().around(match, work, () =>
        Promise.all(Object.keys(this.open).filter(id => match(this.open[id]!)).map(id => this.recheck(id))))
    },

    /**
     * An environment's instance is being renamed: save while the paths are right, then write nothing
     * there (not the user's own saves either, autosave or not) until the returned function runs.
     * The old name can be another instance's by then.
     */
    async holdInstance(hostId: string, from: string, to: string): Promise<() => void> {
      const its: Match = (f) => {
        const loc = parseEnvPath(f.projectPath)
        return !!loc && loc.hostId === hostId && (loc.instance === from || loc.instance === to)
      }
      await this.saveAll(10_000, its)
      const release = autoSave().hold(its, true)
      await autoSave().settle(its)
      return release
    },

    /** The instance was renamed: unsaved text follows it, in its tab, to be saved in that instance. */
    moveUnsaved(hostId: string, from: string, to: string) {
      const threads = useThreads()
      for (const [id, f] of Object.entries(this.open)) {
        const project = movedEnvPath(f.projectPath, hostId, from, to)
        if (!project || !unsaved(f)) continue
        const next = fileTabId(project, f.file)
        if (this.open[next]) continue
        delete this.open[id]
        f.projectPath = project
        this.open[next] = f
        moveEditorModel(id, next)
        if (threads.tabs.includes(id)) threads.replaceTab(id, next)
      }
    },

    /** Until the returned function runs, nothing writes to these files; what was under way is over. */
    async _keepStill(match: Match): Promise<() => void> {
      if (!autoSaves()) return () => {}
      const release = autoSave().hold(match, true)
      await autoSave().settle(match)
      return release
    },

    /** A tab with unsaved text is closing: it closes once saved. When it cannot save, `ask` first. */
    async closeWhenSaved(tabId: string, ask = true) {
      const f = this.open[tabId]
      if (!f) return
      await this.saveAll(10_000, x => x === f)
      // Where it is now: it may have been renamed, or closed already.
      const id = fileTabId(f.projectPath, f.file)
      if (this.open[id] !== f) return
      const threads = useThreads()
      if (!unsaved(f)) {
        threads.closeTab(id)
      } else if (ask) {
        threads.show(id)
        f.closing = true
      }
    },

    /** Close what could not be saved, edits and all (after the user said so). */
    discardUnsaved() {
      for (const id of Object.keys(this.open)) {
        if (!unsaved(this.open[id]!)) continue
        closeFileTab(id)
        if (this.open[id]) this.forget(id)
      }
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
  useThreads().closeTab(tabId, true)
}
