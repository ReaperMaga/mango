<script setup lang="ts">
import { Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import type { Node as PmNode } from '@tiptap/pm/model'
import { AllSelection, TextSelection, type Transaction } from '@tiptap/pm/state'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { usePlanner } from '../../context.ts'
import Icon from '../../ui/Icon.vue'
import { strings } from '../strings.ts'
import { findBlocks, setBlock, type BlockKind } from './blocks.ts'
import { copiedText, pasteText } from './clipboard.ts'
import { cellDepth, notesExtensions } from './extensions.ts'
import LinkPopover from './LinkPopover.vue'
import { openable } from './links.ts'
import { fitsRichText, NotesText, parse, type NodeJson } from './markdown.ts'
import SlashMenu from './SlashMenu.vue'
import { closeSlash, slashOf, type Slash } from './slash.ts'

/** Markdown edited as what it means. `body` is the text as it is kept; an unedited one is never written. */
const props = defineProps<{ body: string; readonly: boolean }>()
const emit = defineEmits<{
  change: [body: string]
  /** The text became one that cannot be edited here, in another window. */
  unfit: []
  blur: []
  leave: []
}>()
const { mango } = usePlanner()
const { IconButton } = mango.ui.components
const isMac = mango.platform === 'macos' || /Mac/.test(navigator.platform)
const keyOf = (k: string) => (isMac ? `⌘${k}` : `Ctrl+${k}`)

const host = ref<HTMLElement | null>(null)
const editor = shallowRef<Editor | null>(null)
const text = new NotesText<PmNode>(n => n.toJSON() as NodeJson, (a, b) => a.eq(b))
/** The text as both sides last knew it. */
let known = props.body
/** Came while a character was being composed. */
let waiting = false

const blocksOf = (doc: PmNode): PmNode[] => [...doc.content.content]
const docOf = (body: string) => {
  const parsed = parse(body)
  return { parsed, json: { ...parsed.doc, content: (parsed.doc.content ?? []).map(dropEmpty) } }
}
function dropEmpty(n: NodeJson): NodeJson {
  return n.content ? { ...n, content: n.content.filter(c => c.type !== 'text' || c.text).map(dropEmpty) } : n
}
function remember(body: string, parsed: ReturnType<typeof parse>, e: Editor) {
  // Past what was parsed there is at most an empty paragraph to write in.
  text.set(body, parsed, blocksOf(e.state.doc).slice(0, parsed.sources.length))
}

function save() {
  const e = editor.value
  if (!e) return
  const md = text.write(blocksOf(e.state.doc))
  if (md === known) return
  known = md
  emit('change', md)
}

/** The text changed elsewhere: only what differs is replaced, so a caret stays where it is. */
function take(body: string) {
  const e = editor.value
  if (!e || body === known) return
  if (e.view.composing) {
    waiting = true
    return
  }
  const { parsed, json } = docOf(body)
  known = body
  if (!fitsRichText(body, parsed)) return emit('unfit')
  const next = e.schema.nodeFromJSON(json)
  const now = e.state.doc
  const tr = e.state.tr
  const start = now.content.findDiffStart(next.content)
  const end = start === null ? null : now.content.findDiffEnd(next.content)
  if (start !== null && end) {
    // The same text on both sides of the change counts once.
    const overlap = Math.max(0, start - Math.min(end.a, end.b))
    tr.replace(start, end.a + overlap, next.slice(start, end.b + overlap))
    if (!tr.doc.eq(next)) tr.replaceWith(0, tr.doc.content.size, next.content)
    e.view.dispatch(closeHistory(tr).setMeta('addToHistory', false).setMeta('notesExternal', true))
  }
  remember(body, parsed, e)
}

onMounted(() => {
  const { parsed, json } = docOf(props.body)
  const e = new Editor({
    element: host.value,
    extensions: notesExtensions({ placeholder: strings.bodyPlaceholder, toDo: strings.blocks.todos, slashKey, editLink, leave: () => emit('leave') }),
    content: json,
    editable: !props.readonly,
    injectCSS: false,
    enablePasteRules: false,
    coreExtensionOptions: { clipboardTextSerializer: { blockSeparator: '\n' } },
    editorProps: {
      attributes: {
        'class': 'pl-notes__text',
        'role': 'textbox',
        'aria-multiline': 'true',
        'aria-label': strings.body,
        // Mango's keys for these wait while the text has the focus.
        'data-own-keys': 'Mod+B Mod+I Mod+E Mod+K',
      },
      clipboardTextSerializer: copiedText,
      handlePaste: (view, event) => pasteText(view, event, shift),
      handleDOMEvents: {
        // The planner's (a new item): the editor would take any Enter.
        keydown: (_, e) => e.key === 'Enter' && e.shiftKey && (isMac ? e.metaKey : e.ctrlKey),
        click: onLinkClick,
        auxclick: onLinkClick,
        compositionend: () => {
          if (waiting) setTimeout(() => take(props.body), 50)
          waiting = false
          return false
        },
        blur: () => {
          close()
          emit('blur')
          return false
        },
      },
    },
    onTransaction: ({ transaction }) => onTransaction(transaction),
    onFocus: refresh,
  })
  editor.value = e
  remember(props.body, parsed, e)
})
function onTransaction(tr: Transaction) {
  if (!editor.value) return
  if (tr.docChanged && !tr.getMeta('notesExternal')) save()
  refresh()
}
watch(() => props.body, take)
watch(() => props.readonly, v => editor.value?.setEditable(!v, false))
onBeforeUnmount(() => {
  // The field's blur may come with it.
  const e = editor.value
  editor.value = null
  e?.destroy()
})

/* Plain pasting (Mod+Shift+V) is known by the key before it. */
let shift = false
function onKeyState(e: KeyboardEvent) {
  shift = e.shiftKey
}

/* ---------------------------------------------------------------- links */

function onLinkClick(view: Editor['view'], event: MouseEvent): boolean {
  const a = (event.target as HTMLElement).closest?.('a')
  if (!a || !view.dom.contains(a)) return false
  // Never the webview's own navigation.
  event.preventDefault()
  const wanted = event.button === 1 || (event.button === 0 && (props.readonly || (isMac ? event.metaKey : event.ctrlKey)))
  if (wanted) open(a.getAttribute('href') ?? '')
  return wanted
}
function open(href: string) {
  const url = openable(href)
  if (url) mango.workspace.openBrowser(url)
}

const linkEdit = ref<{ href: string; anchor: { x: number; y: number } } | null>(null)
function editLink() {
  const e = editor.value
  if (!e || props.readonly || e.isActive('codeBlock')) return
  if (e.isActive('link')) e.commands.extendMarkRange('link')
  const { from, empty } = e.state.selection
  // Nothing selected: the word at the caret, if it is at one.
  if (empty && !selectWord(e)) e.commands.focus()
  const at = e.view.coordsAtPos(from)
  linkEdit.value = { href: String(e.getAttributes('link').href ?? ''), anchor: { x: at.left, y: window.innerHeight - at.bottom < 110 ? at.top - 4 : at.bottom + 4 } }
}
function selectWord(e: Editor): boolean {
  const { $from } = e.state.selection
  if (!$from.parent.isTextblock) return false
  const all = $from.parent.textBetween(0, $from.parent.content.size, '\n', '\n')
  const at = $from.parentOffset
  const left = /[^\s]*$/.exec(all.slice(0, at))![0].length
  const right = /^[^\s]*/.exec(all.slice(at))![0].length
  if (!left && !right) return false
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, $from.pos - left, $from.pos + right)))
  return true
}
function saveLink(href: string) {
  const e = editor.value
  linkEdit.value = null
  if (!e) return
  const { from, to, empty } = e.state.selection
  const mark = e.schema.marks.link!.create({ href })
  const tr = empty ? e.state.tr.insert(from, e.schema.text(href, [mark])) : e.state.tr.removeMark(from, to, e.schema.marks.link!).addMark(from, to, mark)
  e.view.dispatch(tr.removeStoredMark(mark.type))
  e.commands.focus(tr.mapping.map(to))
}
function removeLink() {
  linkEdit.value = null
  editor.value?.chain().focus().extendMarkRange('link').unsetMark('link').run()
}

