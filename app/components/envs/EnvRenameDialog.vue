<script setup lang="ts">
import { CircleAlert } from 'lucide-vue-next'
import { useEnvironments } from '~/stores/environments'

/**
 * Rename an instance. Incus renames only stopped instances, so a running one
 * is stopped and started again; Mango's projects and chats in it move along.
 */
const props = defineProps<{ open: boolean; hostId: string; name: string; running: boolean }>()
const emit = defineEmits<{ close: []; renamed: [name: string, note: string | null] }>()

const envs = useEnvironments()
const value = ref('')
const touched = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)

watch(() => props.open, (o) => {
  if (!o) return
  value.value = props.name
  touched.value = false
  busy.value = false
  error.value = null
  nextTick(() => (document.getElementById('ren-name') as HTMLInputElement | null)?.select())
})

const next = computed(() => value.value.trim())
const nameError = computed(() => {
  const n = next.value
  if (!n) return 'Enter a name.'
  if (!/^[A-Za-z][A-Za-z0-9-]{0,62}$/.test(n) || n.endsWith('-')) return 'Use a letter, then letters, digits and dashes (up to 63), not ending in a dash.'
  if (n !== props.name && (envs.instances[props.hostId] ?? []).some(i => i.name === n)) return `There is already an environment called ${n} on this server.`
  return null
})
const unchanged = computed(() => next.value === props.name)

async function submit() {
  touched.value = true
  if (nameError.value || unchanged.value || busy.value) return
  busy.value = true
  error.value = null
  try {
    const note = await envs.rename(props.hostId, props.name, next.value)
    emit('renamed', next.value, note)
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
  <UiDialog :open="open" :title="`Rename ${name}`" :dismissible="!busy" @close="close">
    <form id="env-rename-form" class="ren" novalidate @submit.prevent="submit">
      <UiField label="Name" for="ren-name" :error="touched ? nameError : null">
        <input
          id="ren-name"
          v-model="value"
          class="input"
          type="text"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          :disabled="busy"
        >
      </UiField>
      <p class="ren__lede">
        <template v-if="running">
          Incus renames only stopped environments, so Mango stops {{ name }}, renames it and starts it again. Chats,
          shells and its desktop working in it are interrupted.
        </template>
        <template v-else>The environment stays stopped.</template>
        Its projects and chats in Mango move to the new name.
      </p>
      <p v-if="error" class="ren__error" role="alert">
        <CircleAlert aria-hidden="true" />
        <span class="selectable">Couldn't rename it. {{ error }}.</span>
      </p>
    </form>
    <template #footer>
      <UiButton variant="ghost" :disabled="busy" @click="close">Cancel</UiButton>
      <UiButton variant="primary" type="submit" form="env-rename-form" :disabled="unchanged" :loading="busy">
        {{ running ? 'Stop and rename' : 'Rename' }}
      </UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.ren { display: grid; gap: var(--space-4); }
.ren__lede { margin: 0; font-size: var(--text-sm); color: var(--fg-muted); text-wrap: pretty; }
.ren__error {
  display: flex;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--ripe-error);
}
.ren__error :deep(svg) { width: 15px; height: 15px; margin-top: 2px; flex: none; }
.ren__error span { color: var(--fg); }
</style>
