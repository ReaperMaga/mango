import type { GhJobStep } from '~/types/ipc'
import { parseStepLog, type LogEntry, type LogLine } from '~/utils/actionsLog'

/**
 * A GitHub Actions job's log as one flat list of rows, so the check log screen can virtualise it
 * (a step can hold thousands of lines): each step, and under an open one its log, where
 * `##[group]` sections fold. A failed step opens by itself, a group with an error in it too; the
 * person's own choices (by step number, and by `step:line` for groups) win. Pure: tested in
 * `checkLog.test.ts`.
 */

export type LogRow =
  | { kind: 'step'; key: string; step: GhJobStep; open: boolean; hasLog: boolean }
  | { kind: 'omitted'; key: string; count: number }
  | { kind: 'line'; key: string; line: LogLine; inner: boolean; gutter: number }
  | { kind: 'group'; key: string; group: string; head: LogLine; open: boolean; gutter: number }
  | { kind: 'start'; key: string }
  | { kind: 'end'; key: string }

export const hasLog = (s: GhJobStep): boolean => s.lines.length > 0 || s.omitted > 0

/** Parse every step's lines once per read. */
export function parseSteps(steps: readonly GhJobStep[]): Map<number, LogEntry[]> {
  const out = new Map<number, LogEntry[]>()
  for (const s of steps) if (s.lines.length) out.set(s.number, parseStepLog(s.lines, s.omitted + 1))
  return out
}

export const stepOpen = (s: GhJobStep, choice: ReadonlyMap<number, boolean>): boolean =>
  hasLog(s) && (choice.get(s.number) ?? s.state === 'failure')

export const groupKey = (step: number, head: LogLine): string => `${step}:${head.n}`

export const groupOpen = (key: string, lines: readonly LogLine[], choice: ReadonlyMap<string, boolean>): boolean =>
  choice.get(key) ?? lines.some(l => l.level === 'error')

export function logRows(
  steps: readonly GhJobStep[],
  parsed: ReadonlyMap<number, LogEntry[]>,
  stepChoice: ReadonlyMap<number, boolean>,
  groupChoice: ReadonlyMap<string, boolean>,
): LogRow[] {
  const rows: LogRow[] = []
  for (const s of steps) {
    const open = stepOpen(s, stepChoice)
    rows.push({ kind: 'step', key: `s${s.number}`, step: s, open, hasLog: hasLog(s) })
    if (!open) continue
    // The gutter fits the step's largest line number.
    const gutter = String(s.omitted + s.lines.length).length
    rows.push({ kind: 'start', key: `s${s.number}b` })
    if (s.omitted) rows.push({ kind: 'omitted', key: `s${s.number}o`, count: s.omitted })
    for (const e of parsed.get(s.number) ?? []) {
      if (e.kind === 'line') {
        rows.push({ kind: 'line', key: `s${s.number}l${e.line.n}`, line: e.line, inner: false, gutter })
        continue
      }
      const g = groupKey(s.number, e.head)
      const gOpen = groupOpen(g, e.lines, groupChoice)
      rows.push({ kind: 'group', key: `s${s.number}g${e.head.n}`, group: g, head: e.head, open: gOpen, gutter })
      if (gOpen) for (const l of e.lines) rows.push({ kind: 'line', key: `s${s.number}l${l.n}`, line: l, inner: true, gutter })
    }
    rows.push({ kind: 'end', key: `s${s.number}e` })
  }
  return rows
}

/** The first error line among the rows, to bring into view once the log arrives; -1 when none. */
export const firstErrorRow = (rows: readonly LogRow[]): number =>
  rows.findIndex(r => r.kind === 'line' && r.line.level === 'error')
