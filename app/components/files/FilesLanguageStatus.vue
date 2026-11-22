<script setup lang="ts">
import { RotateCw } from 'lucide-vue-next'
import type { LspServer } from '~/types/ipc'
import { useLanguageServers } from '~/lsp/store'
import { languageService } from '~/lsp/service'

/**
 * How the file's language server is doing, in the editor's header, while one is there to speak of.
 * Work that is over in a moment (a check after each save) is not worth a word.
 */
const props = defineProps<{ server: LspServer; root: string }>()

const BUSY_MS = 800

const store = useLanguageServers()
const view = computed(() => store.session(props.server.id, props.root))

const working = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
watch(() => !!view.value?.busy, (busy) => {
  clearTimeout(timer)
  if (busy) timer = setTimeout(() => (working.value = true), BUSY_MS)
  else working.value = false
}, { immediate: true })
onBeforeUnmount(() => clearTimeout(timer))

const label = computed(() => {
  const v = view.value
  if (!v || v.state === 'stopped') return ''
  const { name } = props.server
  if (v.state === 'starting') return `Starting ${name}…`
  if (v.state === 'restarting') return `Restarting ${name}…`
  // The reason names the server itself.
  if (v.state === 'failed') return v.error || `${name} failed`
  return working.value && v.busy ? `${name}: ${v.busy}` : name
})
/** Progress counts up by itself: only the state is announced. */
const announced = computed(() => {
  const state = view.value?.state
  if (!state || state === 'stopped') return ''
  if (state === 'ready') return `${props.server.name} is running`
  return label.value
})
const hint = computed(() => view.value?.error ?? (view.value?.busy ? label.value : `${props.server.name} is running`))

function retry() {
  languageService()?.retry({ server: props.server.id, root: props.root })
}
</script>

<template>
  <span v-if="label" class="fls" :class="`is-${view?.state}`" :title="hint">
    <span class="fls__text" aria-hidden="true">{{ label }}</span>
    <span class="sr-only" role="status">{{ announced }}</span>
    <UiIconButton v-if="view?.state === 'failed'" size="sm" :label="`Start ${server.name} again`" @click="retry"><RotateCw /></UiIconButton>
  </span>
</template>

<style scoped>
.fls {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  flex: 0 1 auto;
  min-width: 0;
  font-size: var(--text-xs);
  color: var(--fg-subtle);
}
.fls.is-failed { color: var(--ripe-error-fg); }
.fls__text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
</style>
