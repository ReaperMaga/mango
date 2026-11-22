/**
 * What the Files tree shows: which entries (excluded files, dotfiles), in which order, and which
 * folders share a row. Pure, so it runs in plain Node (tests/fileTree.test.ts).
 */
import type { FsEntry } from '~/types/ipc'

/** The Files view's options, kept with the prefs. */
export interface FilesView {
  /** Show what git ignores and what the user excluded. */
  excluded: boolean
  dotfiles: boolean
  /** A folder holding nothing but one folder shares its row (`src/main/java`). */
  compact: boolean
  sort: 'name' | 'type'
  foldersFirst: boolean
  /** The tree follows the file in the active pane. */
  follow: boolean
}

/** Stored options, whatever build wrote them. The defaults are the tree without any options. */
export function filesViewOf(stored: unknown): FilesView {
  const v = (stored && typeof stored === 'object' ? stored : {}) as Partial<Record<keyof FilesView, unknown>>
  return {
    excluded: v.excluded !== false,
    dotfiles: v.dotfiles !== false,
    compact: v.compact === true,
    sort: v.sort === 'type' ? 'type' : 'name',
    foldersFirst: v.foldersFirst !== false,
    follow: v.follow === true,
  }
}

/** A project's excluded paths as stored (`ProjectPrefs.excluded`). */
export const excludedPathsOf = (stored: unknown): string[] =>
  Array.isArray(stored) ? stored.filter((p): p is string => typeof p === 'string' && !!p) : []

/** A folder's listing, as far as it is known. */
interface Listing {
  entries: FsEntry[] | null
  error: string | null
  truncated: boolean
}

export interface TreeEntry {
  type: 'entry'
  /** The row's identity: for folders sharing a row the first one's path, so it holds while the row grows. */
  key: string
  /** What the row acts on: for folders sharing a row, the last one. */
  entry: FsEntry
  label: string
  /** Every folder on the row, outermost first; just the entry's path otherwise. */
  chain: string[]
  depth: number
  open: boolean
  /** Ignored by git or excluded, itself or by a folder above it. */
  excluded: boolean
  /** The user excluded exactly this path. */
  marked: boolean
  /** The key of the row it is under. */
  parent: string
}

export interface TreeNote {
  type: 'note'
  key: string
  depth: number
  text: string
  error?: boolean
}

export interface TreeInput {
  dirs: Record<string, Listing>
  expanded: string[]
  view: FilesView
  /** The paths the user excluded. */
  marks: string[]
  /** A file asked for by name ("Show in Files"): shown, with the folders to it, whatever is hidden. */
  keep: string | null
}

export interface TreeLayout {
  rows: (TreeEntry | TreeNote)[]
  /** Folders whose listing a row's name depends on: refreshed with the open ones. */
  chained: string[]
  /** Of those, the ones not read yet. */
  unread: string[]
}

/** A link back to a folder above would make a row grow for ever. */
const MAX_CHAIN = 20

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Entries in the view's order. They arrive folders first, then by name. */
export function sortEntries(entries: FsEntry[], view: Pick<FilesView, 'sort' | 'foldersFirst'>): FsEntry[] {
  if (view.sort === 'name' && view.foldersFirst) return entries
  return entries
    .map(entry => ({ entry, name: entry.name.toLowerCase(), ext: view.sort === 'type' && !entry.isDir ? extensionOf(entry.name) : '' }))
    .sort((a, b) =>
      (view.foldersFirst ? Number(b.entry.isDir) - Number(a.entry.isDir) : 0) || compare(a.ext, b.ext) || compare(a.name, b.name))
    .map(s => s.entry)
}

export function layoutTree({ dirs, expanded, view, marks, keep }: TreeInput): TreeLayout {
  const open = new Set(expanded)
  const marked = new Set(marks)
  const rows: TreeLayout['rows'] = []
  const chained: string[] = []
  const unread: string[] = []

  const isExcluded = (e: FsEntry, above: boolean) => above || e.ignored || marked.has(e.path)
  const isShown = (e: FsEntry, above: boolean) =>
    keep === e.path || !!keep?.startsWith(`${e.path}/`)
    || ((view.excluded || !isExcluded(e, above)) && (view.dotfiles || !e.name.startsWith('.')))

  const walk = (dir: string, depth: number, above: boolean, parent: string) => {
    const listing = dirs[dir]
    if (!listing) return
    if (!listing.entries) {
      if (listing.error) rows.push({ type: 'note', key: `err:${dir}`, depth, text: listing.error, error: true })
      else if (dir) rows.push({ type: 'note', key: `load:${dir}`, depth, text: 'Loading…' })
      return
    }
    const shown = listing.entries.filter(e => isShown(e, above))
    if (!shown.length && listing.entries.length) rows.push({ type: 'note', key: `hidden:${dir}`, depth, text: 'All files here are hidden' })
    else if (!shown.length && dir) rows.push({ type: 'note', key: `empty:${dir}`, depth, text: 'Empty folder' })

    for (const head of sortEntries(shown, view)) {
      const excluded = isExcluded(head, above)
      const chain = [head]
      let last = head
      while (view.compact && last.isDir && chain.length < MAX_CHAIN) {
        const inside = dirs[last.path]
        if (!inside?.entries || inside.truncated) break
        const children = inside.entries.filter(e => isShown(e, excluded))
        const only = children.length === 1 ? children[0]! : null
        // An excluded folder keeps a row of its own, so it looks excluded and can be included again.
        if (!only?.isDir || marked.has(only.path) || isExcluded(only, excluded) !== excluded) break
        chain.push(only)
        last = only
      }
      if (chain.length > 1) {
        for (const e of chain) chained.push(e.path)
        if (!dirs[last.path]) unread.push(last.path)
      }
      const isOpen = head.isDir && open.has(head.path)
      rows.push({
        type: 'entry', key: head.path, entry: last, label: chain.map(e => e.name).join('/'), chain: chain.map(e => e.path),
        depth, open: isOpen, excluded, marked: marked.has(last.path), parent,
      })
      if (isOpen) walk(last.path, depth + 1, excluded, head.path)
    }
    if (listing.truncated) rows.push({ type: 'note', key: `more:${dir}`, depth, text: 'Only the first 5000 entries are shown' })
  }
  walk('', 0, false, '')
  return { rows, chained, unread }
}
