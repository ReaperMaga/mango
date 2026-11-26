<script setup lang="ts">
import { File, Folder } from 'lucide-vue-next'
import { fileLook } from '~/plugin-host/fileHooks'
import { pathIn, stemEnd } from '~/utils/fileOps'

/**
 * A name being typed in the Files tree, for a new entry or a rename. Enter or leaving the field
 * takes the name, Escape leaves it as it was. An error shows under it and the field stays.
 */
const props = defineProps<{
  /** The name to start from; empty for a new entry. */
  initial: string
  isDir: boolean
  /** The project and the folder the name is in. */
  project: string
  dir: string
  depth: number
  /** The folders that share the row before the name (compact folders), with their trailing slash. */
  prefix: string
  label: string
  error: string | null
  busy: boolean
}>()
const emit = defineEmits<{
  commit: [name: string, left: boolean]
  cancel: [left: boolean]
  edit: []
}>()

const value = ref(props.initial)
const input = ref<HTMLInputElement | null>(null)
const errorId = useId()

const icon = computed(() => {
  const name = value.value
  if (!name) return props.isDir ? Folder : File
  const look = fileLook({ projectPath: props.project, path: pathIn(props.dir, name), name, isDir: props.isDir, open: false })
  return look.icon ?? Folder
})

onMounted(() => nextTick(() => {
  const el = input.value
  if (!el) return
  el.focus({ preventScroll: true })
  el.setSelectionRange(0, stemEnd(props.initial, props.isDir))
  el.scrollIntoView({ block: 'nearest' })
}))
watch(() => props.error, (error) => {
  if (error) nextTick(() => input.value?.focus())
})

function take(left: boolean) {
  if (props.busy) return
  if (value.value === props.initial || (left && !value.value.trim())) {
    // An untouched field is taken as it was; an empty one from Enter still says what is missing.
    if (left || props.initial) return emit('cancel', left)
  }
  emit('commit', value.value.trim(), left)
}

function onKey(e: KeyboardEvent) {
  // The tree's keys (arrows, Space, Delete, F2) are the field's own while typing.
  e.stopPropagation()
  if (e.isComposing) return
  if (e.key === 'Enter') {
    e.preventDefault()
    take(false)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    if (!props.busy) emit('cancel', false)
  }
}

function onBlur() {
  // Switching windows is not leaving the field, and neither is the row going away.
  if (!document.hasFocus() || !input.value?.isConnected) return
  take(true)
}
</script>

<template>
  <div class="fnr" :style="{ '--depth': depth }" role="none" @click.stop @contextmenu.stop>
    <div class="fnr__line" :class="{ 'has-error': !!error }">
      <component :is="icon" class="fnr__icon" aria-hidden="true" />
      <span v-if="prefix" class="fnr__prefix">{{ prefix }}</span>
      <input
        ref="input"
        v-model="value"
        class="fnr__input"
        :aria-label="label"
        :aria-invalid="!!error || undefined"
        :aria-describedby="error ? errorId : undefined"
        :aria-busy="busy || undefined"
        :readonly="busy"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        @input="emit('edit')"
        @keydown="onKey"
        @blur="onBlur"
      >
    </div>
    <p v-if="error" :id="errorId" class="fnr__error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.fnr { padding-left: calc(4px + var(--depth) * 14px + 18px); padding-right: 6px; }
.fnr__line { display: flex; align-items: center; gap: 5px; height: 26px; }
.fnr__icon { flex: none; width: 14px; height: 14px; stroke-width: 1.75; color: var(--fg-subtle); }
.fnr__prefix { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); color: var(--fg-muted); }
.fnr__input {
  flex: 1 0 80px;
  min-width: 0;
  height: 22px;
  margin-left: -4px;
  padding: 0 3px;
  background: var(--bg-inset);
  border: 1px solid var(--accent-line);
  border-radius: var(--radius-xs);
  color: var(--fg);
  font-size: var(--text-sm);
}
.fnr__input:focus-visible { outline: none; }
.fnr__input[readonly] { color: var(--fg-subtle); }
.has-error .fnr__input { border-color: color-mix(in oklch, var(--ripe-error) 60%, transparent); }
.fnr__error {
  margin: 0;
  padding: 2px 0 var(--space-1) 15px;
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
  color: var(--ripe-error-fg);
  overflow-wrap: anywhere;
}
</style>
