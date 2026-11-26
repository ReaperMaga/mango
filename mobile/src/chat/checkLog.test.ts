import { describe, expect, it } from 'vitest'
import type { GhJobStep } from '~/types/ipc'
import { firstErrorRow, logRows, parseSteps } from './checkLog'

const step = (number: number, state: GhJobStep['state'], lines: string[] = [], omitted = 0): GhJobStep =>
  ({ number, name: `Step ${number}`, state, startedAt: null, completedAt: null, lines, omitted })

const kinds = (rows: ReturnType<typeof logRows>) => rows.map(r => r.kind)

describe('check log rows', () => {
  const steps = [
    step(1, 'success', ['setting up', 'done']),
    step(2, 'failure', ['##[group]Install', 'npm i', '##[error]boom', '##[endgroup]', '##[group]Quiet', 'ok', '##[endgroup]', 'after'], 3),
    step(3, 'skipped'),
  ]
  const parsed = parseSteps(steps)

  it('opens a failed step by itself, and a group with an error in it', () => {
    const rows = logRows(steps, parsed, new Map(), new Map())
    expect(kinds(rows)).toEqual(['step', 'step', 'start', 'omitted', 'group', 'line', 'line', 'group', 'line', 'end', 'step'])
    const groups = rows.filter(r => r.kind === 'group')
    expect(groups.map(g => g.kind === 'group' && g.open)).toEqual([true, false])
    // Lines are numbered after the omitted ones, as GitHub numbers them.
    expect(rows.find(r => r.kind === 'group')).toMatchObject({ head: { n: 4 } })
    expect(rows.find(r => r.kind === 'step' && r.step.number === 3)).toMatchObject({ hasLog: false, open: false })
  })

  it('follows the person\'s choices', () => {
    const rows = logRows(steps, parsed, new Map([[1, true], [2, false]]), new Map())
    expect(kinds(rows)).toEqual(['step', 'start', 'line', 'line', 'end', 'step', 'step'])
    const open = logRows(steps, parsed, new Map(), new Map([['2:4', false], ['2:7', true]]))
    expect(kinds(open)).toEqual(['step', 'step', 'start', 'omitted', 'group', 'group', 'line', 'line', 'end', 'step'])
  })

  it('a step without a log never opens', () => {
    expect(kinds(logRows([step(5, 'failure')], new Map(), new Map([[5, true]]), new Map()))).toEqual(['step'])
  })

  it('finds the first error', () => {
    const rows = logRows(steps, parsed, new Map(), new Map())
    const i = firstErrorRow(rows)
    expect(rows[i]).toMatchObject({ kind: 'line', inner: true, line: { level: 'error' } })
    expect(firstErrorRow(logRows([step(1, 'success', ['fine'])], parseSteps([step(1, 'success', ['fine'])]), new Map([[1, true]]), new Map()))).toBe(-1)
  })

  it('keys stay unique', () => {
    const rows = logRows(steps, parsed, new Map([[1, true]]), new Map([['2:7', true]]))
    expect(new Set(rows.map(r => r.key)).size).toBe(rows.length)
  })
})
