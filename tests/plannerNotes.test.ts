/**
 * The planner's notes: Markdown read into the editor's document and written back.
 *
 *   node --test tests/plannerNotes.test.ts     (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { linkTarget, openable } from '../plugins/planner/src/item/notes/links.ts'
import {
  fitsRichText, looksLikeMarkdown, NotesText, parse, sameDoc, writeBlocks, type NodeJson,
} from '../plugins/planner/src/item/notes/markdown.ts'

const anew = (text: string) => writeBlocks(parse(text).doc.content!)
function notes(text: string) {
  const parsed = parse(text)
  const keep = new NotesText<NodeJson>(n => n, (a, b) => JSON.stringify(a) === JSON.stringify(b))
  const nodes = parsed.doc.content!
  keep.set(text, parsed, nodes)
  return { keep, nodes }
}

const KNOWN = [
  'one\n\ntwo',
  '# A\n\n## B\n\n###### F',
  '- a\n- b\n  - c\n    - d\n- e',
  '1. a\n2. b\n   - c',
  '7. seven\n8. eight',
  '- [ ] open\n- [x] done\n  - [ ] under',
  '- plain\n- [ ] task\n- [x]',
  '1. [ ] numbered task',
  '> a quote\n>\n> - with a list',
  '```ts\nconst a = `b`\n\n  c\n```',
  '````\n```\n````',
  '---',
  '| A | B |\n| --- | ---: |\n| a \\| b | `c` |\n|  | **d** |',
  '**bold** *italic* ~~strike~~ `code` ***both*** **a *b* c**',
  '[text](https://a.example/x "Title") and [**bold** link](https://b.example)',
  'https://a.example/x and <https://b.example>, me@example.com and www.example.com',
  '[space](<a b.md>) [paren](<https://e.org/a_(b)>)',
  '![shot](images/a.png) text ![](https://e.org/x.png "t")',
  'a\\\nb',
  '\\* not a list, \\# not a heading, 2 * 3, snake_case_name, \\_x\\_',
  '5 < 6 & 7 > 3, &lt;div&gt;, a&nbsp;b',
  '`` a ` b ``',
  '- a\n\n- b\n\n  second paragraph\n\n  ```\n  code\n  ```',
  '1. a\n2. b\n\n   more',
  '- a\n\n* b',
  '> a\n\n> b',
  'text [ ] and [1] and [a]',
]
test('what rich text knows is written back as it is', () => {
  for (const text of KNOWN) {
    const p = parse(text)
    assert.ok(fitsRichText(text, p), `${text}\n-->\n${anew(text)}\n${JSON.stringify(p.doc)}`)
    assert.equal(anew(anew(text)), anew(text), text)
  }
})

test('the usual ways stay, others become them', () => {
  for (const text of [...KNOWN.slice(0, 16), 'a **b** c', '- a\n\n* b']) assert.equal(anew(text), text)
  assert.equal(anew('* a\n* b'), '- a\n- b')
  assert.equal(anew('Title\n==='), '# Title')
  assert.equal(anew('one\ntwo'), 'one two')
  assert.equal(anew('see https://a.example/x.'), 'see <https://a.example/x>.')
})

test('what it does not know is told', () => {
  for (const text of [
    '<div>html</div>', 'a <b>b</b>', 'a <!-- comment --> b', 'x[^1]\n\n[^1]: note', '[a][r]\n\n[r]: https://e.org', '&copy; me',
    '---\ntitle: x\n---\n\ntext', '- # heading in an item', '<details>\n\ntext\n\n</details>', '| a |\n| --- |\n| b<br>c |',
  ]) assert.equal(fitsRichText(text), false, text)
  assert.ok(fitsRichText('`<div>` and `&copy;`'))
  assert.ok(fitsRichText('```html\n<div>&copy;</div>\n```'))
})

test('an unedited text is written back to the letter', () => {
  for (const text of [
    ...KNOWN, '\n\na\n\n\n\nb\n', '* a\n* b\n\n\nTitle\n===\ntext\nwrapped\n\n\n', '# a\ntext', '~~~js\nx\n~~~\n- a\n+ b\n', 'a  \nb  \n',
    '1) a\n1) b', '***\n__b__ _i_\n',
  ]) {
    const { keep, nodes } = notes(text)
    assert.equal(keep.write(nodes), text)
  }
  assert.equal(notes('').keep.write([{ type: 'paragraph' }]), '')
})

test('an edit leaves the other blocks as they were typed', () => {
  const text = 'Title\n=====\n* a\n* b\n\n\nold\nwrapped\n\n__end__\n'
  const { keep, nodes } = notes(text)
  const edited = nodes.map((n, i) => (i === 2 ? { type: 'paragraph', content: [{ type: 'text', text: 'new' }] } : n))
  assert.equal(keep.write(edited), 'Title\n=====\n* a\n* b\n\nnew\n\n__end__\n')
  // Taken back: another node of the same content.
  assert.equal(keep.write(structuredClone(nodes)), text)
  const fence = notes('~~~\nopen\n')
  assert.equal(fence.keep.write([p(t('x')), ...fence.nodes]), 'x\n\n```\nopen\n```')
  assert.equal(fence.keep.write(structuredClone(fence.nodes)), '~~~\nopen\n')
  // The rest gone, an empty paragraph at the end.
  assert.equal(keep.write([...nodes.slice(0, 2), { type: 'paragraph' }]), 'Title\n=====\n* a\n* b')
})

const p = (...content: NodeJson[]): NodeJson => ({ type: 'paragraph', content })
const t = (text: string, ...marks: string[]): NodeJson => ({ type: 'text', text, ...(marks.length ? { marks: marks.map(type => ({ type })) } : {}) })
const li = (checked: boolean | null, ...content: NodeJson[]): NodeJson => ({ type: 'listItem', attrs: { checked }, content })
const list = (type: string, ...content: NodeJson[]): NodeJson => ({ type, attrs: type === 'orderedList' ? { start: 1 } : {}, content })
function survives(doc: NodeJson[]) {
  const out = writeBlocks(doc)
  const back = parse(out)
  assert.ok(!back.unknown && sameDoc({ type: 'doc', content: doc }, back.doc), `${JSON.stringify(doc)}\n${out}\n${JSON.stringify(back.doc.content)}`)
}

const TYPED = [
  '# x', '- x', '+', '1. x', '12) y', '> q', '---', '***', '___', '```', '~~~', '*a*', '_a_', '__a__', '`a`', '~~a~~', '~a~', '[a](b)', '![a](b)', '[a]: b',
  '<div>', '<b', '&amp;', '&copy;', 'a\\*b', 'a\\', '[ ] x', '[^1]', '| a | b |', '===', '2*3*4', '**', 'x * y * z', '![', 'C:\\dir\\*.txt', 'a_b_c', '$a_{b}$', '#', 'a #', '-', '1.',
]
test('typed text never turns into something else', () => {
  for (const text of TYPED) {
    survives([p(t(text))])
    survives([p(t('first'), { type: 'hardBreak' }, t(text))])
    survives([list('bulletList', li(null, p(t(text))))])
    survives([list('bulletList', li(false, p(t(text))))])
    survives([{ type: 'blockquote', content: [p(t(text))] }])
    survives([{ type: 'heading', attrs: { level: 2 }, content: [t(text)] }])
    survives([{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [p(t(text))] }] }] }])
    survives([{ type: 'codeBlock', content: [t(text)] }])
  }
})

test('marks next to each other and around spaces', () => {
  assert.equal(writeBlocks([p(t('a '), t(' b ', 'bold'), t('c'))]), 'a  **b** c')
  assert.equal(writeBlocks([p(t('x', 'bold', 'code'))]), '**`x`**')
  assert.equal(writeBlocks([p(t('a ', 'bold'), t('b', 'bold', 'italic'), t(' c', 'bold'))]), '**a *b* c**')
  assert.equal(writeBlocks([p(t('a ', 'italic'), t('b', 'bold', 'italic'))]), '*a **b***')
  // Overlapping: the spaces give way.
  assert.equal(writeBlocks([p(t('one ', 'bold'), t('two', 'bold', 'italic'), t(' three', 'italic'))]), '**one** **_two_** _three_')
})

test('lists that stand beside each other stay two', () => {
  assert.equal(writeBlocks([list('bulletList', li(null, p(t('a')))), list('bulletList', li(null, p(t('b'))))]), '- a\n\n* b')
  assert.equal(writeBlocks([list('orderedList', li(null, p(t('a')))), list('orderedList', li(null, p(t('b'))))]), '1. a\n\n1) b')
})

test('any document comes back', () => {
  let seed = 7
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return Math.floor((seed / 2147483648) * n)
  }
  const pick = <T>(a: readonly T[]): T => a[rnd(a.length)]!
  const words = ['alpha', 'beta', 'x_y', '2 * 3', 'it\'s', 'a < b', 'R&D', 'C:\\x', '[note]', '50%', '#tag', '- dash', 'é']
  const line = (): NodeJson[] => Array.from({ length: 1 + rnd(4) }, () => pick(words)).flatMap((w, i): NodeJson[] => {
    const marks = rnd(3) ? [] : [pick(['bold', 'italic', 'strike', 'code'])]
    return [...(i ? [t(' ')] : []), t(w, ...marks)]
  })
  const block = (depth: number): NodeJson => {
    switch (rnd(depth > 2 ? 4 : 7)) {
      case 0: return { type: 'heading', attrs: { level: 1 + rnd(3) }, content: line() }
      case 1: return { type: 'codeBlock', attrs: { language: pick([null, 'ts']) }, content: [t(pick(['a\n\n  b', '```', '- x\n1. y']))] }
      case 2:
      case 3: return p(...line())
      case 4: return { type: 'blockquote', content: blocks(depth + 1, 2) }
      default: {
        const ordered = !rnd(3)
        return list(ordered ? 'orderedList' : 'bulletList', ...Array.from({ length: 1 + rnd(3) }, () =>
          li(pick([null, null, true, false]), p(...line()), ...(rnd(3) ? [] : blocks(depth + 1, 2)))))
      }
    }
  }
  const blocks = (depth: number, n: number) => Array.from({ length: 1 + rnd(n) }, () => block(depth))
  for (let i = 0; i < 2000; i++) survives(blocks(0, 4))
})

test('what is pasted as Markdown', () => {
  for (const text of ['# a', 'x\n- y', '**a**', 'an *a* b', '`a`', '[a](b)', '| a | b |', '1. x']) assert.ok(looksLikeMarkdown(text), text)
  for (const text of ['just words', 'a - b', '#tag', '2 * 3 * 4', 'snake_case_name', 'https://x.example']) assert.ok(!looksLikeMarkdown(text), text)
})

test('links go to the web, to mail, or to a path', () => {
  for (const [text, to] of [
    ['https://e.org/a', 'https://e.org/a'], ['e.org/x', 'https://e.org/x'], ['e.org:8080', 'https://e.org:8080'], ['localhost:3000', 'http://localhost:3000'],
    ['me@e.org', 'mailto:me@e.org'], ['docs/a.md', 'docs/a.md'], ['README.md', 'README.md'], ['#part', '#part'],
  ] as const) assert.equal(linkTarget(text), to, text)
  for (const bad of ['', 'javascript:alert(1)', 'JAVASCRIPT:x', 'java\tscript:x', 'data:text/html,x', 'file:///c:/x', 'vbscript:x', 'two words', 'tauri://x']) assert.equal(linkTarget(bad), null, bad)
  assert.equal(openable('https://e.org'), 'https://e.org/')
  for (const closed of ['javascript:alert(1)', 'docs/a.md', 'mailto:a@b.c', 'file:///x', 'e.org']) assert.equal(openable(closed), null, closed)
})
