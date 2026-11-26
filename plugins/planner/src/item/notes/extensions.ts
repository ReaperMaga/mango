/** What the notes' editor knows: the blocks and marks Markdown has, and nothing else. */
import { Extension, InputRule, Mark, mergeAttributes, Node, type AnyExtension, type Editor } from '@tiptap/core'
import { Blockquote } from '@tiptap/extension-blockquote'
import { Bold } from '@tiptap/extension-bold'
import { Code } from '@tiptap/extension-code'
import { CodeBlock } from '@tiptap/extension-code-block'
import { Document } from '@tiptap/extension-document'
import { HardBreak } from '@tiptap/extension-hard-break'
import { Heading } from '@tiptap/extension-heading'
import { HorizontalRule } from '@tiptap/extension-horizontal-rule'
import { Italic } from '@tiptap/extension-italic'
import { BulletList, ListItem, OrderedList } from '@tiptap/extension-list'
import { Paragraph } from '@tiptap/extension-paragraph'
import { Strike } from '@tiptap/extension-strike'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import { Text } from '@tiptap/extension-text'
import { Dropcursor, Gapcursor, Placeholder, TrailingNode, UndoRedo } from '@tiptap/extensions'
import type { ResolvedPos } from '@tiptap/pm/model'
import { TextSelection, type EditorState } from '@tiptap/pm/state'
import { canJoin, findWrapping } from '@tiptap/pm/transform'
import { linkTarget, openable } from './links.ts'
import { slashPlugin } from './slash.ts'

export interface NotesOptions {
  placeholder: string
  toDo: string
  /** A key while the slash menu is open; true: it was the menu's. */
  slashKey: (e: KeyboardEvent) => boolean
  editLink: () => void
  leave: () => void
}

/* ---------------------------------------------------------------- marks */

/** Only ever opened through Mango, and only to the web. */
const Link = Mark.create({
  name: 'link',
  priority: 1000,
  inclusive: false,
  addAttributes: () => ({ href: { default: '' }, title: { default: null } }),
  parseHTML: () => [{
    tag: 'a[href]',
    getAttrs: el => (linkTarget(el.getAttribute('href') ?? '') === null ? false : { href: el.getAttribute('href'), title: el.getAttribute('title') }),
  }],
  renderHTML({ HTMLAttributes: { href, title } }) {
    const url = openable(String(href ?? ''))
    return ['a', { ...(url ? { href: url, rel: 'noopener noreferrer' } : {}), title: title || href || null }, 0]
  },
  addInputRules() {
    const link = this.type
    return [
      // [text](address)
      new InputRule({
        find: /(?:^|[^!\\])\[([^[\]]+)\]\(([^\s()]+)\)$/,
        handler: ({ state, range, match }) => {
          const href = linkTarget(match[2]!)
          if (href === null) return null
          const from = range.from + match[0].indexOf('[')
          const mark = link.create({ href })
          state.tr.replaceWith(from, range.to, state.schema.text(match[1]!, [...state.doc.resolve(from).marks(), mark])).removeStoredMark(link)
        },
      }),
      // An address, once it is over.
      new InputRule({
        find: /(?:^|\s)(https?:\/\/[^\s<>]+)[ 	]$/,
        handler: ({ state, range, match }) => {
          const url = match[1]!.replace(/[.,;:!?)\]}'"]+$/, '')
          if (!openable(url)) return null
          const from = range.from + match[0].indexOf(match[1]!)
          if (state.doc.rangeHasMark(from, from + url.length, link)) return null
          state.tr.addMark(from, from + url.length, link.create({ href: url })).removeStoredMark(link)
        },
      }),
    ]
  },
})

/* ---------------------------------------------------------------- blocks */

