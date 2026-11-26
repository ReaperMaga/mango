/**
 * A file read again from disk reaches the editor as small edits. Plain Node:
 *
 *   node --test tests/reloadEdits.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eolOf, reloadEdits, reloadModel, splitLines, type LineEdit } from '../app/utils/reloadEdits.ts'

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

/* ---------- on Monaco's real TextModel */

const monacoFile = (path: string) => import(new URL(`../node_modules/monaco-editor/esm/vs/${path}.js`, import.meta.url).href)
const { TextModel } = await monacoFile('editor/common/model/textModel')
const { InstantiationService } = await monacoFile('platform/instantiation/common/instantiationService')
const { ServiceCollection } = await monacoFile('platform/instantiation/common/serviceCollection')
const { LanguageService } = await monacoFile('editor/common/services/languageService')
const { ILanguageService } = await monacoFile('editor/common/languages/language')
const { ILanguageConfigurationService } = await monacoFile('editor/common/languages/languageConfigurationRegistry')
const { ITreeSitterLibraryService } = await monacoFile('editor/common/services/treeSitter/treeSitterLibraryService')
const { IUndoRedoService } = await monacoFile('platform/undoRedo/common/undoRedo')
const { UndoRedoService } = await monacoFile('platform/undoRedo/common/undoRedoService')

const services = new InstantiationService(new ServiceCollection(
  [ILanguageService, new LanguageService()],
  [IUndoRedoService, new UndoRedoService({}, {})],
  [ILanguageConfigurationService, { onDidChange: () => ({ dispose() {} }), getLanguageConfiguration: () => ({}) }],
  [ITreeSitterLibraryService, { supportsLanguage: () => false }],
), false)
const modelOf = (text: string) => services.createInstance(TextModel, text, 'plaintext', TextModel.DEFAULT_CREATION_OPTIONS, null)

/** Enter at the end of `line` with the editor's auto-indent, which it offers to trim at the next edit. */
function enter(model: any, line: number, indent: string) {
  const column = model.getLineMaxColumn(line)
  model.pushStackElement()
  model.pushEditOperations(null, [{
    range: { startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column },
    text: model.getEOL() + indent,
    isAutoWhitespaceEdit: true,
  }], () => null)
  model.pushStackElement()
}

for (const eol of ['\n', '\r\n']) {
  test(`a reload after Enter's auto-indent keeps undo and the caret (${eol.length === 1 ? 'LF' : 'CRLF'})`, async () => {
    const typed = ['def total():', '    first = 1', '    return first', '', 'line six = 6', ''].join(eol)
    const model = modelOf(typed)
    enter(model, 2, '    ')
    const entered = model.getValue()
    const [caret] = model.deltaDecorations([], [{ range: { startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 5 }, options: { description: 'caret', stickiness: 1 } }])
    let flushed = false
    const sub = model.onDidChangeContent((e: any) => { flushed ||= e.isFlush })
    const disk = entered.replace('six = 6', 'SIX = 6')
    reloadModel(model, disk)
    assert.equal(model.getValue(), disk, 'and nothing else, the indentation neither')
    assert.equal(flushed, false)
    const at = model.getDecorationRange(caret)
    assert.deepEqual([at.startLineNumber, at.startColumn], [3, 5])
    assert.equal(model.getOptions().trimAutoWhitespace, true)
    await model.undo()
    assert.equal(model.getValue(), entered)
    await model.undo()
    assert.equal(model.getValue(), typed)
    sub.dispose()
    model.dispose()
  })
}

test('a reload is exact and can be undone, whatever was typed before it', async () => {
  let seed = 11
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const pick = (from: string[]) => from[Math.floor(random() * from.length)]!
  const text = () => Array.from({ length: Math.ceil(random() * 8) }, () => pick(['', 'a', '  b', '    ', '}', '🥭x', '🥮x'])).join(pick(['\n', '\r\n']))
  for (let i = 0; i < 1500; i++) {
    const model = modelOf(text())
    if (random() < 0.7) enter(model, Math.ceil(random() * model.getLineCount()), pick(['  ', '    ', '\t']))
    const before = model.getValue()
    const disk = `${random() < 0.1 ? '\uFEFF' : ''}${text()}`
    reloadModel(model, disk)
    const body = disk.replace('\uFEFF', '')
    assert.equal(model.getValue(), splitLines(body).join(eolOf(body) ?? (before.includes('\r\n') ? '\r\n' : model.getEOL())), JSON.stringify([before, disk]))
    if (model.getValue() !== before) {
      await model.undo()
      assert.equal(model.getValue(), before, JSON.stringify([before, disk]))
    }
    model.dispose()
  }
})
