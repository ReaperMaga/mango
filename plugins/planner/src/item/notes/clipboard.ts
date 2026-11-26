/** Markdown on the clipboard, both ways. */
import type { Fragment, Node as PmNode, Slice as PmSlice } from '@tiptap/pm/model'
import { Slice } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import { inCode } from './extensions.ts'
import { openable } from './links.ts'
import { looksLikeMarkdown, parse, writeBlocks, writeInline, type NodeJson } from './markdown.ts'

/** What is copied, as the text other apps get. */
export function copiedText(slice: PmSlice): string {
  let content: Fragment = slice.content
  let open = Math.min(slice.openStart, slice.openEnd)
  // From inside one block: only its text.
  while (open > 0 && content.childCount === 1) {
    const only = content.firstChild!
    if (only.isTextblock) {
      if (only.type.spec.code) return only.textContent
      let plain = true
      only.forEach((n) => { if (n.marks.length || (!n.isText && n.type.name !== 'hardBreak')) plain = false })
      return plain ? only.textBetween(0, only.content.size, '\n', '\n') : writeInline(json(only.content))
    }
    content = only.content
    open--
  }
  const blocks = json(content)
  switch (content.firstChild?.type.name) {
    case 'listItem': return writeBlocks([{ type: 'bulletList', content: blocks }])
    case 'tableRow': return writeBlocks([{ type: 'table', content: blocks }])
    case 'tableCell':
    case 'tableHeader': return writeBlocks([{ type: 'table', content: [{ type: 'tableRow', content: blocks }] }])
    default: return content.firstChild?.isInline ? writeInline(blocks) : writeBlocks(blocks)
  }
}
const json = (content: Fragment): NodeJson[] => content.content.map((n: PmNode) => n.toJSON() as NodeJson)

/** Markdown as it goes into the document. */
export function pastedSlice(view: EditorView, text: string): PmSlice {
  const { schema } = view.state
  const blocks = (parse(text).doc.content ?? []).map(n => schema.nodeFromJSON(tidy(n)))
  const at = (n: PmNode | undefined) => (n?.type.name === 'paragraph' ? 1 : 0)
  return new Slice(schema.topNodeType.create(null, blocks).content, at(blocks[0]), at(blocks.at(-1)))
}
/** Empty texts are none. */
function tidy(n: NodeJson): NodeJson {
  return n.content ? { ...n, content: n.content.filter(c => c.type !== 'text' || c.text).map(tidy) } : n
}

/** Pastes what is Markdown or an address; false: the editor's own way is right. */
export function pasteText(view: EditorView, event: ClipboardEvent, plain: boolean): boolean {
  const { state } = view
  const text = event.clipboardData?.getData('text/plain').replace(/\r\n?/g, '\n') ?? ''
  if (plain || !text || inCode(state)) return false
  const url = /^\s*(https?:\/\/\S+)\s*$/i.exec(text)?.[1]
  const link = state.schema.marks.link!
  if (url && openable(url)) {
    const { from, to, empty, $from } = state.selection
    const mark = link.create({ href: url })
    if (!$from.parent.isTextblock) return false
    const tr = empty
      ? state.tr.replaceSelectionWith(state.schema.text(url, [...$from.marks(), mark]), false)
      : state.tr.addMark(from, to, mark)
    view.dispatch(tr.removeStoredMark(link).scrollIntoView())
    return true
  }
  const html = event.clipboardData?.getData('text/html') ?? ''
  // A code editor's HTML is only its colors.
  const source = !html || event.clipboardData!.types.includes('vscode-editor-data')
  if (!source || !looksLikeMarkdown(text)) return false
  view.dispatch(state.tr.replaceSelection(pastedSlice(view, text)).scrollIntoView().setMeta('paste', true).setMeta('uiEvent', 'paste'))
  return true
}