/** Shown as its name: a picture is never fetched. */
const Image = Node.create({
  name: 'image',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes: () => ({ src: { default: '' }, alt: { default: '' }, title: { default: null } }),
  parseHTML: () => [{
    tag: 'span[data-planner-image]',
    getAttrs: el => ({ src: el.getAttribute('data-planner-image'), alt: el.getAttribute('data-alt'), title: el.getAttribute('data-title') }),
  }],
  renderHTML({ node }) {
    const { src, alt, title } = node.attrs as Record<string, string | null>
    const name = alt || src?.split(/[\\/]/).at(-1) || src || ''
    return ['span', { 'class': 'pl-notes__image', 'data-planner-image': src, 'data-alt': alt, 'data-title': title, 'title': src }, name]
  },
})

const loose = { loose: { default: false, rendered: false } }

/** An item of any list; with a box (`checked` is not null) it is a to-do. */
function listItem(o: NotesOptions) {
  return ListItem.extend({
    addAttributes: () => ({
      checked: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const own = el.getAttribute('data-checked')
          if (own !== null) return own === 'true'
          const box = el.querySelector(':scope > input[type=checkbox], :scope > label > input[type=checkbox], :scope > p:first-child > input[type=checkbox]')
          return box ? box.hasAttribute('checked') : null
        },
        renderHTML: ({ checked }: Record<string, unknown>) => (typeof checked === 'boolean' ? { 'data-checked': String(checked) } : {}),
      },
    }),
    addNodeView() {
      return ({ node, editor, getPos }) => {
        let current = node
        const dom = document.createElement('li')
        const contentDOM = document.createElement('div')
        const task = typeof node.attrs.checked === 'boolean'
        let box: HTMLInputElement | null = null
        if (task) {
          dom.className = 'pl-notes__todo'
          const holder = document.createElement('span')
          holder.className = 'pl-notes__box'
          holder.contentEditable = 'false'
          box = document.createElement('input')
          box.type = 'checkbox'
          // Mod+Enter is its key: the focus stays in the text.
          box.tabIndex = -1
          holder.append(box)
          holder.addEventListener('mousedown', e => e.preventDefault())
          box.addEventListener('click', (e) => {
            e.preventDefault()
            const at = getPos()
            if (!editor.isEditable || typeof at !== 'number') return
            const checked = !current.attrs.checked
            // After the click, which sets the box back.
            setTimeout(() => {
              if (!editor.isDestroyed && editor.state.doc.nodeAt(at)?.type.name === 'listItem') editor.view.dispatch(editor.state.tr.setNodeAttribute(at, 'checked', checked))
            })
          })
          dom.append(holder)
        }
        dom.append(contentDOM)
        const sync = () => {
          if (!box) return
          box.checked = current.attrs.checked === true
          box.disabled = !editor.isEditable
          box.setAttribute('aria-label', current.firstChild?.textContent || o.toDo)
          dom.classList.toggle('is-done', box.checked)
        }
        sync()
        return {
          dom,
          contentDOM,
          update(next) {
            if (next.type !== current.type || (typeof next.attrs.checked === 'boolean') !== task) return false
            current = next
            sync()
            return true
          },
          ignoreMutation: m => m.type !== 'selection' && !contentDOM.contains(m.target),
        }
      }
    },
    addInputRules() {
      const item = this.type
      return [new InputRule({
        find: /^\[([ xX]?)\]\s$/,
        handler: ({ state, range, match }) => {
          const checked = /x/i.test(match[1]!)
          const { tr } = state
          const $from = state.doc.resolve(range.from)
          if ($from.parent.type.name !== 'paragraph') return null
          if ($from.depth > 1 && $from.node(-1).type === item) {
            if ($from.index(-1) !== 0) return null
            tr.delete(range.from, range.to).setNodeAttribute($from.before(-1), 'checked', checked)
            return
          }
          tr.delete(range.from, range.to)
          const blocks = tr.doc.resolve(range.from).blockRange()
          const wrapping = blocks && findWrapping(blocks, state.schema.nodes.bulletList!)
          if (!blocks || !wrapping) return null
          tr.wrap(blocks, wrapping)
          const at = tr.doc.resolve(range.from + 2)
          tr.setNodeAttribute(at.before(-1), 'checked', checked)
          const list = at.before(-2)
          if (tr.doc.resolve(list).nodeBefore?.type.name === 'bulletList' && canJoin(tr.doc, list)) tr.join(list)
        },
      })]
    },
    addKeyboardShortcuts() {
      const inItem = () => itemDepth(this.editor.state.selection.$from) > 0
      return {
        'Enter': () => {
          const { $from } = this.editor.state.selection
          const checked = $from.depth > 1 && $from.node(-1).type === this.type ? $from.node(-1).attrs.checked : null
          return this.editor.commands.splitListItem(this.name, checked === null ? {} : { checked: false })
        },
        // The focus stays also where there is nothing to indent; Escape leaves.
        'Tab': () => inItem() && (this.editor.commands.sinkListItem(this.name) || true),
        'Shift-Tab': () => inItem() && (this.editor.commands.liftListItem(this.name) || true),
        'Backspace': () => {
          const { $from, empty } = this.editor.state.selection
          if (!empty || $from.parentOffset > 0 || $from.depth < 2 || $from.node(-1).type !== this.type || $from.index(-1) !== 0) return false
          // First the box goes, then the item.
          if ($from.node(-1).attrs.checked !== null) return this.editor.commands.updateAttributes(this.name, { checked: null })
          return this.editor.commands.liftListItem(this.name)
        },
      }
    },
  })
}
function itemDepth($from: ResolvedPos): number {
  for (let d = $from.depth; d > 0; d--) {
    const { name } = $from.node(d).type
    if (name === 'listItem') return d
    if (name === 'tableCell' || name === 'tableHeader') return 0
  }
  return 0
}

