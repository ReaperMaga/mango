/**
 * The Git log plugin's pure helpers (plugins/git-log/main.js): the lane layout of the commit graph, and the
 * search, diff and path helpers around it.
 *
 *   node --test tests/gitLogLanes.test.ts     (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createLaneLayout, layoutLanes, looksLikeHash, parseQuery, parseDiff, joinRepoPath, relativeTime, sortRefs, needsNewerMango,
} from '../plugins/git-log/main.js'

type Commit = { hash: string; parents: string[] }
const c = (hash: string, ...parents: string[]): Commit => ({ hash, parents })
/** The rows without colours, for comparing shapes. */
const shape = (rows: ReturnType<typeof layoutLanes>) => rows.map((r: any) => ({
  lane: r.lane,
  up: r.up.map((u: any) => u.from),
  through: r.through.map((t: any) => t.lane),
  down: r.down.map((d: any) => d.to),
  width: r.width,
}))

test('linear history stays in one lane', () => {
  const rows = layoutLanes([c('a', 'b'), c('b', 'c'), c('c')])
  assert.deepEqual(shape(rows), [
    { lane: 0, up: [], through: [], down: [0], width: 1 },
    { lane: 0, up: [0], through: [], down: [0], width: 1 },
    { lane: 0, up: [0], through: [], down: [], width: 1 },
  ])
  // One line, one colour.
  assert.ok(rows.every((r: any) => r.color === rows[0].color))
})

test('a branch merged back: a second lane opens at the merge and joins at the fork', () => {
  const rows = layoutLanes([c('m', 'a', 'f'), c('f', 'a'), c('a', 'r'), c('r')])
  assert.deepEqual(shape(rows), [
    { lane: 0, up: [], through: [], down: [0, 1], width: 2 },
    { lane: 1, up: [1], through: [0], down: [1], width: 2 },
    { lane: 0, up: [0, 1], through: [], down: [0], width: 2 },
    { lane: 0, up: [0], through: [], down: [], width: 1 },
  ])
  // The merged branch has its own colour, kept along its lane until it converges.
  const [m, f, a] = rows as any[]
  assert.notEqual(m.down[1].color, m.down[0].color)
  assert.equal(f.color, m.down[1].color)
  assert.equal(a.color, m.color)
  assert.deepEqual(a.up.map((u: any) => u.color), [m.color, f.color])
})

test('an octopus merge opens one lane per extra parent', () => {
  const rows = layoutLanes([c('o', 'a', 'b', 'x'), c('x', 'a'), c('b', 'a'), c('a')])
  assert.deepEqual(shape(rows), [
    { lane: 0, up: [], through: [], down: [0, 1, 2], width: 3 },
    { lane: 2, up: [2], through: [0, 1], down: [2], width: 3 },
    { lane: 1, up: [1], through: [0, 2], down: [1], width: 3 },
    { lane: 0, up: [0, 1, 2], through: [], down: [], width: 3 },
  ])
  assert.equal(new Set((rows[0] as any).down.map((d: any) => d.color)).size, 3)
})

test('a parent joins the lane already waiting for it', () => {
  // Two tips on the same parent, then a merge of a commit already awaited.
  const rows = layoutLanes([c('t1', 'p'), c('t2', 'q'), c('m', 'q', 'p'), c('q', 'p'), c('p')])
  const m = rows[2] as any
  // m's first parent q is waited for in lane 1 too; its second parent p is lane 0's.
  assert.equal(m.lane, 2)
  assert.deepEqual(m.down.map((d: any) => d.to), [2, 0])
  // q is waited for in lanes 1 and 2: it takes the leftmost, and lane 2 merges into it.
  assert.deepEqual(shape(rows)[3], { lane: 1, up: [1, 2], through: [0], down: [1], width: 3 })
  assert.deepEqual(shape(rows)[4], { lane: 0, up: [0, 1], through: [], down: [], width: 2 })
})

test('parents that are not loaded keep their lanes open off the bottom, and the next page picks them up', () => {
  const layout = createLaneLayout()
  const first = [c('x', 'y'), c('z', 'w')].map(layout.place)
  assert.deepEqual(shape(first), [
    { lane: 0, up: [], through: [], down: [0], width: 1 },
    { lane: 1, up: [], through: [0], down: [1], width: 2 },
  ])
  assert.equal(layout.lanes(), 2)
  // The next page continues the same lanes.
  const next = [c('y', 'w'), c('w')].map(layout.place)
  assert.deepEqual(shape(next), [
    { lane: 0, up: [0], through: [1], down: [0], width: 2 },
    { lane: 0, up: [0, 1], through: [], down: [], width: 2 },
  ])
  assert.equal(layout.lanes(), 0)
})

