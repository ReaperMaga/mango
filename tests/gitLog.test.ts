/**
 * The built-in Git log's pure parts: the lane layout of the commit graph, the search, path and time helpers,
 * its tab ids, and what carries over from when it was a plugin (the tab's place, the shortcut).
 *
 *   node --test tests/gitLog.test.ts     (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LANE_COLORS, createLaneLayout, fileInFolder, looksLikeHash, parseLogQuery, sameCommits, sortGitRefs } from '../app/utils/gitLog.ts'
import { GIT_LOG_TAB, builtInPluginNote, seedBuiltInTabs } from '../app/utils/builtIns.ts'
import { commitDiffTabId, isCommitDiffTab, parseCommitDiffTab } from '../app/utils/commitDiffTabs.ts'
import { isDiffTab } from '../app/utils/diffTabs.ts'
import { isPanelTabRef, normalizePanelPlaces } from '../app/plugin-host/ids.ts'
import { SHORTCUTS, cleanOverrides, refuse, resolveBindings } from '../app/utils/shortcuts.ts'
import { longAgo } from '../app/utils/time.ts'

type Commit = { hash: string; parents: string[] }
const c = (hash: string, ...parents: string[]): Commit => ({ hash, parents })
/** The rows for a whole list at once. */
const layoutLanes = (commits: Commit[], colors = LANE_COLORS) => commits.map(createLaneLayout(colors).place)
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
  assert.deepEqual(parseLogQuery('  composer height '), { text: 'composer height', author: '' })
  assert.deepEqual(parseLogQuery('author:priya terminal'), { text: 'terminal', author: 'priya' })
  assert.deepEqual(parseLogQuery('resize author:"Jonas Weber"'), { text: 'resize', author: 'Jonas Weber' })
})

test('a commit\'s file, relative to the folder that is open', () => {
  // The folder is the repository.
  assert.equal(fileInFolder('/home/me/mango', '/home/me/mango', 'app/x.ts'), 'app/x.ts')
  assert.equal(fileInFolder('C:\\code\\mango\\', 'C:/code/mango', 'app/x.ts'), 'app/x.ts')
  // The folder sits below it.
  assert.equal(fileInFolder('/srv/repo/app', '/srv/repo', 'app/x.ts'), 'x.ts')
  assert.equal(fileInFolder('c:\\Code\\Repo\\Web', 'C:/code/repo', 'web/src/x.ts'), 'src/x.ts')
  assert.equal(fileInFolder('/srv/repo/app', '/srv/repo', 'docs/x.md'), null)
  assert.equal(fileInFolder('/srv/repo/app', '/srv/repo', 'apple/x.md'), null)
  // Case counts everywhere but on Windows.
  assert.equal(fileInFolder('/srv/repo/App', '/srv/repo', 'app/x.ts'), null)
})

test('relative times', () => {
  const now = new Date(2026, 10, 21, 12).getTime()
  assert.equal(longAgo(now - 10_000, now), 'just now')
  assert.equal(longAgo(now - 5 * 60_000, now), '5 min ago')
  assert.equal(longAgo(now - 3 * 3_600_000, now), '3 h ago')
  assert.equal(longAgo(now - 26 * 3_600_000, now), 'yesterday')
  assert.equal(longAgo(now - 4 * 86_400_000, now), '4 days ago')
  assert.doesNotMatch(longAgo(now - 40 * 86_400_000, now), /ago/)
})

test('refs: the checked-out branch first, then branches, remotes, tags', () => {
  const refs: Parameters<typeof sortGitRefs>[0] = [
    { name: 'v1', kind: 'tag', current: false },
    { name: 'origin/main', kind: 'remote', current: false },
    { name: 'dev', kind: 'branch', current: false },
    { name: 'main', kind: 'branch', current: true },
  ]
  assert.deepEqual(sortGitRefs(refs).map((r: any) => r.name), ['main', 'dev', 'origin/main', 'v1'])
})

/* ---------------------------------------------------------------- tabs, and the move from a plugin */

