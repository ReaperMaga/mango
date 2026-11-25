<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { usePlanner } from '../context.ts'
import type { Collection, Item } from '../model.ts'
import Icon from '../ui/Icon.vue'
import { link, onEnter, onTab, taskMarks, toggleList, toggleTask, wrap, type Edit } from './markdownEdit.ts'
import { onCommit } from '../values/onCommit.ts'
import { strings } from './strings.ts'

/** An item's notes: rendered Markdown, or its text while it is edited. */
const props = defineProps<{ collection: Collection; item: Item; readonly: boolean }>()
const { mango, store } = usePlanner()
const { Markdown, IconButton } = mango.ui.components

const editing = ref(false)
const area = ref<HTMLTextAreaElement | null>(null)
const view = ref<HTMLElement | null>(null)
const isMac = mango.platform === 'macos' || /Mac/.test(navigator.platform)
const mod = isMac ? '⌘' : 'Ctrl+'

const base = computed(() => (props.collection.scope.kind === 'project' ? props.collection.scope.path : store.projectPath.value))

function save(body: string) {
  store.updateItem(props.collection.id, props.item.id, { body }, { defer: true })
}

onCommit(() => {
  if (editing.value && area.value && area.value.value !== props.item.body) save(area.value.value)
})

async function edit(at: number | null = null) {
  if (props.readonly) return
  editing.value = true
  await nextTick()
  const el = area.value
  if (!el) return
  const pos = at ?? el.value.length
  el.focus({ preventScroll: at !== null })
  el.setSelectionRange(pos, pos)
  el.scrollIntoView({ block: 'nearest' })
}
async function leave(refocus = false) {
  if (!editing.value) return
  editing.value = false
  void store.flush()
  if (!refocus) return
  await nextTick()
  view.value?.focus({ preventScroll: true })
}
/** Not when the whole window lost the focus: it comes back where it was. */
function onBlur(e: FocusEvent) {
  if (!document.hasFocus() || (e.relatedTarget as HTMLElement | null)?.closest('.pl-body__bar')) return
  void leave()
}

/* ---------- editing */

function apply(e: Edit | null): boolean {
  const el = area.value
  if (!el || !e) return false
  el.focus()
  el.setSelectionRange(e.from, e.to)
  // Keeps the field's own undo; not everywhere there is.
  const done = e.insert || e.from !== e.to ? document.execCommand(e.insert ? 'insertText' : 'delete', false, e.insert) : true
  if (!done) {
    el.setRangeText(e.insert, e.from, e.to, 'end')
    save(el.value)
  }
  el.setSelectionRange(e.start, e.end)
  return true
}
type Format = 'bold' | 'italic' | 'code' | 'link' | 'list' | 'tasks'
function format(kind: Format) {
  const el = area.value
  if (!el) return
  const { value: text, selectionStart: s, selectionEnd: e } = el
  switch (kind) {
    case 'bold': return apply(wrap(text, s, e, '**'))
    case 'italic': return apply(wrap(text, s, e, '*'))
    case 'code': return apply(wrap(text, s, e, '`'))
    case 'link': return apply(link(text, s, e))
    default: return apply(toggleList(text, s, e, kind === 'list' ? 'bullet' : 'task'))
  }
}
const FORMATS: ReadonlyArray<{ kind: Format; icon: string; shortcut?: string }> = [
  { kind: 'bold', icon: 'bold' },
  { kind: 'italic', icon: 'italic', shortcut: `${mod}I` },
  { kind: 'code', icon: 'code' },
  { kind: 'link', icon: 'link' },
  { kind: 'list', icon: 'list' },
  { kind: 'tasks', icon: 'list-checks' },
]

