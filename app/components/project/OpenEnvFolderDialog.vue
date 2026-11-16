<script setup lang="ts">
import { CircleAlert } from 'lucide-vue-next'
import type { EnvRemote } from '~/types/ipc'
import { useEnvironments } from '~/stores/environments'
import { useWorkspace } from '~/stores/workspace'
import { openLocalFolder } from '~/composables/useShortcuts'
import ProjectEnvFolders from '~/components/project/ProjectEnvFolders.vue'

/**
 * Open folder, in an environment: the system's folder picker can't see inside one, so this
 * browses its folders instead. Opens the selected folder, or the one being shown, or a typed path.
 * Choosing "This computer" under Where hands over to the system's picker.
 */
const ws = useWorkspace()
const envs = useEnvironments()

const open = computed(() => ws.dialog === 'open-env')
const where = ref<EnvRemote | null>(null)
const dir = ref<string | null>(null)
const selected = ref<string | null>(null)
const path = ref('')
const busy = ref(false)
const error = ref<string | null>(null)
const browser = ref<InstanceType<typeof ProjectEnvFolders> | null>(null)

watch(open, (o) => {
  if (!o) return
  dir.value = null
  path.value = ''
  where.value = projectWhere()
  busy.value = false
  error.value = null
  selected.value = null
  if (!envs.loaded) envs.load().catch(() => {})
}, { immediate: true })

/* The path field follows the list until the user types in it. */
watch([dir, selected], ([d, s]) => { path.value = s ?? d ?? '' })

async function changeWhere(w: EnvRemote | null) {
  error.value = null
  ws.setWhere(w)
  if (w) {
    where.value = w
    return
  }
  ws.dialog = null
  await openLocalFolder().catch(() => {})
}

const target = computed(() => path.value.trim().replace(/(.)\/+$/, '$1'))
const pathError = computed(() => {
  const p = target.value
  if (!p) return 'Pick a folder, or type its path.'
  if (!p.startsWith('/') && p !== '~' && !p.startsWith('~/')) return 'Use an absolute path, starting with / or ~.'
  return null
})

function onPathEnter() {
  if (pathError.value) return
  // A typed path that isn't the one shown: go there first, so the list shows what will open.
  if (target.value !== (selected.value ?? dir.value)) browser.value?.go(target.value)
  else submit()
}

async function submit() {
  error.value = null
  const w = where.value
  if (!w || busy.value) return
  if (pathError.value) { error.value = pathError.value.replace(/\.$/, ''); return }
  busy.value = true
  try {
    // Make sure it is there (and resolve ~) before it becomes a project: Open never creates a folder.
    const listed = await envs.listDir(w.hostId, w.instance, target.value)
    const at = await envs.prepareDir(w.hostId, w.instance, listed.dir, null)
    await ws.openEnvProject({ ...w, dir: at })
  } catch (e) {
    error.value = (e instanceof Error ? e.message : String(e)).replace(/\.$/, '')
  } finally {
    busy.value = false
  }
}

function close() {
  if (!busy.value) ws.dialog = null
}

const place = computed(() => (where.value ? envLabels(where.value.hostId, where.value.instance) : null))
const leaf = computed(() => {
  const t = target.value
  return t === '/' ? '/' : t.slice(t.lastIndexOf('/') + 1) || t
})
</script>

<template>
  <UiDialog :open="open" title="Open folder" :width="560" :dismissible="!busy" @close="close">
    <form id="open-env-form" class="oe" novalidate @submit.prevent="submit">
      <UiField label="Where" for="oe-where">
        <ProjectWhere id="oe-where" :model-value="where" placeholder="Choose an environment" :disabled="busy" @update:model-value="changeWhere" />
      </UiField>

      <div v-if="where" class="oe__browse">
        <ProjectEnvFolders
          ref="browser"
          v-model:dir="dir"
          v-model:selected="selected"
          :host-id="where.hostId"
          :instance="where.instance"
          :disabled="busy"
          :rows="8"
          @choose="p => { path = p; submit() }"
        />
      </div>
      <p v-else class="oe__pick">Choose an environment under Where to browse its folders.</p>

      <UiField
        v-if="where"
        label="Folder"
        for="oe-path"
        :hint="place ? `Opens as a project in ${place.where}. Agents and terminals run there.` : undefined"
      >
        <input
          id="oe-path"
          v-model="path"
          class="input oe__mono"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="/home/agent/work/shop"
          :disabled="busy"
          @keydown.enter.prevent="onPathEnter"
        >
      </UiField>

      <p v-if="error" class="oe__error" role="alert">
        <CircleAlert aria-hidden="true" />
        <span class="selectable">Couldn't open it. {{ error }}.</span>
      </p>
    </form>
    <template #footer>
      <UiButton variant="ghost" :disabled="busy" @click="close">Cancel</UiButton>
      <UiButton variant="primary" type="submit" form="open-env-form" :loading="busy" :disabled="!where">
        {{ busy ? 'Opening…' : where && target && !pathError ? `Open ${leaf}` : 'Open' }}
      </UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.oe { display: grid; }
.oe__browse { margin-top: var(--space-4); }
.oe__browse + .field { margin-top: var(--space-3); }
.oe__pick {
  display: grid;
  place-items: center;
  height: 120px;
  margin: var(--space-4) 0 0;
  font-size: var(--text-sm);
  color: var(--fg-subtle);
  background: var(--bg-inset);
  border: 1px dashed var(--line);
  border-radius: var(--radius-md);
}
.oe__pick + .field { margin-top: var(--space-3); }
.oe .input.oe__mono { font-family: var(--font-mono); font-size: var(--text-xs); }
.oe__error {
  display: flex;
  gap: var(--space-2);
  margin: var(--space-3) 0 0;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--ripe-error);
}
.oe__error :deep(svg) { width: 15px; height: 15px; margin-top: 2px; flex: none; }
.oe__error span { color: var(--fg); }
</style>