/* ---------------------------------------------------------------- what floats */

const menuId = `pl-slash-${Math.random().toString(36).slice(2, 8)}`
const slash = shallowRef<Slash | null>(null)
const slashAt = shallowRef({ left: 0, top: 0, bottom: 0 })
const active = ref(0)
const found = computed(() => (slash.value ? findBlocks(slash.value.query) : []))

type Float = { kind: 'format'; on: Record<string, boolean> } | { kind: 'link'; href: string }
const float = shallowRef<Float | null>(null)
const floatEl = ref<HTMLElement | null>(null)
const floatStyle = ref<Record<string, string>>({})
const tableAt = shallowRef<Record<string, string> | null>(null)
/** The pointer is selecting: the bar waits for what will be selected. */
let selecting = false

function close() {
  float.value = null
  tableAt.value = null
  if (slash.value && editor.value) editor.value.view.dispatch(closeSlash(editor.value.state.tr))
}

function refresh() {
  const e = editor.value
  if (!e) return
  const { state, view } = e
  const { selection } = state
  const on = e.isEditable && view.hasFocus()

  const was = slash.value
  const next = on ? slashOf(state) : null
  const options = next ? findBlocks(next.query) : []
  slash.value = next && options.length ? next : null
  if (slash.value) {
    if (was?.query !== slash.value.query) active.value = 0
    place()
  }
  announce()

  const cell = cellDepth(selection.$from)
  const tableNode = on && cell ? view.nodeDOM(selection.$from.before(cell - 2)) : null
  if (tableNode instanceof HTMLElement && host.value) {
    const r = tableNode.getBoundingClientRect()
    const h = host.value.getBoundingClientRect()
    tableAt.value = { top: `${r.top - h.top - 12}px`, left: `${Math.min(r.right, h.right) - h.left - 24}px` }
  } else tableAt.value = null

  const isText = selection instanceof TextSelection || selection instanceof AllSelection
  if (!on || selecting || slash.value || linkEdit.value || !isText) float.value = null
  else if (!selection.empty && !e.isActive('codeBlock') && state.doc.textBetween(selection.from, selection.to).trim()) {
    float.value = { kind: 'format', on: Object.fromEntries(FORMATS.map(f => [f.mark, e.isActive(f.mark)])) }
  } else if (selection.empty && e.isActive('link')) float.value = { kind: 'link', href: String(e.getAttributes('link').href ?? '') }
  else float.value = null
  if (float.value) placeFloat()
}

