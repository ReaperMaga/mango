<script setup lang="ts">
import { onMounted, ref } from 'vue'

/** One line typed in place: Enter takes it and (unless `single`) stays for another, Escape leaves. */
const props = defineProps<{ label: string; placeholder: string; value?: string; single?: boolean; hint?: string }>()
const emit = defineEmits<{ add: [text: string]; close: [byKey: boolean] }>()

const text = ref(props.value ?? '')
const input = ref<HTMLInputElement>()
let done = false
onMounted(() => {
  input.value?.focus()
  input.value?.select()
})

function close(byKey: boolean) {
  if (done) return
  done = true
  emit('close', byKey)
}
function add(): boolean {
  const value = text.value.trim()
  if (!value) return false
  text.value = ''
  emit('add', value)
  return true
}
function onKey(e: KeyboardEvent) {
  if (e.isComposing) return
  // Mango's own shortcuts still work from here; the board's keys do not reach it.
  if (!e.ctrlKey && !e.metaKey && !e.altKey) e.stopPropagation()
  if (e.key === 'Enter') {
    e.preventDefault()
    if (!add() || props.single) close(true)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    text.value = ''
    close(true)
  }
}
function onBlur() {
  // Another window in front is no reason to stop typing here.
  if (done || !document.hasFocus()) return
  add()
  close(false)
}
</script>

<template>
  <input
    ref="input"
    v-model="text"
    class="pl-inline"
    type="text"
    spellcheck="true"
    autocomplete="off"
    :aria-label="label"
    :placeholder="placeholder"
    :title="hint"
    @keydown="onKey"
    @blur="onBlur"
  >
</template>

<style scoped>
.pl-inline {
  width: 100%;
  min-width: 0;
  height: 32px;
  padding: 0 9px;
  border: 1px solid var(--accent-line);
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
  color: var(--fg);
  font-size: var(--text-sm);
}
.pl-inline:focus-visible { outline: none; border-radius: var(--radius-sm); box-shadow: 0 0 0 3px var(--accent-soft); }
.pl-inline::placeholder { color: var(--fg-faint); }
</style>
