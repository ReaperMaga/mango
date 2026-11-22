/**
 * A file read again from disk reaches the editor as small edits. Plain Node:
 *
 *   node --test tests/reloadEdits.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eolOf, reloadEdits, splitLines, type LineEdit } from '../app/utils/reloadEdits.ts'

/** As Monaco applies edits: all in the old text's coordinates, none overlapping. */
function apply(old: string[], edits: LineEdit[], eol: string): string {
  const at = (line: number, column: number) => old.slice(0, line - 1).reduce((n, l) => n + l.length + eol.length, 0) + column - 1
  const spans = edits
    .map(({ range: r, text }) => ({ from: at(r.startLineNumber, r.startColumn), to: at(r.endLineNumber, r.endColumn), text }))
    .sort((a, b) => a.from - b.from || a.to - b.to)
  let text = old.join(eol)
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i]!.from >= spans[i - 1]!.to, 'edits overlap')
  for (const s of spans.reverse()) text = text.slice(0, s.from) + s.text + text.slice(s.to)
  return text
}

const check = (before: string, after: string, eol = '\n') => {
  const old = splitLines(before)
  const edits = reloadEdits(old, splitLines(after), eol)
  assert.equal(apply(old, edits, eol), splitLines(after).join(eol), JSON.stringify([before, after]))
  return edits
}

test('the edge cases come out as the new text', () => {
  const texts = ['', '\n', 'a', 'a\n', '\na', 'a\nb\nc', 'a\nb\nc\n', 'x\nb\ny', 'b', 'c\nb\na', 'a\n\n\nc', '🥭', '🍎 b']
  for (const before of texts) {
    for (const after of texts) {
      check(before, after)
      check(before, after, '\r\n')
    }
  }
})

test('random changes come out as the new text', () => {
  let seed = 7
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const line = () => ['', 'a', 'b', 'let x = 1', 'let y = 2', '}'][Math.floor(random() * 6)]!
  for (let i = 0; i < 4000; i++) {
    const before = Array.from({ length: Math.ceil(random() * 12) }, line)
    const after = before.flatMap(l => (random() < 0.15 ? [] : random() < 0.15 ? [line(), l] : random() < 0.15 ? [line()] : [l]))
    if (random() < 0.2) after.push(line())
    check(before.join('\n'), after.join('\n'))
  }
})

test('edits far apart stay apart, so the caret between them does not move', () => {
  const before = Array.from({ length: 100 }, (_, i) => `line ${i}`)
  const after = [...before]
  after[2] = 'line two'
  after[90] = 'line ninety'
  const edits = check(before.join('\n'), after.join('\n'))
  assert.deepEqual(edits.map(e => [e.range.startLineNumber, e.range.endLineNumber]), [[3, 3], [91, 91]])
  assert.equal(edits[0]!.range.startColumn, 6, 'only the part of the line that changed')
})

test('a surrogate pair is never split', () => {
  const [edit] = check('x🥭y', 'x🥮y')
  assert.equal(edit!.text, '🥮')
})

test('the end of line Monaco would pick', () => {
  assert.equal(eolOf('a\r\nb\r\nc\n'), '\r\n')
  assert.equal(eolOf('a\nb\r\n'), '\n')
  assert.equal(eolOf('one line'), null)
})