function place() {
  const e = editor.value
  if (!e || !slash.value) return
  const c = e.view.coordsAtPos(slash.value.from)
  slashAt.value = { left: c.left, top: c.top, bottom: c.bottom }
}
/** Over the selection, and inside of what scrolls: so it never lies over a browser tab beside the planner. */
async function placeFloat() {
  await Promise.resolve()
  const e = editor.value
  const el = floatEl.value
  if (!e || !el || !float.value) return
  const { from, to } = e.state.selection
  const a = e.view.coordsAtPos(from)
  const z = e.view.coordsAtPos(to, -1)
  const bounds = (e.view.dom.closest('.pl-page__scroll') ?? e.view.dom).getBoundingClientRect()
  const { offsetWidth: w, offsetHeight: h } = el
  const left = Math.max(bounds.left + 4, Math.min(a.left, bounds.right - w - 16))
  const over = a.top - h - 6
  const top = over >= bounds.top + 2 ? over : z.bottom + 6
  const hidden = z.bottom < bounds.top || a.top > bounds.bottom || top + h > bounds.bottom
  floatStyle.value = { left: `${left}px`, top: `${top}px`, visibility: hidden ? 'hidden' : 'visible' }
}
watch(floatEl, () => void placeFloat(), { flush: 'post' })
function onScroll() {
  if (slash.value) place()
  if (float.value) void placeFloat()
}
function onDown(e: MouseEvent) {
  if (e.button === 0) selecting = true
}
function onUp() {
  if (!selecting) return
  selecting = false
  // After the click has set the selection.
  setTimeout(refresh)
}
onMounted(() => {
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onScroll)
  window.addEventListener('pointerup', onUp, true)
  window.addEventListener('pointercancel', onUp, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', onScroll)
  window.removeEventListener('pointerup', onUp, true)
  window.removeEventListener('pointercancel', onUp, true)
})

/** The menu for who cannot see it: the focus stays in the text. */
function announce() {
  const dom = editor.value?.view.dom
  if (!dom) return
  const block = slash.value ? found.value[active.value] : null
  const set = (name: string, value: string | null) => {
    if (value === null) dom.removeAttribute(name)
    else if (dom.getAttribute(name) !== value) dom.setAttribute(name, value)
  }
  set('aria-haspopup', block ? 'listbox' : null)
  set('aria-controls', block ? menuId : null)
  set('aria-activedescendant', block ? `${menuId}-${block.id}` : null)
}
watch(active, announce)

