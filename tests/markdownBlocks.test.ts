/**
 * ChatMarkdown renders a streaming reply block by block (each top-level token parsed on its own) and a
 * complete one in a single parse. The two must agree, and raw HTML must stay escaped either way.
 *
 *   node --test tests/markdownBlocks.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Marked } from 'marked'

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
// The same options and the escaping parts of ChatMarkdown's renderer.
const md = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html({ text }) { return escape(text) },
    code({ text, lang }) { return `<pre><code${lang ? ` class="language-${escape(lang)}"` : ''}>${escape(text)}</code></pre>\n` },
    link({ href, text }) { return `<a href="${escape(/^(https?:|mailto:)/i.test(href) ? href : '#')}">${text}</a>` },
  },
})

const byBlocks = (text: string) => md.lexer(text).map(token => md.parser([token]) as string).join('')

const samples = [
  '',
  'Hello **world**.',
  'One.\n\nTwo, with `code` and a [link](https://example.com).\n\n- a\n- b\n  - nested\n\n1. one\n2. two\n',
  '# Title\n\nText\n\n```ts\nconst x = 1 < 2\n```\n\n> quoted\n> more\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n',
  'A [reference][r] link, defined later.\n\n[r]: https://example.com/r\n',
  'Raw <script>alert(1)</script> inline.\n\n<div onclick="x()">block html</div>\n\nafter',
  'A list\n- tight\n- items\n\n- loose\n\n- items\n',
  // Cut off mid-stream: an open fence, half a table, a dangling emphasis.
  'Start\n\n```js\nlet a = 1\n',
  '| a | b |\n|---|',
  'some *emph',
]

test('block-by-block rendering matches the whole parse', () => {
  for (const text of samples) assert.equal(byBlocks(text), md.parse(text), JSON.stringify(text))
})

test('every prefix of a reply, as it streams, matches too', () => {
  const reply = samples.join('\n\n')
  for (let n = 0; n <= reply.length; n += 7) {
    const text = reply.slice(0, n)
    assert.equal(byBlocks(text), md.parse(text), `prefix ${n}`)
  }
})

test('raw HTML stays escaped when rendered by blocks', () => {
  const out = byBlocks('x <img src=x onerror=alert(1)>\n\n<script>bad()</script>\n')
  assert.ok(!/<img|<script/i.test(out), out)
})