function onKey(e: KeyboardEvent) {
  const el = area.value
  if (!el || e.isComposing) return
  const { value: text, selectionStart: s, selectionEnd: end } = el
  const isMod = isMac ? e.metaKey : e.ctrlKey
  if (isMod && !e.altKey && !e.shiftKey) {
    // Mango's own keys (the sidebar, the palette) come first where they are bound to these.
    const kind = ({ b: 'bold', i: 'italic', k: 'link', e: 'code' } as Record<string, Format>)[e.key.toLowerCase()]
    if (kind) {
      e.preventDefault()
      e.stopPropagation()
      format(kind)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void leave(true)
    }
    return
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    void leave(true)
  } else if (e.key === 'Enter' && !e.shiftKey && !isMod && !e.altKey) {
    if (apply(onEnter(text, s, end))) e.preventDefault()
  } else if (e.key === 'Tab' && !isMod && !e.altKey) {
    if (apply(onTab(text, s, end, e.shiftKey))) e.preventDefault()
    // Shift+Tab with nothing to outdent goes back to the properties, as it does anywhere.
  }
}

/* ---------- rendered */

/**
 * Where in the text a click on the rendered notes was: the same piece of text, as many times in. The end when
 * it cannot be told.
 */
function sourceAt(x: number, y: number): number | null {
  const doc = document as Document & { caretRangeFromPoint?(x: number, y: number): Range | null }
  const pos = document.caretPositionFromPoint?.(x, y)
  const range = pos ? null : doc.caretRangeFromPoint?.(x, y)
  const node = pos?.offsetNode ?? range?.startContainer
  const offset = pos?.offset ?? range?.startOffset ?? 0
  if (!(node instanceof Text) || !view.value?.contains(node) || !node.data.trim()) return null
  let nth = 0
  const walker = document.createTreeWalker(view.value, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n && n !== node; n = walker.nextNode()) {
    nth += (n as Text).data.split(node.data).length - 1
  }
  let at = props.item.body.indexOf(node.data)
  while (nth-- > 0 && at >= 0) at = props.item.body.indexOf(node.data, at + node.data.length)
  return at < 0 ? null : at + offset
}
function onViewClick(e: MouseEvent) {
  if (e.defaultPrevented || (e.target as HTMLElement).closest('a, button, input, [data-plugin-block]')) return
  // Text was selected to copy it.
  if (!(getSelection()?.isCollapsed ?? true)) return
  void edit(sourceAt(e.clientX, e.clientY))
}
function onViewKey(e: KeyboardEvent) {
  if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey || e.key !== 'Enter') return
  e.preventDefault()
  void edit()
}

/* The task boxes the renderer draws are only for show: enabled when each is one of the text's. */
let pendingFocus: number | null = null
function boxes(): HTMLInputElement[] {
  return [...(view.value?.querySelectorAll<HTMLInputElement>('li input[type="checkbox"]') ?? [])]
}
function wireBoxes() {
  if (props.readonly) return
  const all = boxes()
  if (!all.length || all.length !== taskMarks(props.item.body).length) return
  for (const b of all) {
    b.disabled = false
    b.setAttribute('aria-label', b.closest('li')?.innerText.split('\n')[0]?.trim() || strings.tasks)
  }
  if (pendingFocus !== null) {
    all[pendingFocus]?.focus({ preventScroll: true })
    pendingFocus = null
  }
}
function onViewChange(e: Event) {
  const all = boxes()
  const i = all.indexOf(e.target as HTMLInputElement)
  if (i < 0) return
  if (document.activeElement === e.target) pendingFocus = i
  store.updateItem(props.collection.id, props.item.id, { body: toggleTask(props.item.body, i) })
}
const observer = new MutationObserver(wireBoxes)
watch(view, (el) => {
  observer.disconnect()
  if (!el) return
  observer.observe(el, { childList: true, subtree: true })
  wireBoxes()
}, { flush: 'post' })
onMounted(() => {
  if (view.value) {
    observer.observe(view.value, { childList: true, subtree: true })
    wireBoxes()
  }
})
onBeforeUnmount(() => {
  observer.disconnect()
  if (editing.value) void store.flush()
})
watch(() => props.readonly, (v) => { if (v) void leave() })

