/**
 * The planner's text: editing Markdown in an item's body, dates as typed, the words for a property's options.
 *
 *   node --test tests/plannerText.test.ts     (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyEdit, link, onEnter, onTab, taskMarks, toggleList, toggleTask, wrap, type Edit,
} from '../plugins/planner/src/item/markdownEdit.ts'
import { addMonths, dateText, moment, readDate, sameDayIn, weekdayNames } from '../plugins/planner/src/values/dates.ts'
import { optionWords } from '../plugins/planner/src/values/optionWords.ts'

/** A text with its selection written as `|` (twice for a range). */
function at(marked: string): [text: string, start: number, end: number] {
  const start = marked.indexOf('|')
  const rest = marked.slice(0, start) + marked.slice(start + 1)
  const end = rest.indexOf('|')
  return end < 0 ? [rest, start, start] : [rest.slice(0, end) + rest.slice(end + 1), start, end]
}
function after(text: string, e: Edit | null): string | null {
  if (!e) return null
  const t = applyEdit(text, e)
  return e.start === e.end ? `${t.slice(0, e.start)}|${t.slice(e.start)}` : `${t.slice(0, e.start)}|${t.slice(e.start, e.end)}|${t.slice(e.end)}`
}
const enter = (m: string) => after(at(m)[0], onEnter(...at(m)))
const tab = (m: string, back = false) => after(at(m)[0], onTab(...at(m), back))
const marked = (m: string, mark: string) => after(at(m)[0], wrap(...at(m), mark))
const listed = (m: string, kind: 'bullet' | 'task') => after(at(m)[0], toggleList(...at(m), kind))

test('enter goes on with a list, and ends it on an empty entry', () => {
  assert.equal(enter('- a|'), '- a\n- |')
  assert.equal(enter('9) x| y'), '9) x\n10) | y')
  assert.equal(enter('- [x] d|'), '- [x] d\n- [ ] |')
  assert.equal(enter('> q|'), '> q\n> |')
  assert.equal(enter('- a\n- |'), '- a\n|')
  assert.equal(enter('  - |'), '- |')
  assert.equal(enter('> |'), '|')
  assert.equal(enter('- [ ] |'), '|')
  for (const plain of ['plain|', '```\n- a|', '-| a', '- |a|']) assert.equal(enter(plain), null)
})

test('tab indents entries and selected lines, and puts spaces elsewhere', () => {
  assert.equal(tab('- a|'), '  - a|')
  assert.equal(tab('foo|'), 'foo  |')
  assert.equal(tab('|a\n\nb|'), '  |a\n\n  b|')
  // A selection is indented, never replaced.
  assert.equal(tab('a |b| c'), '  a |b| c')
  assert.equal(tab('|a\n|b'), '  |a\n|b')
  assert.equal(tab('  - a|', true), '- a|')
  assert.equal(tab('|  a\n b|', true), '|a\nb|')
  assert.equal(tab('a|', true), null)
})

test('format keys wrap the selection and take it back', () => {
  assert.equal(marked('|a|', '**'), '**|a|**')
  assert.equal(marked('**|a|**', '**'), '|a|')
  assert.equal(marked('**|a|**', '*'), '***|a|***')
  assert.equal(marked('***|a|***', '*'), '**|a|**')
  assert.equal(marked('*|a|*', '*'), '|a|')
  assert.equal(marked('x| a |y', '**'), 'x **|a|** y')
  assert.equal(marked('|', '**'), '**|**')
  assert.equal(marked('`|a|`', '`'), '|a|')
  const linked = (m: string) => after(at(m)[0], link(...at(m)))
  assert.equal(linked('|foo|'), '[foo](|url|)')
  assert.equal(linked('|'), '[|](url)')
  assert.equal(linked('|https://x.y|'), '[|](https://x.y)')
})

test('lists are turned on and off by line', () => {
  assert.equal(listed('a|', 'task'), '- [ ] a|')
  assert.equal(listed('- a|', 'task'), '- [ ] a|')
  assert.equal(listed('- [ ] a|', 'task'), 'a|')
  assert.equal(listed('|a\nb|', 'bullet'), '|- a\n- b|')
  assert.equal(listed('|', 'bullet'), '- |')
})

test('task boxes are counted as they are drawn: not in code', () => {
  const text = '- [ ] a\n```\n- [ ] no\n```\n  1. [X] b\n> - [ ] c\n- [ ]\n- [y] d'
  assert.deepEqual(taskMarks(text).map(t => t.done), [false, true, false])
  assert.equal(toggleTask('- [ ] a\n- [x] b', 1), '- [ ] a\n- [ ] b')
  assert.equal(toggleTask('- [ ] a', 0), '- [x] a')
  assert.equal(toggleTask('- [ ] a', 5), '- [ ] a')
})

test('dates as people type them', () => {
  ;(globalThis as { document?: unknown }).document = { documentElement: { lang: 'en' } }
  const now = moment('2026-11-25T10:00').getTime()
  const read = (t: string) => readDate(t, now)
  assert.deepEqual(read('today'), { start: '2026-11-25' })
  assert.deepEqual(read(' Tomorrow '), { start: '2026-11-26' })
  assert.deepEqual(read('now'), { start: '2026-11-25T10:00' })
  assert.deepEqual(read('+3'), { start: '2026-11-28' })
  assert.deepEqual(read('-1w'), { start: '2026-11-18' })
  assert.deepEqual(read('2026/3/1'), { start: '2026-03-01' })
  assert.deepEqual(read('2026-3-1 9:30'), { start: '2026-03-01T09:30' })
  assert.deepEqual(read('2026-01-01 to 2026-01-04'), { start: '2026-01-01', end: '2026-01-04' })
  for (const bad of ['1/2', '2026-02-30', 'soon', '']) assert.equal(read(bad), null)
  assert.equal(sameDayIn('2026-01-31', 1), '2026-02-28')
  assert.equal(addMonths('2026-12', 1), '2027-01')
  assert.equal(dateText({ start: '2026-03-01' }, now), 'Mar 1')
  assert.equal(dateText({ start: '2026-03-01T09:30', end: '2027-01-01T10:00' }, now), 'Mar 1, 2026, 09:30 – Jan 1, 2027, 10:00')
  assert.equal(weekdayNames(1)[0], 'Mon')
})

test('the words for a property’s options', () => {
  const words = (name: string) => Object.values(optionWords({ name })).join(' ')
  assert.equal(words('Status'), 'status statuses')
  assert.equal(words('Statuses'), 'status statuses')
  assert.equal(words('Tags'), 'tag tags')
  assert.equal(words('Priority'), 'priority priorities')
  assert.equal(words('Category'), 'category categories')
  assert.equal(words('Stage'), 'stage stages')
  assert.equal(words('Größe'), 'option options')
  assert.equal(words(''), 'option options')
})