test('free lanes are reused by later commits, but never in the row that freed them', () => {
  // t1, t2, t3 are tips in lanes 0, 1, 2. b converges lanes 0 and 1, freeing lane 1; t4 (a later tip) takes it.
  const rows = layoutLanes([c('t1', 'a'), c('t2', 'b'), c('t3', 'c'), c('a', 'b'), c('b', 'c'), c('t4', 'c'), c('c')])
  assert.deepEqual(shape(rows).map(r => r.lane), [0, 1, 2, 0, 0, 1, 0])
  assert.deepEqual(shape(rows)[4], { lane: 0, up: [0, 1], through: [2], down: [0], width: 3 })

  // m converges lanes 0 and 1; its second parent may not take lane 1 in the same row, so it opens lane 2.
  const same = shape(layoutLanes([c('x1', 'm'), c('x2', 'm'), c('m', 'p', 'q'), c('q', 'p'), c('p')]))
  assert.deepEqual(same[2], { lane: 0, up: [0, 1], through: [], down: [0, 2], width: 3 })
  assert.deepEqual(same[3], { lane: 2, up: [2], through: [0], down: [2], width: 3 })
})

test('colours cycle through the palette', () => {
  const tips = Array.from({ length: 7 }, (_, i) => c(`t${i}`))
  const rows = layoutLanes(tips, 5) as any[]
  assert.deepEqual(rows.map(r => r.color), [0, 1, 2, 3, 4, 0, 1])
  // Roots in a row free their lane at once: every tip lands in lane 0.
  assert.ok(rows.every(r => r.lane === 0 && r.width === 1))
})

/* ---------------------------------------------------------------- helpers */

test('search: hashes, and author: in the query', () => {
  assert.equal(looksLikeHash('a1b2'), true)
  assert.equal(looksLikeHash('A1B2C3D4E5'), true)
  assert.equal(looksLikeHash('abc'), false)
  assert.equal(looksLikeHash('fix bug'), false)
  assert.deepEqual(parseQuery('  composer height '), { text: 'composer height', author: '' })
  assert.deepEqual(parseQuery('author:priya terminal'), { text: 'terminal', author: 'priya' })
  assert.deepEqual(parseQuery('resize author:"Jonas Weber"'), { text: 'resize', author: 'Jonas Weber' })
})

test('parseDiff numbers lines and drops the file headers', () => {
  const lines = parseDiff([
    'diff --git a/x.ts b/x.ts', 'index 1..2 100644', '--- a/x.ts', '+++ b/x.ts',
    '@@ -10,3 +10,3 @@ fn', ' keep', '-old', '+new', ' keep', '\\ No newline at end of file', '',
  ].join('\n'))
  assert.deepEqual(lines.map((l: any) => [l.kind, l.old, l.new]), [
    ['hunk', null, null], ['ctx', 10, 10], ['del', 11, null], ['add', null, 11], ['ctx', 12, 12], ['meta', null, null],
  ])
  assert.deepEqual(parseDiff('diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n').map((l: any) => l.kind), ['meta'])
  assert.deepEqual(parseDiff('diff --git a/a b/b\nsimilarity index 90%\nrename from a\nrename to b\n').map((l: any) => l.text), ['similarity index 90%', 'rename from a', 'rename to b'])
})

test('joinRepoPath keeps the root\'s separator', () => {
  assert.equal(joinRepoPath('C:\\code\\mango\\', 'app/stores/git.ts'), 'C:\\code\\mango\\app\\stores\\git.ts')
  assert.equal(joinRepoPath('/home/me/mango', 'app/x.ts'), '/home/me/mango/app/x.ts')
  assert.equal(joinRepoPath('env://h/box/srv/app', 'src/main.rs'), 'env://h/box/srv/app/src/main.rs')
})

test('relative times', () => {
  const now = new Date(2026, 10, 21, 12).getTime()
  assert.equal(relativeTime(now - 10_000, now), 'just now')
  assert.equal(relativeTime(now - 5 * 60_000, now), '5 min ago')
  assert.equal(relativeTime(now - 3 * 3_600_000, now), '3 h ago')
  assert.equal(relativeTime(now - 26 * 3_600_000, now), 'yesterday')
  assert.equal(relativeTime(now - 4 * 86_400_000, now), '4 days ago')
  assert.doesNotMatch(relativeTime(now - 40 * 86_400_000, now), /ago/)
})

test('refs: the checked-out branch first, then branches, remotes, tags', () => {
  const refs = [
    { name: 'v1', kind: 'tag', current: false },
    { name: 'origin/main', kind: 'remote', current: false },
    { name: 'dev', kind: 'branch', current: false },
    { name: 'main', kind: 'branch', current: true },
  ]
  assert.deepEqual(sortRefs(refs).map((r: any) => r.name), ['main', 'dev', 'origin/main', 'v1'])
})

test('an older Mango is told apart from other errors', () => {
  assert.equal(needsNewerMango(new Error('Command git_graph not found')), true)
  assert.equal(needsNewerMango('mock: git_commit_show is not implemented'), true)
  assert.equal(needsNewerMango(new Error('/x is not inside a git repository')), false)
  assert.equal(needsNewerMango(new Error('fatal: bad revision \'nope\'')), false)
})