defineExpose({ edit: () => edit(0) })
</script>

<template>
  <section class="pl-body" :class="{ 'is-editing': editing }">
    <template v-if="editing">
      <div class="pl-body__bar" role="toolbar" :aria-label="strings.body">
        <component
          :is="IconButton"
          v-for="f in FORMATS"
          :key="f.kind"
          size="sm"
          :label="strings[f.kind]"
          :shortcut="f.shortcut"
          @pointerdown.prevent
          @mousedown.prevent
          @click="format(f.kind)"
        ><Icon :name="f.icon" /></component>
      </div>
      <div class="pl-body__grow" :data-text="`${item.body} `">
        <textarea
          ref="area"
          :value="item.body"
          rows="1"
          :aria-label="strings.body"
          :placeholder="strings.bodyPlaceholder"
          @input="save(($event.target as HTMLTextAreaElement).value)"
          @keydown="onKey"
          @blur="onBlur"
        />
      </div>
    </template>
    <div
      v-else
      ref="view"
      class="pl-body__view"
      :class="{ 'is-empty': !item.body.trim(), 'is-fixed': readonly }"
      :tabindex="readonly ? undefined : 0"
      role="group"
      :aria-label="readonly ? strings.body : strings.bodyEdit"
      @click="onViewClick"
      @keydown="onViewKey"
      @change="onViewChange"
    >
      <p v-if="!item.body.trim()" class="pl-body__hint">{{ readonly ? strings.empty : strings.bodyPlaceholder }}</p>
      <div v-else class="selectable"><component :is="Markdown" :text="item.body" :base="base" /></div>
    </div>
  </section>
</template>

<style scoped>
.pl-body { position: relative; display: flex; flex-direction: column; flex: 1; min-height: 160px; }
.pl-body__bar { position: sticky; top: 0; z-index: 1; display: flex; gap: 2px; padding: 0 0 4px; margin-top: -6px; background: var(--pl-page-bg, var(--bg-canvas)); }
.pl-body__view { flex: 1; padding: 20px var(--space-2) var(--space-6); border-radius: var(--radius-sm); cursor: text; }
.pl-body__view.is-fixed { cursor: default; }
.pl-body__view:focus-visible { outline-offset: -2px; border-radius: var(--radius-sm); }
.pl-body__view :deep(.md) { max-width: 72ch; }
.pl-body__view :deep(.selectable *) { cursor: text; }
.pl-body__view :deep(a), .pl-body__view :deep(button), .pl-body__view :deep(input) { cursor: pointer; }
/* Task lists: the box stands where the bullet would. */
.pl-body__view :deep(li:has(> input[type='checkbox'])), .pl-body__view :deep(li:has(> p > input[type='checkbox'])) { list-style: none; }
.pl-body__view :deep(input[type='checkbox']) { width: 14px; height: 14px; margin: 0 6px 0 -20px; vertical-align: -2px; accent-color: var(--accent); }
.pl-body__hint { margin: 0; color: var(--fg-faint); font-size: var(--text-md); line-height: var(--leading-chat); }
.pl-body__grow { display: grid; flex: 1; align-content: start; }
.pl-body__grow > textarea, .pl-body__grow::after {
  grid-area: 1 / 1;
  width: 100%;
  min-height: 140px;
  padding: 0 var(--space-2) var(--space-6);
  border: 0;
  background: none;
  font: inherit;
  font-size: var(--text-md);
  line-height: var(--leading-chat);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
}
.pl-body__grow::after { content: attr(data-text); visibility: hidden; }
.pl-body__grow > textarea { resize: none; overflow: hidden; }
.pl-body__grow > textarea::placeholder { color: var(--fg-faint); }
/* The caret and the bar show that it is being edited. */
.pl-body__grow > textarea:focus-visible { outline: none; }
</style>
