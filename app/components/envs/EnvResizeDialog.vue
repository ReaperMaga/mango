<script setup lang="ts">
import { CircleAlert } from 'lucide-vue-next'
import { useEnvironments } from '~/stores/environments'
import type { EnvInstance } from '~/types/ipc'

/**
 * Change an instance's CPUs, memory and root disk. Fields start at what it has
 * now; only what changed is sent. A disk only grows.
 */
const props = defineProps<{ open: boolean; hostId: string; instance: EnvInstance }>()
const emit = defineEmits<{ close: []; resized: [note: string | null] }>()

const { t } = useI18n()
const envs = useEnvironments()
const cpus = ref('')
const memory = ref('')
const disk = ref('')
const touched = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)

/** "8GiB" -> 8; anything not in whole GiB (e.g. "512MiB", "40GB") -> null. */
const gib = (s: string | null) => {
  const m = /^(\d+)\s*GiB$/i.exec(s?.trim() ?? '')
  return m ? Number(m[1]) : null
}
const now = computed(() => ({ cpus: props.instance.cpus, memory: gib(props.instance.memory), disk: gib(props.instance.disk) }))

watch(() => props.open, (o) => {
  if (!o) return
  cpus.value = now.value.cpus?.toString() ?? ''
  memory.value = now.value.memory?.toString() ?? ''
  disk.value = now.value.disk?.toString() ?? ''
  touched.value = false
  busy.value = false
  error.value = null
})

const num = (v: string) => (v.trim() ? Number(v.trim()) : null)
function rangeError(v: string, lo: number, hi: number) {
  if (!v.trim()) return null
  const n = num(v)!
  return Number.isInteger(n) && n >= lo && n <= hi ? null : t('envs.common.wholeNumber', { min: lo, max: hi })
}
const cpusError = computed(() => rangeError(cpus.value, 1, 64))
const memoryError = computed(() => rangeError(memory.value, 1, 512))
const diskError = computed(() => {
  const e = rangeError(disk.value, 4, 2048)
  if (e) return e
  const n = num(disk.value)
  return n !== null && now.value.disk !== null && n < now.value.disk ? t('envs.resize.diskGrows', { min: now.value.disk }) : null
})

/** What changed (null leaves it as it is). An emptied field is not a change: limits can't be removed here. */
const changes = computed(() => {
  const pick = (v: string, was: number | null) => {
    const n = num(v)
    return n !== null && n !== was ? n : null
  }
  return { cpus: pick(cpus.value, now.value.cpus), memoryGib: pick(memory.value, now.value.memory), diskGib: pick(disk.value, now.value.disk) }
})
const changed = computed(() => Object.values(changes.value).some(v => v !== null))
const invalid = computed(() => !!(cpusError.value || memoryError.value || diskError.value))

const vm = computed(() => props.instance.kind === 'vm')
const running = computed(() => props.instance.status === 'running')

async function submit() {
  touched.value = true
  if (invalid.value || !changed.value || busy.value) return
  busy.value = true
  error.value = null
  try {
    const note = await envs.resize(props.hostId, props.instance.name, changes.value)
    emit('resized', note)
  } catch (e) {
    error.value = (e instanceof Error ? e.message : String(e)).replace(/\.$/, '')
  } finally {
    busy.value = false
  }
}

function close() {
  if (!busy.value) emit('close')
}
</script>

<template>
  <UiDialog :open="open" :title="t('envs.resize.title', { name: instance.name })" :dismissible="!busy" @close="close">
    <form id="env-resize-form" class="rsz" novalidate @submit.prevent="submit">
      <div class="rsz__sizes">
        <UiField :label="t('envs.common.cpus')" for="rsz-cpus" :error="touched ? cpusError : null">
          <input id="rsz-cpus" v-model="cpus" class="input tabular" type="text" inputmode="numeric" :placeholder="t('envs.common.default')" autocomplete="off" :disabled="busy">
        </UiField>
        <UiField :label="t('envs.common.memoryGib')" for="rsz-mem" :error="touched ? memoryError : null">
          <input id="rsz-mem" v-model="memory" class="input tabular" type="text" inputmode="numeric" :placeholder="instance.memory ?? t('envs.common.default')" autocomplete="off" :disabled="busy">
        </UiField>
        <UiField :label="t('envs.common.diskGib')" for="rsz-disk" :error="touched ? diskError : null">
          <input id="rsz-disk" v-model="disk" class="input tabular" type="text" inputmode="numeric" :placeholder="instance.disk ?? t('envs.common.default')" autocomplete="off" :disabled="busy">
        </UiField>
      </div>
      <p class="rsz__lede">
        <template v-if="vm && running">
          {{ t('envs.resize.vmRunning') }}
        </template>
        <template v-else-if="vm">{{ t('envs.resize.vm') }}</template>
        <template v-else>{{ t('envs.resize.container') }}</template>
        {{ t('envs.resize.onlyGrows') }}
      </p>
      <p v-if="error" class="rsz__error" role="alert">
        <CircleAlert aria-hidden="true" />
        <span class="selectable">{{ t('envs.resize.failed', { error }) }}</span>
      </p>
    </form>
    <template #footer>
      <UiButton variant="ghost" :disabled="busy" @click="close">{{ t('common.actions.cancel') }}</UiButton>
      <UiButton variant="primary" type="submit" form="env-resize-form" :disabled="!changed" :loading="busy">{{ t('envs.resize.apply') }}</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.rsz { display: grid; gap: var(--space-4); }
.rsz__sizes { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-2); align-items: start; }
.rsz__sizes :deep(.field + .field) { margin-top: 0; }
.rsz__lede { margin: 0; font-size: var(--text-sm); color: var(--fg-muted); text-wrap: pretty; }
.rsz__error {
  display: flex;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--ripe-error);
}
.rsz__error :deep(svg) { width: 15px; height: 15px; margin-top: 2px; flex: none; }
.rsz__error span { color: var(--fg); }
</style>
