/**
 * Which folder a Claude Code session works in: a worktree, never a folder its shell `cd`-ed into.
 *
 *   node --test tests/workdir.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claudeWorktreeOf, isWithin, resumedFolder, savedWorktree } from '../app/agents/workdir.ts'

const win = 'C:\\Users\\me\\Projects\\Crop Chop'

test('a cd inside the folder the session started in is no move', () => {
  assert.equal(resumedFolder(win, `${win}\\Assets\\_Project\\Scripts`), null)
  assert.equal(resumedFolder(win, 'c:/users/me/projects/crop chop/Assets'), null)
  assert.equal(resumedFolder('/home/me/shop', '/home/me/shop/backend'), null)
  assert.equal(resumedFolder('/tmp/shop', '/private/tmp/shop/src'), null)
  assert.equal(resumedFolder('/home/me/shop', '/home/me/shop/'), null)
})

test('a Claude Code worktree is a move, a cd inside it is the worktree', () => {
  assert.equal(resumedFolder('/home/me/shop', '/home/me/shop/.claude/worktrees/fix'), '/home/me/shop/.claude/worktrees/fix')
  assert.equal(resumedFolder('/home/me/shop', '/home/me/shop/.claude/worktrees/fix/src/app'), '/home/me/shop/.claude/worktrees/fix')
  assert.equal(resumedFolder(`${win}\\.claude\\worktrees\\fix`, `${win}\\.claude\\worktrees\\fix\\Assets`), null)
})

test('leaving a Claude Code worktree goes back to its repository, even after a cd there', () => {
  assert.equal(resumedFolder('/home/me/shop/.claude/worktrees/fix', '/home/me/shop'), '/home/me/shop')
  assert.equal(resumedFolder('/home/me/shop/.claude/worktrees/fix', '/home/me/shop/backend'), '/home/me/shop')
})

test('a folder elsewhere is still a move', () => {
  assert.equal(resumedFolder('/home/me/shop', '/home/me/shop.worktrees/fix'), '/home/me/shop.worktrees/fix')
  assert.equal(resumedFolder('/home/me/shop', '/home/me/shopping'), '/home/me/shopping')
})

test('within: whole path parts only', () => {
  assert.equal(isWithin('/home/me/shop', '/home/me/shopping'), false)
  assert.equal(isWithin('C:\\', 'C:\\x'), true)
  assert.equal(isWithin('/', '/x'), true)
  assert.deepEqual(claudeWorktreeOf('/r/.claude/worktrees/a/b'), { root: '/r/.claude/worktrees/a', repo: '/r' })
  assert.equal(claudeWorktreeOf('/r/.claude/settings.json'), null)
})

test('saved chats moved into a plain folder of their project work in the project again', () => {
  assert.equal(savedWorktree(win, `${win}\\Assets\\_Project\\Scripts`), null)
  assert.equal(savedWorktree('C:\\Users\\me\\Projects\\mango', 'C:\\Users\\me\\Projects\\mango\\src-tauri'), null)
  assert.equal(savedWorktree('env://h/dev/home/agent/work/app', 'env://h/dev/home/agent/work/app/backend'), null)
  assert.equal(savedWorktree(win, win), null)
  // Real worktrees stay.
  assert.equal(savedWorktree('env://h/dev/home/agent/work/app', 'env://h/dev/home/agent/work/app.worktrees/x'), 'env://h/dev/home/agent/work/app.worktrees/x')
  assert.equal(savedWorktree('/home/me/shop', '/home/me/shop/.claude/worktrees/fix'), '/home/me/shop/.claude/worktrees/fix')
  assert.equal(savedWorktree('/home/me/shop', '/home/me/shop/.claude/worktrees/fix/src'), '/home/me/shop/.claude/worktrees/fix')
})
