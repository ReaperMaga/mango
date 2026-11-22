import type { Component } from 'vue'
import type { FileEntryContext, FileIconContext, FileTint } from './types'
import { pluginNames, reg, report, type Owned } from './registry'
import { iconComponent } from './icons'
import { fileIcon } from '~/utils/fileIcons'
import { nameOf } from '~/utils/fileOps'
import type { HiddenRule } from '~/utils/fileTree'

/**
 * What plugins add to project files (`ui.files`), as the Files view, the tabs, the editor and
 * stores/files.ts read it. These run per row inside computeds, so a failure is reported once per
 * registration and afterwards: writing to the log from inside a computed would make it run again.
 */

const failed = new WeakSet<object>()

function guard<T>(item: Owned<{ id: string }>, where: string, fallback: T, fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    if (!failed.has(item)) {
      failed.add(item)
      queueMicrotask(() => report(item.pluginId, e, `${where} ${item.id}`))
    }
    return fallback
  }
}

/** The filters a project's View options list. */
export function fileFilters(projectPath: string) {
  return reg.fileFilters.filter(f => !f.when || guard(f, 'file filter', false, () => f.when!({ projectPath }) === true))
}

/** What the filters left off hide; null when that is nothing. */
export function hiddenRule(projectPath: string, shownIds: readonly string[]): HiddenRule | null {
  const on = fileFilters(projectPath).filter(f => !shownIds.includes(f.fullId))
  if (!on.length) return null
  return (entry, hasSibling) => {
    const ctx = { projectPath, path: entry.path, name: entry.name, isDir: entry.isDir, hasSibling }
    return on.some(f => guard(f, 'file filter', false, () => f.hide(ctx) === true))
  }
}

/** The suffixes of the files that go with an entry. */
export function companionSuffixes(projectPath: string, path: string, isDir: boolean): string[] {
  if (!reg.fileCompanions.length) return []
  const ctx: FileEntryContext = { projectPath, path, name: nameOf(path), isDir }
  const found = reg.fileCompanions.filter(c => guard(c, 'file companion', false, () => c.when(ctx) === true))
  return [...new Set(found.map(c => c.suffix))]
}

/**
 * The same, for a rename or a delete: a plugin that cannot answer stops it, since carrying on would
 * leave the companion behind.
 */
export function requiredSuffixes(projectPath: string, path: string, isDir: boolean): string[] {
  const name = nameOf(path)
  const out = new Set<string>()
  for (const c of reg.fileCompanions) {
    let answer: boolean | null
    try {
      answer = c.when({ projectPath, path, name, isDir })
    } catch (e) {
      report(c.pluginId, e, `file companion ${c.id}`)
      throw new Error(`The ${pluginNames[c.pluginId] ?? c.pluginId} plugin failed to say which files go with ${name}, so it was left alone. Its log is in Settings > Plugins.`)
    }
    if (answer === null) throw new Error(`The ${pluginNames[c.pluginId] ?? c.pluginId} plugin is still reading this project, so it cannot tell which files go with ${name} yet. Try again in a moment.`)
    if (answer === true) out.add(c.suffix)
  }
  return [...out]
}

export interface FileLook {
  /** Null is the plain folder. */
  icon: Component | null
  /** A CSS colour; null keeps the row's own ink. */
  tint: string | null
  note: string | null
}

const TINTS: readonly FileTint[] = ['blue', 'yellow', 'orange', 'green', 'purple', 'red']

/** How an entry looks: the first plugin that has an answer, else Mango's own. */
export function fileLook(ctx: FileIconContext): FileLook {
  for (const p of reg.fileIcons) {
    const got = guard(p, 'file icon', null, () => p.icon(ctx) ?? null)
    if (!got?.icon) continue
    const plain = ctx.isDir ? null : 'var(--fg-subtle)'
    return {
      icon: iconComponent(got.icon) ?? null,
      tint: got.tint && TINTS.includes(got.tint) ? `var(--file-${got.tint})` : plain,
      note: typeof got.note === 'string' ? got.note : null,
    }
  }
  if (ctx.isDir) return { icon: null, tint: null, note: null }
  return { ...fileIcon(ctx.name), note: null }
}

/** The editor language a plugin gives a file's extension. */
export function pluginLanguage(file: string): string | null {
  const name = nameOf(file).toLowerCase()
  return reg.fileLanguages.find(l => l.extensions.some(ext => name.endsWith(ext)))?.language ?? null
}
