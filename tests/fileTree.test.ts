/**
 * What the Files tree shows (app/utils/fileTree.ts). Plain Node:
 *
 *   node --test tests/fileTree.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { excludedPathsOf, filesViewOf, layoutTree, sortEntries, type FilesView, type TreeEntry, type TreeInput } from '../app/utils/fileTree.ts'
import type { FsEntry } from '../app/types/ipc.ts'

/** `name/` is a folder, `!name` is ignored by git. */
const listing = (dir: string, ...names: string[]) => {
  const entries: FsEntry[] = names.map((raw) => {
    const name = raw.replace(/^!/, '').replace(/\/$/, '')
    return { name, path: dir ? `${dir}/${name}` : name, isDir: raw.endsWith('/'), ignored: raw.startsWith('!') }
  })
  return { entries, error: null, truncated: false }
}

const layout = (dirs: TreeInput['dirs'], view: Partial<FilesView> = {}, more: Partial<TreeInput> = {}) =>
  layoutTree({ dirs, expanded: [], view: { ...filesViewOf(null), ...view }, marks: [], keep: null, ...more })
const shown = (out: ReturnType<typeof layoutTree>) => out.rows.map(r => (r.type === 'entry' ? r.label : `(${r.text})`))
const row = (out: ReturnType<typeof layoutTree>, key: string) => out.rows.find(r => r.key === key) as TreeEntry

const PROJECT = {
  '': listing('', '.github/', '!node_modules/', 'src/', '!.env', '.gitignore', 'README.md'),
  'node_modules': listing('node_modules', 'vue/'),
  'node_modules/vue': listing('node_modules/vue', 'index.js', 'package.json'),
  'src': listing('src', 'gen/', 'main.ts'),
  'src/gen': listing('src/gen', 'out.ts'),
}

test('without options everything shows, in the order it was read', () => {
  assert.deepEqual(shown(layout(PROJECT)), ['.github', 'node_modules', 'src', '.env', '.gitignore', 'README.md'])
})

test('stored options from any build are tolerated', () => {
  const defaults = { excluded: true, dotfiles: true, compact: false, sort: 'name', foldersFirst: true, follow: false }
  for (const junk of [undefined, null, 'x', 4, [], { sort: 'size', excluded: 'no', compact: 1 }]) assert.deepEqual(filesViewOf(junk), defaults)
  assert.equal(filesViewOf({ excluded: false }).excluded, false)
  assert.deepEqual(excludedPathsOf(['dist', 3, '', null]), ['dist'])
  assert.deepEqual(excludedPathsOf('dist'), [])
})

test('hiding excluded files hides what git ignores and what the user excluded', () => {
  const out = layout(PROJECT, { excluded: false }, { marks: ['src/gen'], expanded: ['src'] })
  assert.deepEqual(shown(out), ['.github', 'src', 'main.ts', '.gitignore', 'README.md'])
})

test('what is inside an excluded folder is excluded with it', () => {
  const out = layout(PROJECT, {}, { marks: ['src'], expanded: ['src', 'node_modules'] })
  assert.deepEqual([row(out, 'src').excluded, row(out, 'src').marked], [true, true])
  assert.deepEqual([row(out, 'src/main.ts').excluded, row(out, 'src/main.ts').marked], [true, false])
  assert.equal(row(out, 'node_modules/vue').excluded, true)
})

test('an exclusion is an exact path, not a prefix', () => {
  const out = layout({ '': listing('', 'dist/', 'dist-docs/', 'dist.txt') }, { excluded: false }, { marks: ['dist'] })
  assert.deepEqual(shown(out), ['dist-docs', 'dist.txt'])
})

test('dotfiles hide on their own', () => {
  assert.deepEqual(shown(layout(PROJECT, { dotfiles: false })), ['node_modules', 'src', 'README.md'])
})

