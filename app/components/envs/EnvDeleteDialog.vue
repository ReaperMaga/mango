<script setup lang="ts">
import { CircleAlert } from 'lucide-vue-next'
import { useEnvironments } from '~/stores/environments'
import type { EnvKind } from '~/types/ipc'

/**
 * Delete an instance, after typing its name: it takes everything inside with
 * it (projects, sign-ins, installed tools) and can't be undone.
 */
const props = defineProps<{ open: boolean; hostId: string; name: string; kind: EnvKind }>()
const emit = defineEmits<{ close: []; deleted: [] }>()

const { t } = useI18n()
const envs = useEnvironments()
const typed = ref('')
const busy = ref(false)
const error = ref<string | null>(null)

watch(() => props.open, (o) => {
  if (!o) return
  typed.value = ''
  busy.value = false
  error.value = null
})

const matches = computed(() => typed.value.trim() === props.name)

async function submit() {
  if (!matches.value || busy.value) return
  busy.value = true
  error.value = null
  try {
    await envs.act(props.hostId, props.name, 'delete')
    emit('deleted')
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
  <UiDialog :open="open" :title="t('envs.delete.title', { name })" :dismissible="!busy" @close="close">
    <form id="env-delete-form" class="del" novalidate @submit.prevent="submit">
      <p class="del__lede">
        {{ kind === 'vm' ? t('envs.delete.ledeVm') : t('envs.delete.ledeContainer') }}
      </p>
      <UiField :label="t('envs.delete.confirm', { name })" for="del-name">
        <input
          id="del-name"
          v-model="typed"
          class="input del__mono"
          type="text"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          :disabled="busy"
        >
      </UiField>
      <p v-if="error" class="del__error" role="alert">
        <CircleAlert aria-hidden="true" />
        <span class="selectable">{{ t('envs.delete.failed', { error }) }}</span>
      </p>
    </form>
    <template #footer>
      <UiButton variant="ghost" :disabled="busy" @click="close">{{ t('common.actions.cancel') }}</UiButton>
      <UiButton variant="danger" type="submit" form="env-delete-form" :disabled="!matches" :loading="busy">
        {{ kind === 'vm' ? t('envs.delete.vm') : t('envs.delete.container') }}
      </UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.del { display: grid; gap: var(--space-4); }
.del__lede { margin: 0; font-size: var(--text-sm); color: var(--fg-muted); text-wrap: pretty; }
.del .input.del__mono { font-family: var(--font-mono); font-size: var(--text-xs); }
.del__error {
  display: flex;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--ripe-error);
}
.del__error :deep(svg) { width: 15px; height: 15px; margin-top: 2px; flex: none; }
.del__error span { color: var(--fg); }
</style>
