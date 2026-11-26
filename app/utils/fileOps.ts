/**
 * The small rules behind the Files view's file operations: names, and where a path ends up when
 * something above it is renamed. Pure, so it runs in plain Node (tests/fileOps.test.ts).
 */

import { t } from '../i18n/index.ts'

/** The folder a project-relative path is in; "" is the project's own. */
export const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')))

export const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

export const pathIn = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)

/** `path` is `at` or lies inside it. */
export const isWithin = (path: string, at: string) => path === at || path.startsWith(`${at}/`)

/** `path` after `from` became `to`; null when the rename does not touch it. */
export const movedPath = (path: string, from: string, to: string) => (isWithin(path, from) ? to + path.slice(from.length) : null)

/** What is wrong with a name being typed, or null. What only some systems refuse is the backend's to say. */
export function nameProblem(name: string): string | null {
  if (!name.trim()) return t('files.name.empty')
  if (/[\\/]/.test(name)) return t('files.name.slash')
  if (/[\0\r\n]/.test(name)) return t('files.name.oneLine')
  if (name === '.' || name === '..') return t('files.name.notAName', { name })
  if (/^\.(git|plastic)[. ]*$/i.test(name)) return t('files.name.reserved', { name })
  return null
}

/** How much of a name is selected for renaming: all but a file's extension. */
export function stemEnd(name: string, isDir: boolean) {
  const dot = name.lastIndexOf('.')
  return !isDir && dot > 0 ? dot : name.length
}

/** A free name for a file's copy: `a copy.ts`, then `a copy 2.ts`. Case does not tell two names apart. */
export function copyName(name: string, taken: string[]) {
  const used = new Set(taken.map(x => x.toLowerCase()))
  const cut = stemEnd(name, false)
  for (let n = 1; ; n++) {
    const next = `${name.slice(0, cut)} copy${n > 1 ? ` ${n}` : ''}${name.slice(cut)}`
    if (!used.has(next.toLowerCase())) return next
  }
}
