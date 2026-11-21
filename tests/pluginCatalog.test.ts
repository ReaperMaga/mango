/**
 * Searching the plugin catalog (app/utils/pluginCatalog.ts). Plain Node:
 *
 *   node --test tests/pluginCatalog.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { catalogTags, filterCatalog, scoreEntry } from '../app/utils/pluginCatalog.ts'
import type { PluginCatalogEntry } from '../app/types/ipc.ts'

const entry = (id: string, name: string, extra: Partial<PluginCatalogEntry> = {}): PluginCatalogEntry => ({
  id, name, description: '', author: 'Mango', version: '1.0.0', tags: [], official: true,
  source: { url: 'https://github.com/ReaperMaga/mango', ref: null, subpath: `plugins/${id}` }, ...extra,
})

const list = [
  entry('focus-timer', 'Focus timer', { description: 'A pomodoro clock in the titlebar.', tags: ['productivity', 'Timer'] }),
  entry('git-stats', 'Git stats', { description: 'Commit counts.', tags: ['git'], official: false, author: 'Renée' }),
  entry('dusk', 'Dusk theme', { description: 'A warm colour scheme.', tags: ['theme'] }),
]
const none = () => false

test('every word must match, accents and case ignored', () => {
  assert.deepEqual(filterCatalog(list, { text: 'pomodoro', origin: 'all', state: 'any', tag: null }, none).map(e => e.id), ['focus-timer'])
  assert.deepEqual(filterCatalog(list, { text: 'RENEE', origin: 'all', state: 'any', tag: null }, none).map(e => e.id), ['git-stats'])
  assert.deepEqual(filterCatalog(list, { text: 'git pomodoro', origin: 'all', state: 'any', tag: null }, none), [])
})

test('letters in order still find a name', () => {
  assert.ok(scoreEntry(list[0]!, 'fcstmr') > 0)
  assert.equal(scoreEntry(list[0]!, 'zz'), 0)
})

test('name matches rank above description matches', () => {
  const two = [entry('a', 'Alpha', { description: 'works with git' }), entry('b', 'Git tools')]
  assert.deepEqual(filterCatalog(two, { text: 'git', origin: 'all', state: 'any', tag: null }, none).map(e => e.id), ['b', 'a'])
})

test('origin, state and tag filters', () => {
  assert.deepEqual(filterCatalog(list, { text: '', origin: 'community', state: 'any', tag: null }, none).map(e => e.id), ['git-stats'])
  assert.deepEqual(filterCatalog(list, { text: '', origin: 'official', state: 'any', tag: 'timer' }, none).map(e => e.id), ['focus-timer'])
  const installed = (id: string) => id === 'dusk'
  assert.deepEqual(filterCatalog(list, { text: '', origin: 'all', state: 'installed', tag: null }, installed).map(e => e.id), ['dusk'])
  assert.equal(filterCatalog(list, { text: '', origin: 'all', state: 'available', tag: null }, installed).length, 2)
})

test('tags: lower case, most used first', () => {
  const more = [...list, entry('x', 'X', { tags: ['git'] })]
  assert.deepEqual(catalogTags(more), ['git', 'productivity', 'theme', 'timer'])
})
