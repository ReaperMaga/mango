import { describe, expect, it } from 'vitest'
import type { Message, Part } from '~/types/chat'
import { changeTree, editsOf, gitChangeFor, initiallyClosed, SHORT, totals, turnChanges, visibleRows } from './changes'

const edit = (target: string, extra: Partial<Extract<Part, { type: 'tool' }>> = {}): Part =>
  ({ type: 'tool', tool: 'edit', target, status: 'ok', ...extra })

describe('turnChanges (shared with the desktop)', () => {
  it('sums every edit to a file and reads counts from the summary or the diff', () => {
    const files = turnChanges([
      edit('src/a.ts', { summary: '+4 −1' }),
      edit('./src/a.ts', { diff: [{ kind: 'add', text: 'x' }, { kind: 'del', text: 'y' }, { kind: 'add', text: 'z' }] }),
      edit('src/b.ts', { status: 'error', summary: '+9' }),
      edit('/etc/hosts', { summary: '+1' }),
      { type: 'text', text: 'done' },
    ])
    expect(files).toEqual([
      { path: 'src/a.ts', add: 6, del: 2, inside: true },
      { path: '/etc/hosts', add: 1, del: 0, inside: false },
    ])
    expect(totals(files)).toEqual({ add: 7, del: 2 })
  })

  it('includes what sub-agents changed', () => {
    const child: Message[] = [{ id: 'c1', role: 'agent', parts: [edit('lib/c.ts', { summary: '+2' })], createdAt: 0 }]
    const files = turnChanges([{ type: 'tool', tool: 'other', target: 'explore', status: 'ok', childId: 'k' }], id => (id === 'k' ? child : []))
    expect(files.map(f => f.path)).toEqual(['lib/c.ts'])
  })
})

describe('visibleRows', () => {
  const files = turnChanges([edit('app/x/one.ts', { summary: '+1' }), edit('app/x/two.ts', { summary: '+2' }), edit('README.md', { summary: '−1' })])
  const tree = changeTree(files)

  it('lists folders before files, merged folders open by default', () => {
    expect(visibleRows(tree, new Set()).map(r => [r.node.name, r.depth])).toEqual([
      ['app/x', 0], ['one.ts', 1], ['two.ts', 1], ['README.md', 0],
    ])
  })

  it('hides what is under a closed folder', () => {
    const rows = visibleRows(tree, new Set(['app/x']))
    expect(rows.map(r => r.node.name)).toEqual(['app/x', 'README.md'])
    expect(rows[0]!.open).toBe(false)
  })

  it('closes every folder of a long list at first', () => {
    expect(initiallyClosed(files, tree).size).toBe(0)
    const many = turnChanges(Array.from({ length: SHORT + 1 }, (_, i) => edit(`src/f${i}.ts`)))
    expect([...initiallyClosed(many, changeTree(many))]).toEqual(['src'])
  })
})

describe('gitChangeFor', () => {
  const changes = [{ path: 'web/src/a.ts' }, { path: 'src/b.ts' }, { path: 'x/c.ts' }, { path: 'y/c.ts' }]
  it('matches exactly, then by the one path ending in it (a chat folder below the repository root)', () => {
    expect(gitChangeFor(changes, 'src/b.ts')).toBe(changes[1])
    expect(gitChangeFor(changes, 'src/a.ts')).toBe(changes[0])
  })
  it('is null when git has no change left for it, or the match is ambiguous', () => {
    expect(gitChangeFor(changes, 'src/z.ts')).toBeNull()
    expect(gitChangeFor(changes, 'c.ts')).toBeNull()
  })
})

describe('editsOf', () => {
  it('returns one edit as it is', () => {
    const diff = [{ kind: 'add' as const, text: 'a' }]
    expect(editsOf([edit('a.ts', { diff }), edit('b.ts', { diff: [{ kind: 'del', text: 'b' }] })], 'a.ts')).toEqual(diff)
  })

  it('bands several edits, keeps their own hunk headers, follows moves and skips failures', () => {
    const lines = editsOf([
      edit('old.ts → a.ts', { diff: [{ kind: 'add', text: '1' }] }),
      edit('a.ts', { diff: [{ kind: 'hunk', text: '@@ -1 +1 @@' }, { kind: 'del', text: '2' }] }),
      edit('a.ts', { status: 'error', diff: [{ kind: 'add', text: 'no' }] }),
      edit('a.ts', { summary: '+3' }),
    ], 'a.ts')
    expect(lines).toEqual([
      { kind: 'hunk', text: 'Edit 1 of 2' }, { kind: 'add', text: '1' },
      { kind: 'hunk', text: '@@ -1 +1 @@' }, { kind: 'del', text: '2' },
    ])
  })

  it('is empty when only a summary was recorded', () => {
    expect(editsOf([edit('a.ts', { summary: '+3' })], 'a.ts')).toEqual([])
  })
})