test('a commit diff tab round-trips and is no working-copy diff', () => {
  for (const path of ['C:\\code\\mango', '/home/me/mango', 'env://h/box/srv/app']) {
    const id = commitDiffTabId(path, '99de30b95c426aa0', 'docs/changelog.md')
    assert.ok(isCommitDiffTab(id))
    assert.ok(!isDiffTab(id))
    assert.deepEqual(parseCommitDiffTab(id), {
      projectPath: path, hash: '99de30b95c426aa0', short: '99de30b', file: 'docs/changelog.md', name: 'changelog.md',
    })
  }
  assert.equal(parseCommitDiffTab('chat-1'), null)
})

test('the tab keeps the ref it had as a plugin', () => {
  assert.equal(GIT_LOG_TAB, 'git-log.log')
  assert.ok(isPanelTabRef(GIT_LOG_TAB))
  assert.ok(builtInPluginNote('git-log'))
  assert.equal(builtInPluginNote('scratchpad'), null)
})

test('the tab starts closed, and stays where a saved layout has it', () => {
  const none = { known: undefined, chosen: undefined, order: [] as string[] }
  assert.deepEqual(seedBuiltInTabs({}, none), { [GIT_LOG_TAB]: { at: 'closed' } })
  // The plugin's tab was showing, or had been placed in the strip.
  assert.deepEqual(seedBuiltInTabs({}, { ...none, chosen: GIT_LOG_TAB }), {})
  assert.deepEqual(seedBuiltInTabs({}, { ...none, order: ['term-1', GIT_LOG_TAB] }), {})
  // It had been moved to the main area.
  const editor = normalizePanelPlaces({ [GIT_LOG_TAB]: { at: 'editor', projectPath: '/p', paneId: 'pane-b' } })
  assert.deepEqual(seedBuiltInTabs(editor, none), editor)
  // Opened since: no place means the panel, also after a restart with a terminal in front.
  assert.deepEqual(seedBuiltInTabs({}, { ...none, known: [GIT_LOG_TAB] }), {})
})

test('a key given to the plugin\'s shortcut carries over', () => {
  assert.deepEqual(cleanOverrides({ 'plugin:git-log.show': 'Mod+Alt+L' }), { 'git-log': 'Mod+Alt+L' })
  assert.deepEqual(cleanOverrides({ 'plugin:git-log.show': '' }), { 'git-log': '' })
  assert.deepEqual(cleanOverrides({ 'plugin:git-log.show': 'Mod+Alt+9' }), {})
  assert.deepEqual(cleanOverrides({ 'plugin:git-log.show': 'Mod+Alt+L', 'git-log': 'Mod+Alt+G' }), { 'git-log': 'Mod+Alt+G' })
})

test('the new default never takes a key the user gave to something else', () => {
  assert.equal(resolveBindings({})['git-log'], 'Mod+Alt+9')
  const taken = resolveBindings({ files: 'Mod+Alt+9' })
  assert.equal(taken.files, 'Mod+Alt+9')
  assert.equal(taken['git-log'], '')
  const plugin = { id: 'plugin:x.go', label: 'Go', group: 'X', scope: 'workspace', key: 'Mod+Alt+7' } as const
  const byPlugin = resolveBindings({ 'plugin:x.go': 'Mod+Alt+9' }, [plugin])
  assert.equal(byPlugin['plugin:x.go'], 'Mod+Alt+9')
  assert.equal(byPlugin['git-log'], '')
  // Every other default is as it was, and no two actions share one.
  const defaults = resolveBindings({})
  for (const s of SHORTCUTS) assert.equal(refuse(defaults[s.id]!, s.id, defaults), null, s.id)
})

test('a re-read with the same commits and refs is the same list', () => {
  const ref = (name: string, current = false) => ({ name, kind: 'branch' as const, current })
  const a = [{ hash: 'b', refs: [ref('main', true)] }, { hash: 'a', refs: [] }]
  assert.equal(sameCommits(a, [{ hash: 'b', refs: [ref('main', true)] }, { hash: 'a', refs: [] }]), true)
  assert.equal(sameCommits(a, [{ hash: 'c', refs: [ref('main', true)] }, ...a]), false, 'a new commit')
  assert.equal(sameCommits(a, [{ hash: 'b', refs: [] }, { hash: 'a', refs: [ref('main', true)] }]), false, 'a branch moved')
  assert.equal(sameCommits(a, [{ hash: 'b', refs: [ref('main')] }, { hash: 'a', refs: [] }]), false, 'checked out elsewhere')
  assert.equal(sameCommits(a, a.slice(0, 1)), false)
})
