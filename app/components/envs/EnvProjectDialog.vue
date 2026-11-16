<script setup lang="ts">
import { CircleAlert, FolderGit2 } from 'lucide-vue-next'
import { ENV_WORK_DIR, useEnvironments } from '~/stores/environments'
import { useWorkspace } from '~/stores/workspace'

/**
 * Open a project folder inside an instance: an existing or new folder, or a
 * fresh clone. Chats in it run the agent inside the instance.
 */
const props = defineProps<{ open: boolean; hostId: string; instance: string }>()
const emit = defineEmits<{ close: [] }>()

const envs = useEnvironments()
const ws = useWorkspace()

const name = ref('')
const cloneUrl = ref('')
const folder = ref('')
/** The folder follows the name until the user edits it. */
const folderEdited = ref(false)
const busy = ref(false)
const touched = ref(false)
const error = ref<string | null>(null)

watch(() => props.open, (o) => {
  if (!o) return
  name.value = ''
  cloneUrl.value = ''
  folder.value = `${ENV_WORK_DIR}/`
  folderEdited.value = false
  busy.value = false
  touched.value = false
  error.value = null
})

/** "shop" from https://github.com/acme/shop.git or git@github.com:acme/shop.git */
function repoName(url: string) {
  const m = /([^/:]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m?.[1] ?? ''
}

const leaf = computed(() => name.value.trim() || repoName(cloneUrl.value))
watch(leaf, (l) => {
  if (!folderEdited.value) folder.value = `${ENV_WORK_DIR}/${l}`
})

const dir = computed(() => folder.value.trim().replace(/\/+$/, ''))
const folderError = computed(() => {
  const d = dir.value
  if (!d || d === ENV_WORK_DIR) return 'Name the project, or enter the folder to open.'
  if (!d.startsWith('/')) return 'Use an absolute path inside the environment, starting with /.'
  if (d.split('/').includes('..')) return 'Leave out ".." in the path.'
  return null
})
const urlError = computed(() => {
  const u = cloneUrl.value.trim()
  if (!u) return null
  return /^(https?:\/\/|ssh:\/\/|git@)[^\s]+$/.test(u) ? null : 'Use an https:// or git@ address.'
})

async function submit() {
  touched.value = true
  error.value = null
  if (folderError.value || urlError.value || busy.value) return
  busy.value = true
  try {
    const path = await envs.prepareDir(props.hostId, props.instance, dir.value, cloneUrl.value.trim() || null)
    await ws.openEnvProject({ hostId: props.hostId, instance: props.instance, dir: path }, leaf.value || undefined)
    emit('close')
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
  <UiDialog :open="open" :title="`Open project in ${instance}`" :width="500" :dismissible="!busy" @close="close">
    <form id="env-project-form" class="op" novalidate @submit.prevent="submit">
      <UiField label="Name" for="op-name" hint="Optional. Names the project and its folder.">
        <input
          id="op-name"
          v-model="name"
          class="input"
          type="text"
          placeholder="shop"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          :disabled="busy"
        >
      </UiField>
      <UiField
        label="Clone from"
        for="op-url"
        hint="Optional. Cloned inside the environment with its own git and GitHub sign-in."
        :error="touched ? urlError : null"
      >
        <input
          id="op-url"
          v-model="cloneUrl"
          class="input op__mono"
          type="text"
          placeholder="https://github.com/you/shop.git"
          autocomplete="off"
          spellcheck="false"
          :disabled="busy"
        >
      </UiField>
      <UiField
        label="Folder in the environment"
        for="op-folder"
        hint="Created if it doesn't exist. An existing folder opens as it is."
        :error="touched ? folderError : null"
      >
        <input
          id="op-folder"
          v-model="folder"
          class="input op__mono"
          type="text"
          autocomplete="off"
          spellcheck="false"
          :disabled="busy"
          @input="folderEdited = true"
        >
      </UiField>

      <p v-if="error" class="op__error" role="alert">
        <CircleAlert aria-hidden="true" />
        <span class="selectable">Couldn't open it. {{ error }}.</span>
      </p>
    </form>
    <template #footer>
      <UiButton variant="ghost" :disabled="busy" @click="close">Cancel</UiButton>
      <UiButton variant="primary" type="submit" form="env-project-form" :loading="busy">
        <FolderGit2 v-if="!busy" />{{ busy ? (cloneUrl.trim() ? 'Cloning…' : 'Opening…') : cloneUrl.trim() ? 'Clone and open' : 'Open project' }}
      </UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.op { display: grid; }
.op .input.op__mono { font-family: var(--font-mono); font-size: var(--text-xs); }
.op__error {
  display: flex;
  gap: var(--space-2);
  margin: var(--space-4) 0 0;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--ripe-error);
}
.op__error :deep(svg) { width: 15px; height: 15px; margin-top: 2px; flex: none; }
.op__error span { color: var(--fg); }
</style>