function slashKey(event: KeyboardEvent): boolean {
  const n = found.value.length
  if (!slash.value || !n) return false
  if (event.ctrlKey || event.metaKey || event.altKey) return false
  switch (event.key) {
    case 'ArrowDown': active.value = (active.value + 1) % n; break
    case 'ArrowUp': active.value = (active.value - 1 + n) % n; break
    case 'Enter':
    case 'Tab': pick(found.value[active.value]!); break
    case 'Escape': closeMenu(); break
    default: return false
  }
  event.stopPropagation()
  return true
}
function closeMenu() {
  const e = editor.value
  if (e) e.view.dispatch(closeSlash(e.state.tr))
}
function pick(block: BlockKind) {
  const e = editor.value
  const s = slash.value
  if (!e || !s) return
  e.view.dispatch(closeSlash(e.state.tr.delete(s.from, s.to)))
  setBlock(e, block.id)
}

const FORMATS = [
  { mark: 'bold', icon: 'bold', key: keyOf('B') },
  { mark: 'italic', icon: 'italic', key: keyOf('I') },
  { mark: 'strike', icon: 'strikethrough', key: isMac ? '⌘⇧S' : 'Ctrl+Shift+S' },
  { mark: 'code', icon: 'code', key: keyOf('E') },
  { mark: 'link', icon: 'link', key: keyOf('K') },
] as const
function format(mark: (typeof FORMATS)[number]['mark']) {
  if (mark === 'link') editLink()
  else editor.value?.chain().focus().toggleMark(mark).run()
}

