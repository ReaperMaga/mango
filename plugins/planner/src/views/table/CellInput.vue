<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'

/** The text of a cell while it is edited, in place. */
const props = defineProps<{ text: string; label: string; multiline: boolean; numeric: boolean; selectAll: boolean }>()
const emit = defineEmits<{ commit: [text: string, then: 'down' | 'right' | 'left' | 'stay' | 'blur']; cancel: [] }>()

const el = ref<HTMLInputElement | HTMLTextAreaElement | null>(null)
const start = props.multiline ? props.text : props.text.replace(/\s*\n\s*/g, ' ')
let over = false

function fit() {
  const box = el.value
  if (!props.multiline || !box) return
  box.style.height = 'auto'
  box.style.height = `${Math.min(Math.max(box.scrollHeight + 2, 33), 180)}px`
}
onMounted(async () => {
  await nextTick()
  const box = el.value
  if (!box) return
  box.focus({ preventScroll: true })
  if (props.selectAll) box.select()
  else box.setSelectionRange(box.value.length, box.value.length)
  fit()
})

function commit(then: 'down' | 'right' | 'left' | 'stay' | 'blur') {
  if (over) return
  over = true
  // Text that was not touched stays as it is stored, however it is shown here.
  const text = el.value?.value ?? start
  emit('commit', text === start ? props.text : text, then)
}
function onKey(e: KeyboardEvent) {
  if (e.isComposing) return
  if (['Enter', 'Tab', 'Escape'].includes(e.key)) e.stopPropagation()
  if (e.key === 'Enter' && props.multiline && (e.altKey || e.shiftKey)) {
    e.preventDefault()
    const box = el.value!
    box.setRangeText('\n', box.selectionStart ?? 0, box.selectionEnd ?? 0, 'end')
    fit()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    commit(e.ctrlKey || e.metaKey ? 'stay' : 'down')
  } else if (e.key === 'Tab') {
    e.preventDefault()
    commit(e.shiftKey ? 'left' : 'right')
  } else if (e.key === 'Escape') {
    e.preventDefault()
    over = true
    emit('cancel')
  }
}
</script>

<template>
  <component
    :is="multiline ? 'textarea' : 'input'"
    ref="el"
    class="pl-cell-input"
    :class="{ 'is-numeric': numeric }"
    :value="start"
    :aria-label="label"
    :inputmode="numeric ? 'decimal' : undefined"
    :rows="multiline ? 1 : undefined"
    spellcheck="false"
    autocomplete="off"
    @input="fit"
    @keydown="onKey"
    @blur="commit('blur')"
    @mousedown.stop
    @dblclick.stop
    @copy.stop
    @cut.stop
    @paste.stop
    @contextmenu.stop
  />
</template>

<style scoped>
.pl-cell-input {
  position: absolute;
  z-index: 4;
  inset: -1px 0 auto -1px;
  width: calc(100% + 1px);
  min-width: 160px;
  height: 33px;
  margin: 0;
  padding: 0 var(--space-2);
  border: 1px solid var(--accent-line);
  border-radius: var(--radius-xs);
  background: var(--bg-inset);
  box-shadow: 0 0 0 3px var(--accent-soft);
  color: var(--fg);
  font-size: var(--text-sm);
  line-height: 20px;
  resize: none;
}
textarea.pl-cell-input { padding-block: 5px; overflow-y: auto; scrollbar-width: thin; }
.pl-cell-input.is-numeric { text-align: right; font-variant-numeric: tabular-nums; }
.pl-cell-input:focus-visible { outline: none; }
</style>
