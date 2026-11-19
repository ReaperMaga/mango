<script setup lang="ts">
import { CircleAlert, FolderPlus, Server } from 'lucide-vue-next'
import type { EnvRemote } from '~/types/ipc'
import { ENV_WORK_DIR, useEnvironments } from '~/stores/environments'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'

/**
 * Create an empty project folder (optionally `git init`) and land in a fresh chat. Where: on this
 * computer, or inside an environment (the folder is made there, and chats run there).
 */
const ws = useWorkspace()
const envs = useEnvironments()
const threads = useThreads()

const open = computed(() => ws.dialog === 'new')

const where = ref<EnvRemote | null>(null)
const name = ref('')
/** Kept apart, so switching Where back and forth keeps each place's folder. */
const localLocation = ref('')
const remoteLocation = ref(ENV_WORK_DIR)
const location = computed({
  get: () => (where.value ? remoteLocation.value : localLocation.value),
  set: (v: string) => { if (where.value) remoteLocation.value = v; else localLocation.value = v },
})
const gitInit = ref(true)
const touched = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
/** The environment's folder list, open under Location. */
const browsing = ref(false)
const browseDir = ref<string | null>(null)
const browseSelected = ref<string | null>(null)

const tildify = (path: string) => path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~')

function errorText(e: unknown): string {
  if (typeof e === 'string') return e
  if (e instanceof Error) return e.message
  try { return JSON.stringify(e) } catch { return String(e) }
}

const nameError = computed(() => {
  const n = name.value.trim()
  if (!n) return 'Enter a name for the project folder.'
  if (/[/\\]/.test(n)) return 'Use a single folder name, without slashes.'
  if (n.startsWith('.')) return 'Names can\'t start with a dot; that would hide the folder.'
  return null
})
const locationError = computed(() => {
  const l = location.value.trim()
  if (!l) return 'Choose where to create the folder.'
  if (where.value && !l.startsWith('/')) return 'Use an absolute path inside the environment, starting with /.'
  if (where.value && l.split('/').includes('..')) return 'Leave out ".." in the path.'
  return null
})

const shownNameError = computed(() => (touched.value ? nameError.value : null))

const parent = computed(() => location.value.trim().replace(/(.)[\\/]+$/, '$1'))
const preview = computed(() => {
  const leaf = name.value.trim() || 'name'
  if (where.value) return { base: parent.value === '/' ? '/' : `${parent.value || '…'}/`, leaf }
  return { base: withTrailingSep(tildify(parent.value || '…')), leaf }
})
const place = computed(() => (where.value ? envLabels(where.value.hostId, where.value.instance) : null))

watch(open, async (isOpen) => {
  if (!isOpen) return
  where.value = projectWhere()
  name.value = ''
  gitInit.value = true
  touched.value = false
  busy.value = false
  error.value = null
  browsing.value = false
  if (!localLocation.value) {
    localLocation.value = await call('default_projects_dir').catch(() => '')
  }
}, { immediate: true })

function changeWhere(w: EnvRemote | null) {
  where.value = w
  ws.setWhere(w)
  browsing.value = false
  error.value = null
}

/* While browsing, Location follows the folder list. */
watch([browseDir, browseSelected], ([d, s]) => {
  const at = s ?? d
  if (browsing.value && at) remoteLocation.value = at
})

function close() {
  if (busy.value) return
  ws.dialog = null
}

async function browse() {
  if (where.value) {
    browsing.value = !browsing.value
    return
  }
  const picked = await pickFolder('Choose location', localLocation.value || undefined)
  if (picked) localLocation.value = picked
}

function useFolder(path: string) {
  remoteLocation.value = path
  browsing.value = false
}

async function createRemote(w: EnvRemote) {
  const leaf = name.value.trim()
  // Never "create" over a folder that is already there: that one is opened with Open folder.
  const there = await envs.listDir(w.hostId, w.instance, parent.value)
  if (there.entries.some(e => e.name === leaf)) {
    throw new Error(`${there.dir === '/' ? '' : there.dir}/${leaf} already exists. Pick another name, or open that folder with Open folder`)
  }
  const dir = await envs.prepareDir(w.hostId, w.instance, `${there.dir === '/' ? '' : there.dir}/${leaf}`, null, gitInit.value)
  const opened = await ws.openEnvProject({ ...w, dir }, leaf)
  // Created either way: the dialog is done even when the user chose not to open it.
  ws.dialog = null
  if (opened === 'this' && ws.activeProjectPath) threads.create(ws.activeProjectPath)
}

