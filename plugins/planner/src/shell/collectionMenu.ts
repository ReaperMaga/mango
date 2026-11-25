/** What a collection's "…" menu offers, and getting collections in and out. */

import type { Planner } from '../context.ts'
import type { MangoPluginApi, PluginMenuRow } from '../host.ts'
import { itemWord, type Collection, type Scope } from '../model.ts'
import type { PlannerStore } from '../store.ts'
import { askCollectionSettings } from './dialogs.ts'
import { shell } from './strings.ts'

type Host = { mango: MangoPluginApi; store: PlannerStore }
const MAX_CSV = 10 * 1024 * 1024

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Asks for a CSV file; null when none was chosen or it could not be read. */
function pickCsv(mango: MangoPluginApi): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.csv,.tsv,.txt,text/csv'
    const fail = (body: string) => {
      mango.ui.toast({ title: shell.importFailed, body, kind: 'error' })
      resolve(null)
    }
    input.addEventListener('cancel', () => resolve(null))
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      if (file.size > MAX_CSV) return fail(shell.fileTooLarge)
      file.text().then(text => resolve({ name: file.name.replace(/\.[^.]+$/, ''), text }), e => fail(message(e)))
    })
    input.click()
  })
}

export async function importAsCollection({ mango, store }: Host, scope?: Scope, place?: string): Promise<Collection | null> {
  const file = await pickCsv(mango)
  return file ? store.importCsvAsCollection(file.text, file.name, scope, place) : null
}

async function importInto({ mango, store }: Host, id: string) {
  const file = await pickCsv(mango)
  const n = file ? await store.importCsv(id, file.text) : 0
  if (n) mango.ui.toast({ title: shell.imported(n, itemWord(store.collection(id), n)), kind: 'success' })
}

type Format = 'csv' | 'md'
const exported = (store: PlannerStore, id: string, format: Format) => (format === 'csv' ? store.exportCsv(id) : store.exportMarkdown(id))

async function copy({ mango, store }: Host, id: string, format: Format) {
  const text = await exported(store, id, format)
  if (text === null) return
  try {
    // The mark in front is for files.
    await navigator.clipboard.writeText(text.replace(/^﻿/, ''))
    mango.ui.toast({ title: shell.copied, kind: 'success', timeout: 2500 })
  } catch (e) {
    mango.ui.toast({ title: shell.copyFailed, body: message(e), kind: 'error' })
  }
}

/** Mango has no "save as" for plugins, so a file goes into the project. */
async function save({ mango, store }: Host, c: Collection, format: Format) {
  const project = mango.workspace.workdir() ?? mango.workspace.activeProject()
  if (!project) return
  const slug = c.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'planner'
  const answer = (await mango.ui.prompt({ title: shell.savePrompt, body: shell.saveBody, value: `${slug}.${format}` }))?.trim()
  if (answer === undefined) return
  const parts = answer.split(/[\\/]+/)
  if (!answer || /^[\\/]|^[a-z]:/i.test(answer) || parts.some(p => !p || p === '.' || p === '..')) {
    return mango.ui.toast({ title: shell.saveFailed, body: shell.badPath, kind: 'error' })
  }
  const sep = project.includes('\\') && !project.includes('://') ? '\\' : '/'
  const join = (names: string[]) => [project.replace(/[\\/]+$/, ''), ...names].join(sep)
  const name = parts.at(-1)!
  try {
    const there = await mango.files.list(join(parts.slice(0, -1)))
    if (there.some(e => e.name.toLowerCase() === name.toLowerCase())) {
      const ok = await mango.ui.confirm({ title: shell.replace(name), body: shell.replaceBody, confirmLabel: shell.replaceLabel, danger: true })
      if (!ok) return
    }
    const text = await exported(store, c.id, format)
    if (text === null) return
    const path = join(parts)
    await mango.files.write(path, text)
    mango.ui.toast({ title: shell.saved(name), kind: 'success', action: { label: shell.openFile, run: () => mango.workspace.openFile(path) } })
  } catch (e) {
    mango.ui.toast({ title: shell.saveFailed, body: message(e), kind: 'error' })
  }
}

