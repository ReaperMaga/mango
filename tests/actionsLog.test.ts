/**
 * Job logs as the check log view reads them (app/utils/actionsLog.ts): GitHub Actions markers, and
 * GitLab's lines (ANSI colours, carriage returns, nested sections as `##[group]`). Plain Node:
 *
 *   node --test tests/actionsLog.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lineText, parseStepLog, type LogEntry } from '../app/utils/actionsLog.ts'

const texts = (entries: LogEntry[]) => entries.map(e => (e.kind === 'line' ? lineText(e.line) : `[${lineText(e.head)}: ${e.lines.map(lineText).join(' | ')}]`))

test('GitHub groups fold and levels are marked', () => {
  const e = parseStepLog(['##[group]Run tests', 'one', '##[endgroup]', '##[error]boom'])
  assert.deepEqual(texts(e), ['[Run tests: one]', 'boom'])
  assert.equal(e[1]!.kind === 'line' && e[1]!.line.level, 'error')
})

test('a GitLab line redrawn with carriage returns shows as it ended', () => {
  const e = parseStepLog(['Uploading artifacts... 10%\r\x1b[0KUploading artifacts... 100%', 'done\r', '\x1b[32;1mJob succeeded\x1b[0;m'])
  assert.deepEqual(texts(e), ['Uploading artifacts... 100%', 'done', 'Job succeeded'])
  const last = e[2]!.kind === 'line' ? e[2]!.line.spans[0]! : null
  assert.equal(last?.fg, 'green')
  assert.equal(last?.bold, true)
})

test('GitLab nested sections come as groups and fold the same way', () => {
  const e = parseStepLog(['$ npm ci', '##[group]Installing', 'added 812 packages', '##[endgroup]', 'ok'])
  assert.deepEqual(texts(e), ['$ npm ci', '[Installing: added 812 packages]', 'ok'])
})
