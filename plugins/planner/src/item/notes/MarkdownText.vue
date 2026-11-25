<script setup lang="ts">
import { ref } from 'vue'
import { usePlanner } from '../../context.ts'
import { link, onEnter, onTab, wrap, type Edit } from '../markdownEdit.ts'
import { strings } from '../strings.ts'

/** The Markdown as text. */
const props = defineProps<{ body: string; readonly: boolean; describedBy?: string }>()
const emit = defineEmits<{ change: [body: string]; blur: []; leave: [] }>()
const { mango } = usePlanner()
const isMac = mango.platform === 'macos' || /Mac/.test(navigator.platform)

const area = ref<HTMLTextAreaElement | null>(null)
const save = (body: string) => emit('change', body)

function focusAt(pos: number | null) {
  const el = area.value
  if (!el) return
  el.focus({ preventScroll: true })
  if (pos !== null) el.setSelectionRange(pos, pos)
  el.scrollIntoView({ block: 'nearest' })
}

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

const MARKS: Record<string, string> = { b: '**', i: '*', e: '`' }
function onKey(e: KeyboardEvent) {
  const el = area.value
  if (!el || e.isComposing) return
  const { value: text, selectionStart: s, selectionEnd: end } = el
  const isMod = isMac ? e.metaKey : e.ctrlKey
  if (isMod) {
    if (e.altKey || e.shiftKey) return
    const key = e.key.toLowerCase()
    if (key === 'enter') {
      e.preventDefault()
      emit('leave')
    } else if (!props.readonly && (key === 'k' || key in MARKS)) {
      e.preventDefault()
      e.stopPropagation()
      apply(key === 'k' ? link(text, s, end) : wrap(text, s, end, MARKS[key]!))
    }
  } else if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    emit('leave')
  } else if (!props.readonly && e.key === 'Enter' && !e.shiftKey && !e.altKey) {
    if (apply(onEnter(text, s, end))) e.preventDefault()
  } else if (!props.readonly && e.key === 'Tab' && !e.altKey) {
    if (apply(onTab(text, s, end, e.shiftKey))) e.preventDefault()
    // Shift+Tab with nothing to outdent goes back to the properties, as it does anywhere.
  }
}

defineExpose({
  edit: () => focusAt(0),
  focus: () => focusAt(null),
  commit() {
    if (area.value && area.value.value !== props.body) save(area.value.value)
  },
})
</script>

<template>
  <div class="pl-md" :data-text="`${body} `">
    <textarea
      ref="area"
      :value="body"
      rows="1"
      :readonly="readonly"
      :aria-label="strings.bodyMarkdown"
      :aria-describedby="describedBy"
      :placeholder="strings.markdownPlaceholder"
      data-own-keys="Mod+B Mod+I Mod+E Mod+K"
      spellcheck="false"
      @input="save(($event.target as HTMLTextAreaElement).value)"
      @keydown="onKey"
      @blur="emit('blur')"
    />
  </div>
</template>

<style scoped>
.pl-md { display: grid; flex: 1; align-content: start; }
.pl-md > textarea, .pl-md::after {
  grid-area: 1 / 1;
  width: 100%;
  min-height: 140px;
  padding: 0 var(--space-2) var(--space-6);
  border: 0;
  background: none;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: var(--leading-chat);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
}
.pl-md::after { content: attr(data-text); visibility: hidden; }
.pl-md > textarea { resize: none; overflow: hidden; }
.pl-md > textarea::placeholder { color: var(--fg-faint); }
/* The caret shows that it is being edited. */
.pl-md > textarea:focus-visible { outline: none; }
</style>
