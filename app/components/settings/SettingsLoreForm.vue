<script setup lang="ts">
import type { LoreServer } from '~/types/ipc'
import { loreServerProblem, normalizeLoreServer } from '~/utils/lore'

/**
 * A Lore server's name and address, for adding one (Settings > Lore) or changing it in its row. Checks
 * the address as it is typed the way the backend does; the backend's own refusal comes in as `error`.
 */
const props = defineProps<{
  /** The entry being changed; null to add one. */
  server: LoreServer | null
  /** All saved servers, to catch a second entry for one address. */
  list: LoreServer[]
  saving: boolean
  /** What the backend said when saving failed. */
  error: string | null
}>()
const emit = defineEmits<{ save: [name: string, url: string]; cancel: []; edit: [] }>()

const { t } = useI18n()
const name = ref(props.server?.name ?? '')
const url = ref(props.server?.url ?? '')
const touched = ref(false)
const nameId = useId()
const urlId = useId()
const hintId = useId()
const urlInput = ref<HTMLInputElement | null>(null)

const problem = computed(() => loreServerProblem(url.value, props.list, props.server?.id ?? null))
const shown = computed(() => props.error ?? (touched.value ? problem.value : null))

function submit() {
  touched.value = true
  if (problem.value) {
    urlInput.value?.focus()
    return
  }
  emit('save', name.value.trim(), normalizeLoreServer(url.value)!)
}

/** After a save that added one: empty again. */
function reset() {
  name.value = ''
  url.value = ''
  touched.value = false
}
defineExpose({ reset, focus: () => urlInput.value?.focus() })
</script>

<template>
  <form class="lf" novalidate @submit.prevent="submit" @keydown.esc="server && emit('cancel')">
    <div class="lf__fields">
      <span class="lf__field lf__field--name">
        <label class="lf__label" :for="nameId">{{ t('lore.servers.name') }}</label>
        <input
          :id="nameId"
          v-model="name"
          class="lf__input"
          type="text"
          spellcheck="false"
          autocomplete="off"
          maxlength="80"
          :placeholder="t('lore.servers.namePlaceholder')"
          @input="emit('edit')"
        >
      </span>
      <span class="lf__field lf__field--url">
        <label class="lf__label" :for="urlId">{{ t('lore.servers.url') }}</label>
        <input
          :id="urlId"
          ref="urlInput"
          v-model="url"
          class="lf__input lf__input--mono"
          :class="{ 'has-error': !!shown }"
          type="text"
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
          placeholder="lore://lore.example.com"
          :aria-describedby="hintId"
          :aria-invalid="!!shown || undefined"
          @input="emit('edit')"
          @blur="url && (touched = true)"
        >
      </span>
      <span class="lf__actions">
        <UiButton size="sm" type="submit" :loading="saving">{{ server ? t('lore.servers.save') : t('lore.servers.addAction') }}</UiButton>
        <UiButton v-if="server" size="sm" variant="ghost" @click="emit('cancel')">{{ t('common.actions.cancel') }}</UiButton>
      </span>
    </div>
    <p v-if="shown" :id="hintId" class="lf__hint lf__hint--error selectable" role="alert">{{ shown }}</p>
    <p v-else :id="hintId" class="lf__hint">{{ t('lore.servers.urlHint') }}</p>
  </form>
</template>

<style scoped>
.lf { display: grid; gap: 6px; }
.lf__fields { display: flex; align-items: flex-end; gap: var(--space-2); min-width: 0; }
.lf__field { display: grid; gap: 6px; min-width: 0; }
.lf__field--name { flex: 0 1 160px; }
.lf__field--url { flex: 1 1 260px; }
.lf__label { font-size: var(--text-xs); font-weight: 560; color: var(--fg-muted); }
.lf__input {
  height: 32px;
  min-width: 0;
  padding: 0 var(--space-3);
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.lf__input--mono { font-family: var(--font-mono); font-size: var(--text-xs); }
.lf__input::placeholder { color: var(--fg-faint); }
.lf__input:focus-visible { outline: none; }
.lf__input:focus { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.lf__input.has-error { border-color: color-mix(in oklch, var(--ripe-error) 60%, transparent); }
.lf__actions { flex: none; display: inline-flex; align-items: center; gap: var(--space-1); height: 32px; }
.lf__hint { margin: 0; font-size: var(--text-xs); color: var(--fg-subtle); line-height: var(--leading-tight); text-wrap: pretty; }
.lf__hint--error { color: var(--ripe-error-fg); }
</style>
