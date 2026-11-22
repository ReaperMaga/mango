/**
 * The Files view's file operations (app/utils/fileOps.ts). Plain Node:
 *
 *   node --test tests/fileOps.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyName, isWithin, movedPath, nameOf, nameProblem, parentOf, pathIn, stemEnd } from '../app/utils/fileOps.ts'

test('paths split and join at the project root and below it', () => {
  assert.deepEqual([parentOf('a/b/c.ts'), nameOf('a/b/c.ts')], ['a/b', 'c.ts'])
  assert.deepEqual([parentOf('c.ts'), nameOf('c.ts')], ['', 'c.ts'])
  assert.deepEqual([pathIn('', 'c.ts'), pathIn('a/b', 'c.ts')], ['c.ts', 'a/b/c.ts'])
})

test('a rename moves what is inside, never a neighbour that starts the same', () => {
  assert.equal(movedPath('src', 'src', 'source'), 'source')
  assert.equal(movedPath('src/a/b.ts', 'src', 'source'), 'source/a/b.ts')
  assert.equal(movedPath('src-tauri/a', 'src', 'source'), null)
  assert.equal(movedPath('app/src/a', 'src', 'source'), null)
  assert.equal(movedPath('a.ts', 'a.ts', 'A.ts'), 'A.ts')
  assert.equal(isWithin('dist.txt', 'dist'), false)
  assert.equal(isWithin('dist/x', 'dist'), true)
})

test('names that cannot be used say why', () => {
  for (const bad of ['', '  ', '.', '..', 'a/b', 'a\\b', 'a\nb', '.git', '.GIT', '.git.', '.plastic']) assert.ok(nameProblem(bad), JSON.stringify(bad))
  for (const ok of ['.gitignore', '.github', '.env', 'a b.ts', '...x', 'grüße']) assert.equal(nameProblem(ok), null, ok)
})

test('renaming selects the name without its extension', () => {
  assert.equal(stemEnd('main.rs', false), 4)
  assert.equal(stemEnd('a.test.ts', false), 6)
  assert.equal(stemEnd('.env', false), 4)
  assert.equal(stemEnd('LICENSE', false), 7)
  assert.equal(stemEnd('v1.2', true), 4)
})

test('a copy gets a free name', () => {
  assert.equal(copyName('a.ts', ['a.ts']), 'a copy.ts')
  assert.equal(copyName('a.ts', ['a.ts', 'A Copy.ts', 'a copy 2.ts']), 'a copy 3.ts')
  assert.equal(copyName('.env', ['.env']), '.env copy')
  assert.equal(copyName('LICENSE', []), 'LICENSE copy')
})