async function submit() {
  touched.value = true
  error.value = null
  if (nameError.value || locationError.value || busy.value) return
  busy.value = true
  try {
    if (where.value) {
      await createRemote(where.value)
    } else {
      const info = await call('create_project', { parent: parent.value, name: name.value.trim(), gitInit: gitInit.value })
      if (await ws.placeProject(info) === 'this') threads.create(info.path)
    }
  } catch (e) {
    error.value = errorText(e).replace(/\.$/, '')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UiDialog :open="open" title="New project" :width="480" :dismissible="!busy" @close="close">
    <form id="new-project-form" class="np" novalidate @submit.prevent="submit">
      <UiField label="Where" for="np-where">
        <ProjectWhere id="np-where" :model-value="where" :disabled="busy" @update:model-value="changeWhere" />
      </UiField>

      <UiField label="Name" for="np-name" :error="shownNameError">
        <input
          id="np-name"
          v-model="name"
          class="input"
          type="text"
          placeholder="my-app"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          :disabled="busy"
          :aria-invalid="!!shownNameError || undefined"
          @blur="name && (touched = true)"
        >
      </UiField>

      <UiField :label="where ? 'Location in the environment' : 'Location'" for="np-location" :error="touched ? locationError : null">
        <div class="np__picker">
          <input
            id="np-location"
            v-model="location"
            class="input np__mono"
            type="text"
            autocomplete="off"
            spellcheck="false"
            :disabled="busy"
          >
          <UiButton :disabled="busy" :aria-expanded="where ? browsing : undefined" @click="browse">{{ where && browsing ? 'Done' : 'Browse…' }}</UiButton>
        </div>
      </UiField>
      <ProjectEnvFolders
        v-if="where && browsing"
        v-model:dir="browseDir"
        v-model:selected="browseSelected"
        class="np__browse"
        :host-id="where.hostId"
        :instance="where.instance"
        :rows="5"
        choose-label="Use"
        :disabled="busy"
        @choose="useFolder"
      />

      <div class="np__switch-row">
        <span class="np__switch-text">
          <span id="np-git-label" class="np__switch-label">Initialize git repository</span>
          <span class="np__switch-hint">Runs <code>git init</code> in the new folder<template v-if="place">, inside {{ place.label }}</template>.</span>
        </span>
        <button
          type="button"
          class="switch"
          role="switch"
          aria-labelledby="np-git-label"
          :aria-checked="gitInit"
          :disabled="busy"
          @click="gitInit = !gitInit"
        >
          <span class="switch__thumb" />
        </button>
      </div>

      <p class="np__preview" aria-live="polite">
        <component :is="where ? Server : FolderPlus" aria-hidden="true" />
        <span v-if="place" class="np__preview-place">{{ place.label }}</span>
        <span class="np__preview-path selectable" :title="`${parent}/${name.trim()}`">
          <span class="np__preview-inner"><span class="np__preview-base">{{ preview.base }}</span><span class="np__preview-leaf" :class="{ 'is-empty': !name.trim() }">{{ preview.leaf }}</span></span>
        </span>
      </p>

      <p v-if="error" class="np__error" role="alert">
        <CircleAlert aria-hidden="true" />
        <span class="selectable">Couldn't create the project. {{ error }}.<template v-if="!where"> Pick another name or location and try again.</template></span>
      </p>
    </form>

    <template #footer>
      <UiButton variant="ghost" :disabled="busy" @click="close">Cancel</UiButton>
      <UiButton variant="primary" type="submit" form="new-project-form" :loading="busy">
        {{ busy ? 'Creating…' : 'Create project' }}
      </UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.np { display: grid; }
.np__picker { display: flex; gap: var(--space-2); }
.np__picker .input { flex: 1; min-width: 0; }
.np .np__picker .input.np__mono { font-family: var(--font-mono); font-size: var(--text-xs); }
.np .input:disabled { color: var(--fg-muted); cursor: default; }
.np__browse { margin-top: var(--space-2); }

.np__switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  margin-top: var(--space-4);
}
.np__switch-text { display: grid; gap: 2px; }
.np__switch-label { font-size: var(--text-sm); font-weight: 540; color: var(--fg); }
.np__switch-hint { font-size: var(--text-xs); color: var(--fg-subtle); }
.np__switch-hint code { font-size: var(--text-2xs); color: var(--fg-muted); }

.switch {
  position: relative;
  flex: none;
  width: 30px;
  height: 18px;
  border-radius: var(--radius-pill);
  background: var(--bg-active);
  box-shadow: inset 0 0 0 1px var(--line-strong);
  transition: background var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.switch__thumb {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--fg-muted);
  transition: translate var(--dur-med) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
.switch[aria-checked='true'] { background: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.switch[aria-checked='true'] .switch__thumb { translate: 12px 0; background: var(--accent-fg); }
.switch:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; border-radius: var(--radius-pill); }
.switch:disabled { opacity: 0.55; }

.np__preview {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-5) 0 0;
  padding: var(--space-2) var(--space-3);
  background: var(--bg-inset);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
}
.np__preview :deep(svg) { width: 14px; height: 14px; stroke-width: 1.75; color: var(--fg-subtle); flex: none; }
.np__preview-place { flex: none; font-size: var(--text-xs); font-weight: 560; color: var(--fg-muted); }
.np__preview-path {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}
.np__preview-inner { direction: ltr; unicode-bidi: isolate; }
.np__preview-base { color: var(--fg-subtle); }
.np__preview-leaf { color: var(--fg); font-weight: 600; }
.np__preview-leaf.is-empty { color: var(--fg-faint); font-weight: 400; }

.np__error {
  display: flex;
  gap: var(--space-2);
  margin: var(--space-3) 0 0;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--ripe-error);
}
.np__error :deep(svg) { width: 15px; height: 15px; margin-top: 2px; flex: none; }
.np__error span { color: var(--fg); }
</style>