const oneCell = {
  colspan: { default: 1, parseHTML: () => 1, rendered: false },
  rowspan: { default: 1, parseHTML: () => 1, rendered: false },
  colwidth: { default: null, parseHTML: () => null, rendered: false },
}
const Cell = TableCell.extend({ content: 'paragraph', addAttributes() { return { ...this.parent?.(), ...oneCell } } })
const HeaderCell = TableHeader.extend({ content: 'paragraph', addAttributes() { return { ...this.parent?.(), ...oneCell } } })
/** Wide ones scroll inside. */
const ScrollTable = Table.extend({
  priority: 120,
  renderHTML({ HTMLAttributes }) {
    return ['div', { class: 'pl-notes__table' }, ['table', mergeAttributes(HTMLAttributes), ['tbody', 0]]]
  },
})

/** Depth of the table cell a position is in, or 0. */
export function cellDepth($from: ResolvedPos): number {
  for (let d = $from.depth; d > 0; d--) if (/^table(Cell|Header)$/.test($from.node(d).type.name)) return d
  return 0
}
export const inCode = (state: EditorState) =>
  state.selection.$from.parent.type.spec.code === true || state.selection.$from.marks().some(m => m.type.name === 'code')

/** The caret one row down in a table, or under it. */
function cellBelow(editor: Editor): boolean {
  const { state, view } = editor
  const { $from } = state.selection
  const d = cellDepth($from)
  if (!d) return false
  const row = $from.index(d - 2) + 1
  const table = $from.node(d - 2)
  let pos = $from.after(d - 2)
  if (row < table.childCount) {
    const cells = table.child(row)
    pos = $from.after(d - 1) + 1
    for (let i = 0; i < Math.min($from.index(d - 1), cells.childCount - 1); i++) pos += cells.child(i).nodeSize
    pos += 1
  }
  view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(pos))).scrollIntoView())
  return true
}

/* ---------------------------------------------------------------- keys */

