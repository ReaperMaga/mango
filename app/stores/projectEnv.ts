import { defineStore } from 'pinia'
import type { EnvFile } from '~/types/ipc'
import { call } from '~/composables/useBackend'
import { useWorkspace } from '~/stores/workspace'

/**
 * Settings > Projects > Environment variables: the env files at a project's root and the
 * edits made to them.
 *
 * Edits are drafts kept in memory only, per project and file, so switching file, section or
 * project never loses them and nothing is written anywhere but the file itself on Save. The
 * values are secrets: never log them or copy them into persisted state.
 */
export interface EnvDoc {
  /** The text being edited. */
  text: string
  /** The text as last read from or written to disk. */
  saved: string
  bom: boolean
  modifiedMs: number
  /** Not editable here: binary or too large. */
  unreadable: 'binary' | 'tooLarge' | null
  loading: boolean
  saving: boolean
  /** The file changed on disk since it was read; Save stopped. */
  conflict: boolean
  error: string | null
}

const keyOf = (root: string, file: string) => `${root}\u0000${file}`

/** Example and template files: committed on purpose, so `env_files` leaves them out unless asked for. */
const EXAMPLE_NAMES = new Set(['.env.example', '.env.sample', '.env.template', 'example.env', 'sample.env', 'template.env'])

/** Names `env_files` finds by itself; anything else (examples included) is remembered as an extra. */
export const isAutoEnvName = (name: string) =>
  !EXAMPLE_NAMES.has(name.toLowerCase()) && (name === '.env' || name.startsWith('.env.') || name.endsWith('.env'))

/** A plain file name (no folders) that is safe on every OS; returns why not, or null. */
export function envNameProblem(name: string): string | null {
  if (!name) return 'Give the file a name.'
  if (name !== name.trim()) return 'The name can\'t start or end with a space.'
  if (/[/\\]/.test(name)) return 'Only a file name, without folders: the file goes at the root of the project.'
  if (name === '.' || name === '..') return 'That name is taken by the folder itself.'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f<>:"|?*]/.test(name)) return 'The name can\'t contain < > : " | ? * or control characters.'
  if (name.endsWith('.')) return 'The name can\'t end with a dot.'
  if (name.length > 200) return 'That name is too long.'
  return null
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export const useProjectEnv = defineStore('projectEnv', {
  state: () => ({
    /** The env files per project root, as last listed. */
    files: {} as Record<string, EnvFile[]>,
    listing: {} as Record<string, boolean>,
    listError: {} as Record<string, string | null>,
    /** The file shown per project root. */
    selected: {} as Record<string, string | null>,
    docs: {} as Record<string, EnvDoc>,
  }),

  getters: {
    doc: s => (root: string, file: string): EnvDoc | null => s.docs[keyOf(root, file)] ?? null,
    isDirty: s => (root: string, file: string) => {
      const d = s.docs[keyOf(root, file)]
      return !!d && d.text !== d.saved
    },
    /** Any file of this project has unsaved edits. */
    anyDirty: s => (root: string) => {
      const prefix = `${root}\u0000`
      return Object.entries(s.docs).some(([k, d]) => k.startsWith(prefix) && d.text !== d.saved)
    },
  },

  actions: {
    /** List the env files again; keeps the selection when the file is still there. */
    async list(root: string) {
      this.listing[root] = true
      try {
        const extra = useWorkspace().envExtraFiles[root] ?? []
        const files = await call('env_files', { root, extra })
        this.files[root] = files
        this.listError[root] = null
        const sel = this.selected[root]
        if (!sel || !files.some(f => f.name === sel)) this.selected[root] = files[0]?.name ?? null
      } catch (e) {
        this.listError[root] = message(e)
      } finally {
        this.listing[root] = false
      }
    },

    /**
     * Read a file into a doc. A doc with unsaved edits is left alone unless `discard`
     * (Reload from disk) says so.
     */
    async read(root: string, file: string, discard = false) {
      const key = keyOf(root, file)
      const had = this.docs[key]
      if (had && had.text !== had.saved && !discard) return
      if (!had) {
        this.docs[key] = { text: '', saved: '', bom: false, modifiedMs: 0, unreadable: null, loading: true, saving: false, conflict: false, error: null }
      } else had.loading = true
      const d = this.docs[key]!
      try {
        const c = await call('fs_read_file', { root, file })
        d.unreadable = c.binary ? 'binary' : c.tooLarge || c.text === null ? 'tooLarge' : null
        d.text = d.saved = c.text ?? ''
        d.bom = c.bom
        d.modifiedMs = c.modifiedMs
        d.conflict = false
        d.error = null
      } catch (e) {
        d.error = message(e)
      } finally {
        d.loading = false
      }
    },

    /** The file's text as it is on disk now, leaving the draft alone. Throws a readable message. */
    async diskText(root: string, file: string): Promise<string> {
      const c = await call('fs_read_file', { root, file })
      return c.text ?? ''
    },

    select(root: string, file: string) {
      this.selected[root] = file
      void this.read(root, file)
    },

    setText(root: string, file: string, text: string) {
      const d = this.docs[keyOf(root, file)]
      if (d) d.text = text
    },

    revert(root: string, file: string) {
      const d = this.docs[keyOf(root, file)]
      if (!d) return
      d.text = d.saved
      d.conflict = false
      d.error = null
    },

    /** Write the draft. `force` overwrites a file that changed on disk. Resolves true when saved. */
    async save(root: string, file: string, force = false): Promise<boolean> {
      const d = this.docs[keyOf(root, file)]
      if (!d || d.saving || d.unreadable) return false
      const text = d.text
      d.saving = true
      d.error = null
      try {
        const res = await call('fs_write_file', { root, file, text, bom: d.bom, expectedModifiedMs: force ? null : d.modifiedMs })
        if (!res.saved) {
          d.conflict = true
          return false
        }
        d.saved = text
        d.modifiedMs = res.modifiedMs
        d.conflict = false
        void this.list(root)
        return true
      } catch (e) {
        d.error = message(e)
        return false
      } finally {
        d.saving = false
      }
    },

    /**
     * Create an empty env file and show it. A name `env_files` doesn't list by itself (an example
     * file, any other name) is remembered first: when such a file already exists it is just shown.
     * Throws a readable message.
     */
    async create(root: string, name: string) {
      if (!isAutoEnvName(name)) {
        useWorkspace().setEnvExtraFile(root, name, true)
        await this.list(root)
        if (this.files[root]?.some(f => f.name === name)) {
          this.selected[root] = name
          await this.read(root, name)
          return
        }
      }
      try {
        await call('fs_create_file', { root, file: name, text: '' })
      } catch (e) {
        if (!isAutoEnvName(name)) useWorkspace().setEnvExtraFile(root, name, false)
        throw e
      }
      delete this.docs[keyOf(root, name)]
      this.selected[root] = name
      await this.list(root)
      await this.read(root, name)
    },

    /** Delete a file (the UI has asked first) and drop its draft. Throws a readable message. */
    async remove(root: string, name: string) {
      await call('fs_delete_file', { root, file: name })
      useWorkspace().setEnvExtraFile(root, name, false)
      delete this.docs[keyOf(root, name)]
      if (this.selected[root] === name) this.selected[root] = null
      await this.list(root)
      const next = this.selected[root]
      if (next) await this.read(root, next)
    },

    /** Add the file to the project's .gitignore. Throws a readable message. */
    async ignore(root: string, name: string) {
      await call('env_gitignore_add', { root, name })
      await this.list(root)
    },
  },
})