function tableMenu(event: MouseEvent) {
  const e = editor.value
  if (!e) return
  const does = (run: (c: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => () => { run(e.chain().focus()).run() }
  const { $from } = e.state.selection
  const header = $from.node(cellDepth($from)).type.name === 'tableHeader'
  void mango.ui.contextMenu(event.currentTarget as HTMLElement, [
    // The first row is the header's: none goes above it.
    { label: strings.rowAbove, icon: 'arrow-up', disabled: header, onSelect: does(c => c.addRowBefore()) },
    { label: strings.rowBelow, icon: 'arrow-down', onSelect: does(c => c.addRowAfter()) },
    { label: strings.columnLeft, icon: 'arrow-left', onSelect: does(c => c.addColumnBefore()) },
    { label: strings.columnRight, icon: 'arrow-right', onSelect: does(c => c.addColumnAfter()) },
    { label: strings.deleteRow, icon: 'trash-2', divider: true, disabled: header, onSelect: does(c => c.deleteRow()) },
    { label: strings.deleteColumn, icon: 'trash-2', onSelect: does(c => c.deleteColumn()) },
    { label: strings.deleteTable, icon: 'trash-2', danger: true, divider: true, onSelect: does(c => c.deleteTable()) },
  ])
}

defineExpose({
  edit: () => editor.value?.commands.focus('start'),
  focus: () => editor.value?.commands.focus(),
  /** What is typed and not given on yet. */
  commit() {
    const view = editor.value?.view as (Editor['view'] & { domObserver?: { flush(): void } }) | undefined
    if (view?.composing) view.domObserver?.flush()
    save()
  },
})
</script>

<template>
  <div class="pl-notes" @keydown.capture="onKeyState">
    <div ref="host" class="pl-notes__host" @mousedown="onDown" />
    <div v-if="tableAt" class="pl-notes__tools" :style="tableAt" @mousedown.prevent>
      <component :is="IconButton" size="sm" :label="strings.tableMenu" aria-haspopup="menu" @click="tableMenu"><Icon name="ellipsis" /></component>
    </div>
    <Teleport to="body">
      <div
        v-if="float"
        ref="floatEl"
        class="pl-float"
        :style="floatStyle"
        role="toolbar"
        :aria-label="float.kind === 'format' ? strings.format : strings.link"
        @mousedown.prevent
      >
        <template v-if="float.kind === 'format'">
          <component
            :is="IconButton"
            v-for="f in FORMATS"
            :key="f.mark"
            :label="strings[f.mark]"
            :shortcut="f.key"
            :active="float.on[f.mark]"
            tabindex="-1"
            @click="format(f.mark)"
          ><Icon :name="f.icon" /></component>
        </template>
        <template v-else>
          <button v-if="openable(float.href)" type="button" class="pl-float__open" tabindex="-1" :title="strings.openLink" @click="open(float.href)">
            <span>{{ float.href }}</span><Icon name="external-link" />
          </button>
          <span v-else class="pl-float__open is-text"><span>{{ float.href }}</span></span>
          <component :is="IconButton" :label="strings.editLink" :shortcut="keyOf('K')" tabindex="-1" @click="editLink"><Icon name="pencil" /></component>
          <component :is="IconButton" :label="strings.removeLink" tabindex="-1" @click="removeLink"><Icon name="unlink" /></component>
        </template>
      </div>
    </Teleport>
    <SlashMenu v-if="slash" :id="menuId" :blocks="found" :active="active" :at="slashAt" @pick="pick" @hover="active = $event" @close="closeMenu" />
    <LinkPopover v-if="linkEdit" :href="linkEdit.href" :anchor="linkEdit.anchor" @close="linkEdit = null" @save="saveLink" @remove="removeLink" />
  </div>
</template>

<style scoped>
.pl-notes { position: relative; display: flex; flex-direction: column; flex: 1; min-width: 0; }
.pl-notes__host { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.pl-notes__tools { position: absolute; z-index: 1; background: var(--bg-raised); border: 1px solid var(--line); border-radius: var(--radius-xs); }

/* The text: as Mango shows Markdown everywhere. */
.pl-notes :deep(.pl-notes__text) {
  flex: 1;
  min-width: 0;
  max-width: 72ch;
  min-height: 140px;
  padding: 0 var(--space-2) var(--space-6);
  font-size: var(--text-md);
  line-height: var(--leading-chat);
  color: var(--fg);
  white-space: pre-wrap;
  white-space: break-spaces;
  overflow-wrap: anywhere;
  font-variant-ligatures: none;
  tab-size: 2;
  cursor: text;
  user-select: text;
  -webkit-user-select: text;
}
/* The caret shows where one is. */
.pl-notes :deep(.pl-notes__text:focus-visible) { outline: none; }
.pl-notes :deep(.pl-notes__text > *:first-child) { margin-top: 0; }
.pl-notes :deep(p) { margin: 0 0 0.7em; }
.pl-notes :deep(p.is-editor-empty:first-child::before) { content: attr(data-placeholder); float: left; height: 0; color: var(--fg-faint); pointer-events: none; }
.pl-notes :deep(ul), .pl-notes :deep(ol) { margin: 0 0 0.8em; padding-left: 1.5em; }
.pl-notes :deep(ul) { list-style: disc; }
.pl-notes :deep(ol) { list-style: decimal; }
.pl-notes :deep(ul ul) { list-style: circle; }
.pl-notes :deep(li) { margin: 0.2em 0; }
.pl-notes :deep(li p) { margin: 0; }
.pl-notes :deep(li p + p) { margin-top: 0.4em; }
.pl-notes :deep(li ul), .pl-notes :deep(li ol) { margin: 0.2em 0 0; }
.pl-notes :deep(li::marker) { color: var(--fg-faint); }
.pl-notes :deep(.pl-notes__todo) { position: relative; list-style: none; }
.pl-notes :deep(.pl-notes__box) { position: absolute; left: -1.5em; top: 0; display: flex; align-items: center; height: calc(1em * var(--leading-chat)); user-select: none; }
.pl-notes :deep(.pl-notes__box input) { width: 14px; height: 14px; margin: 0; accent-color: var(--accent); cursor: pointer; }
.pl-notes :deep(.pl-notes__box input:disabled) { cursor: default; }
.pl-notes :deep(.pl-notes__todo.is-done > div > p:first-child) { color: var(--fg-subtle); text-decoration: line-through; text-decoration-color: var(--fg-faint); }
.pl-notes :deep(h1), .pl-notes :deep(h2), .pl-notes :deep(h3), .pl-notes :deep(h4), .pl-notes :deep(h5), .pl-notes :deep(h6) { margin: 1.1em 0 0.4em; font-weight: 640; letter-spacing: -0.01em; line-height: 1.35; text-wrap: pretty; }
.pl-notes :deep(h1) { font-size: 1.4em; }
.pl-notes :deep(h2) { font-size: 1.22em; }
.pl-notes :deep(h3) { font-size: var(--text-lg); }
.pl-notes :deep(h4), .pl-notes :deep(h5), .pl-notes :deep(h6) { font-size: var(--text-md); }
.pl-notes :deep(strong) { font-weight: 640; }
.pl-notes :deep(code) { font-family: var(--font-mono); font-size: 0.88em; padding: 0.1em 0.38em; border-radius: var(--radius-xs); background: var(--bg-hover); border: 1px solid var(--line-soft); }
.pl-notes :deep(pre) { margin: 0 0 0.8em; padding: var(--space-3) var(--space-4); overflow-x: auto; background: var(--bg-inset); border: 1px solid var(--line-soft); border-radius: var(--radius-md); font-size: var(--text-sm); line-height: 1.55; white-space: pre; }
.pl-notes :deep(pre code) { padding: 0; border: 0; background: none; font-size: inherit; white-space: pre; }
.pl-notes :deep(blockquote) { margin: 0 0 0.8em; padding-left: var(--space-3); border-left: 1px solid var(--line-strong); color: var(--fg-muted); }
.pl-notes :deep(blockquote > *:last-child) { margin-bottom: 0; }
.pl-notes :deep(a) { color: var(--accent-ink); text-decoration: underline; text-underline-offset: 2px; cursor: text; }
.pl-notes :deep([contenteditable='false'] a) { cursor: pointer; }
.pl-notes :deep(hr) { height: 1px; margin: 1.2em 0; border: 0; background: var(--line-soft); background-clip: content-box; padding: 6px 0; box-sizing: content-box; }
.pl-notes :deep(hr.ProseMirror-selectednode) { background-color: var(--accent); }
.pl-notes :deep(.pl-notes__table) { margin: 0 0 0.8em; overflow-x: auto; }
.pl-notes :deep(table) { border-collapse: collapse; font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
.pl-notes :deep(th), .pl-notes :deep(td) { position: relative; min-width: 72px; padding: 4px 10px; border-bottom: 1px solid var(--line-soft); text-align: left; vertical-align: top; }
.pl-notes :deep(th) { color: var(--fg-muted); font-weight: 600; }
.pl-notes :deep(td p), .pl-notes :deep(th p) { margin: 0; }
.pl-notes :deep(.selectedCell) { background: var(--accent-soft); }
/* A picture is its name: nothing is fetched for it. */
.pl-notes :deep(.pl-notes__image) { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 0 6px; border: 1px solid var(--line-soft); border-radius: var(--radius-xs); background: var(--bg-inset); color: var(--fg-muted); font-size: 0.88em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; }
.pl-notes :deep(.pl-notes__image::before) {
  content: '';
  flex: none;
  width: 13px;
  height: 13px;
  background: currentcolor;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect width='18' height='18' x='3' y='3' rx='2'/%3E%3Ccircle cx='9' cy='9' r='2'/%3E%3Cpath d='m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21'/%3E%3C/svg%3E") center / contain no-repeat;
}
.pl-notes :deep(.ProseMirror-selectednode:not(hr)) { border-radius: var(--radius-xs); outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.pl-notes :deep(.ProseMirror-separator) { display: inline; width: 0; height: 0; margin: 0; padding: 0; }
.pl-notes :deep(.ProseMirror-hideselection) { caret-color: transparent; }
.pl-notes :deep(.ProseMirror-gapcursor) { display: none; pointer-events: none; position: absolute; margin: 0; }
.pl-notes :deep(.ProseMirror-gapcursor::after) { content: ''; display: block; position: absolute; top: -2px; width: 20px; border-top: 1px solid var(--fg); }
.pl-notes :deep(.ProseMirror-focused .ProseMirror-gapcursor) { display: block; }

.pl-float {
  position: fixed;
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 2px;
  max-width: 320px;
  padding: 2px;
  background: var(--bg-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  animation: pl-float-in var(--dur-fast) var(--ease-out);
}
.pl-float__open { display: flex; align-items: center; gap: 6px; min-width: 0; height: 28px; padding: 0 var(--space-2); border-radius: var(--radius-sm); font-size: var(--text-sm); color: var(--accent-ink); }
.pl-float__open span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-float__open svg { flex: none; width: 13px; height: 13px; }
button.pl-float__open:hover { background: var(--bg-hover); }
.pl-float__open.is-text { color: var(--fg-muted); }
@keyframes pl-float-in { from { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .pl-float { animation: none; } }
</style>
<style>
/* Where a dragged piece goes: put outside of the editor's own element. */
.pl-notes__drop { background: var(--accent); }
</style>