function keys(o: NotesOptions) {
  return Extension.create({
    name: 'notesKeys',
    priority: 1000,
    addKeyboardShortcuts() {
      const { editor } = this
      const always = (run: () => unknown) => () => {
        run()
        return true
      }
      return {
        // Also with nothing left to undo: the field's own undo knows nothing of the document.
        'Mod-z': always(() => editor.commands.undo()),
        'Mod-Shift-z': always(() => editor.commands.redo()),
        'Mod-y': always(() => editor.commands.redo()),
        'Mod-k': always(() => o.editLink()),
        'Mod-Shift-9': () => toggleToDo(editor),
        'Mod-Enter': always(() => {
          const { $from } = editor.state.selection
          const d = itemDepth($from)
          const item = d ? $from.node(d) : null
          if (typeof item?.attrs.checked !== 'boolean') return o.leave()
          editor.view.dispatch(editor.state.tr.setNodeAttribute($from.before(d), 'checked', !item.attrs.checked))
        }),
        'Escape': always(() => o.leave()),
        'Enter': () => cellBelow(editor),
        'Shift-Enter': () => {
          const { $from } = editor.state.selection
          if (cellDepth($from)) return true
          return $from.parent.type.name === 'heading' ? editor.commands.splitBlock() : false
        },
        'Backspace': () => {
          const { $from, empty } = editor.state.selection
          if (editor.commands.undoInputRule()) return true
          if (!empty || $from.parentOffset > 0 || !$from.parent.isTextblock) return false
          if ($from.parent.type.name === 'heading') return editor.commands.setParagraph()
          if ($from.depth > 1 && $from.node(-1).type.name === 'blockquote' && $from.index(-1) === 0) return editor.commands.lift('blockquote')
          return false
        },
      }
    },
  })
}

export const toDoActive = (editor: Editor) => {
  const { $from } = editor.state.selection
  const d = itemDepth($from)
  return d > 0 && typeof $from.node(d).attrs.checked === 'boolean'
}
/** Takes the selected items' boxes away, or makes to-dos of what is selected. */
export function toggleToDo(editor: Editor): boolean {
  if (toDoActive(editor)) return setBoxes(editor, null)
  if (!itemDepth(editor.state.selection.$from) && !editor.chain().focus().toggleBulletList().run()) return false
  return setBoxes(editor, false)
}
export function setBoxes(editor: Editor, checked: boolean | null): boolean {
  const { state, view } = editor
  const { from, to, $from } = state.selection
  const { tr } = state
  const own = itemDepth($from)
  if (own) tr.setNodeAttribute($from.before(own), 'checked', checked)
  state.doc.nodesBetween(from, to, (n, pos) => {
    if (n.type.name === 'listItem' && pos >= from && pos < to) tr.setNodeAttribute(pos, 'checked', checked)
  })
  view.dispatch(tr)
  return own > 0
}

/* ---------------------------------------------------------------- all */

export function notesExtensions(o: NotesOptions): AnyExtension[] {
  return [
    Document, Text, Paragraph, Heading, Bold, Italic, Strike,
    // Markdown has code that is bold, and links in code.
    Code.extend({ excludes: '' }),
    Link, Image,
    // Mod+Enter is not for this here.
    HardBreak.extend({ addKeyboardShortcuts() { return { 'Shift-Enter': () => this.editor.commands.setHardBreak() } } }),
    // Mod+Shift+B is Mango's.
    Blockquote.extend({ addKeyboardShortcuts: () => ({}) }),
    CodeBlock.extend({ priority: 120 }).configure({ enableTabIndentation: true, tabSize: 2, HTMLAttributes: { spellcheck: 'false' } }),
    HorizontalRule,
    BulletList.extend({ addAttributes: () => loose }),
    OrderedList.extend({ addAttributes() { return { ...this.parent?.(), ...loose } } }),
    listItem(o),
    ScrollTable.configure({ resizable: false, allowTableNodeSelection: false, View: null }), TableRow, Cell, HeaderCell,
    UndoRedo, Gapcursor, TrailingNode,
    Dropcursor.configure({ color: false, class: 'pl-notes__drop', width: 2 }),
    Placeholder.configure({ placeholder: o.placeholder, showOnlyCurrent: false }),
    keys(o),
    Extension.create({ name: 'notesSlash', priority: 2000, addProseMirrorPlugins: () => [slashPlugin(o.slashKey)] }),
  ]
}