/** Without what reading or asking needs: the caller composes them. The last is Delete. */
export function collectionRows(planner: Planner, c: Collection, groupBy?: string | null): PluginMenuRow[] {
  const { store, go } = planner
  const locked = store.statusOf(c.id).readonly
  const here = store.placeOf(c.id)

  async function duplicate(items: boolean) {
    const made = await store.duplicateCollection(c.id, { items })
    if (made) go({ collectionId: made.id })
  }
  const moves = store.places.value.filter(p => p.id !== here).map((p): PluginMenuRow => ({
    label: shell.moveTo(p.label),
    icon: p.id === 'local' ? 'monitor' : 'cloud-upload',
    disabled: locked || !p.status.online || p.status.readonly,
    divider: true,
    onSelect: () => void moveTo(planner, c, p.id, p.label),
  }))
  return [
    { label: shell.editCollection, icon: 'settings-2', onSelect: () => void editCollection(planner, c, groupBy) },
    { label: shell.duplicate, icon: 'copy', disabled: locked, onSelect: () => void duplicate(false) },
    { label: shell.duplicateItems(itemWord(c, 2)), icon: 'copy-plus', disabled: locked, onSelect: () => void duplicate(true) },
    ...moves.map((row, i) => (i ? { ...row, divider: false } : row)),
    { label: shell.deleteCollection, icon: 'trash-2', danger: true, divider: true, disabled: locked, onSelect: () => void removeCollection(planner, c) },
  ]
}

export async function editCollection(planner: Planner, c: Collection, groupBy?: string | null) {
  if (await askCollectionSettings(planner, c.id, groupBy ?? null) === 'remove') await removeCollection(planner, c)
}

/** Off the server, it is gone for everyone else: that is asked first. */
async function moveTo({ mango, store, go, route }: Planner, c: Collection, place: string, label: string) {
  const from = store.places.value.find(p => p.id === store.placeOf(c.id))
  if (place === 'local' && from) {
    const ok = await mango.ui.confirm({ title: shell.moveHereTitle(c.name || shell.unnamed), body: shell.moveHereBody(from.label), confirmLabel: shell.moveLabel })
    if (!ok) return
  }
  const made = await store.moveCollectionTo(c.id, place)
  if (!made) return
  if (route.value.collectionId === c.id) go({ collectionId: made.id })
  mango.ui.toast({ title: shell.moved(made.name || shell.unnamed, label), kind: 'success' })
}

async function removeCollection({ mango, store, go, route }: Planner, c: Collection) {
  // Read first, so that it can say how much goes.
  if (!await store.loadItems(c.id)) return mango.ui.toast({ title: shell.itemsFailed(itemWord(c, 2)), body: store.items(c.id).error ?? '', kind: 'error' })
  const body = shell.deleteBody(store.items(c.id).items.length, c)
  const ok = await mango.ui.confirm({ title: shell.deleteConfirm(c.name || shell.unnamed), body, confirmLabel: shell.deleteLabel, danger: true })
  if (ok && await store.deleteCollection(c.id) && route.value.collectionId === c.id) go({ collectionId: null })
}

export function transferRows(planner: Planner, c: Collection): PluginMenuRow[] {
  const project = planner.store.projectPath.value
  return [
    { label: shell.importInto, icon: 'file-input', disabled: planner.store.statusOf(c.id).readonly, onSelect: () => void importInto(planner, c.id) },
    { label: shell.copyCsv, icon: 'table', divider: true, onSelect: () => void copy(planner, c.id, 'csv') },
    { label: shell.copyMarkdown, icon: 'file-text', onSelect: () => void copy(planner, c.id, 'md') },
    { label: shell.saveCsv, icon: 'file-down', disabled: !project, onSelect: () => void save(planner, c, 'csv') },
    { label: shell.saveMarkdown, icon: 'file-down', disabled: !project, onSelect: () => void save(planner, c, 'md') },
  ]
}