test('a file asked for shows with the folders to it, and nothing else of what is hidden', () => {
  const out = layout(PROJECT, { excluded: false }, { keep: 'node_modules/vue/index.js', expanded: ['node_modules', 'node_modules/vue'] })
  assert.deepEqual(shown(out).slice(0, 4), ['.github', 'node_modules', 'vue', 'index.js'])
  assert.ok(!shown(out).includes('package.json') && !shown(out).includes('.env'))
})

test('a folder with everything hidden says so, an empty one says that', () => {
  const dirs = { '': listing('', 'a/', 'b/'), 'a': listing('a', '!x.log'), 'b': listing('b') }
  assert.deepEqual(shown(layout(dirs, { excluded: false }, { expanded: ['a', 'b'] })), ['a', '(All files here are hidden)', 'b', '(Empty folder)'])
  assert.deepEqual(shown(layout({ '': listing('', '!x') }, { excluded: false })), ['(All files here are hidden)'])
})

test('sorting by type, with and without folders on top', () => {
  const entries = listing('', 'lib.d/', 'Zed/', 'a.ts', 'B.md', 'c.ts', 'LICENSE', '.env').entries
  const names = (sort: 'name' | 'type', foldersFirst: boolean) => sortEntries(entries, { sort, foldersFirst }).map(e => e.name)
  assert.deepEqual(names('type', true), ['lib.d', 'Zed', '.env', 'LICENSE', 'B.md', 'a.ts', 'c.ts'])
  assert.deepEqual(names('name', false), ['.env', 'a.ts', 'B.md', 'c.ts', 'lib.d', 'LICENSE', 'Zed'])
  assert.equal(entries[0]!.name, 'lib.d', 'the listing itself is left as read')
})

test('single folders share a row, which opens as one', () => {
  const dirs = { '': listing('', 'src/'), 'src': listing('src', 'main/'), 'src/main': listing('src/main', 'java/'), 'src/main/java': listing('src/main/java', 'App.java') }
  const closed = layout(dirs, { compact: true })
  assert.deepEqual(shown(closed), ['src/main/java'])
  assert.deepEqual(row(closed, 'src').chain, ['src', 'src/main', 'src/main/java'])
  assert.equal(row(closed, 'src').entry.path, 'src/main/java')
  assert.deepEqual(closed.chained, row(closed, 'src').chain)

  const open = layout(dirs, { compact: true }, { expanded: ['src'] })
  assert.deepEqual(shown(open), ['src/main/java', 'App.java'])
  assert.equal(row(open, 'src/main/java/App.java').parent, 'src')
})

test('the end of a shared row is read when it is not known', () => {
  const out = layout({ '': listing('', 'src/'), 'src': listing('src', 'main/') }, { compact: true })
  assert.deepEqual(out.unread, ['src/main'])
  const reading = { '': listing('', 'src/'), 'src': listing('src', 'main/'), 'src/main': { entries: null, error: null, truncated: false } }
  assert.deepEqual(layout(reading, { compact: true }).unread, [])
})

test('shared rows count only what is shown, and stop before an excluded folder', () => {
  const dirs = { '': listing('', 'src/'), 'src': listing('src', '!cache/', 'main/') }
  assert.deepEqual(shown(layout(dirs, { compact: true })), ['src'])
  assert.deepEqual(shown(layout(dirs, { compact: true, excluded: false })), ['src/main'])

  const only = { '': listing('', 'src/'), 'src': listing('src', 'main/') }
  assert.deepEqual(shown(layout(only, { compact: true }, { marks: ['src/main'] })), ['src'])
  assert.deepEqual(shown(layout({ '': listing('', 'src/'), 'src': listing('src', '!out/') }, { compact: true })), ['src'])
})

test('a link back up cannot grow a row for ever', () => {
  const dirs: TreeInput['dirs'] = { '': listing('', 'a/') }
  let path = 'a'
  for (let i = 0; i < 100; i++) {
    dirs[path] = listing(path, 'a/')
    path += '/a'
  }
  assert.equal(row(layout(dirs, { compact: true }), 'a').chain.length, 20)
})
