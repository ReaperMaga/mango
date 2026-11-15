<script setup lang="ts">
import { CircleAlert, FolderPlus } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'

/** Create an empty project folder (optionally `git init`) and land in a fresh chat. */
const ws = useWorkspace()
const threads = useThreads()

const open = computed(() => ws.dialog === 'new')

const name = ref('')
const location = ref('')
const gitInit = ref(true)
const touched = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)

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
const locationError = computed(() => (location.value.trim() ? null : 'Choose where to create the folder.'))

const shownNameError = computed(() => (touched.value ? nameError.value : null))

const parent = computed(() => location.value.trim().replace(/(.)[\\/]+$/, '$1'))
const preview = computed(() => {
  const base = tildify(parent.value || '…')
  return { base: withTrailingSep(base), leaf: name.value.trim() || 'name' }
})

watch(open, async (isOpen) => {
  if (!isOpen) return
  name.value = ''
  gitInit.value = true
  touched.value = false
  busy.value = false
  error.value = null
  if (!location.value) {
    location.value = await call('default_projects_dir').catch(() => '')
  }
}, { immediate: true })

function close() {
  if (busy.value) return
  ws.dialog = null
}

async function browse() {
  const picked = await pickFolder('Choose location', location.value || undefined)
  if (picked) location.value = picked
}

async function submit() {
  touched.value = true
  error.value = null
  if (nameError.value || locationError.value || busy.value) return
  busy.value = true
  try {
    const info = await call('create_project', { parent: parent.value, name: name.value.trim(), gitInit: gitInit.value })
    ws.adopt(info)
    threads.create(info.path)
  } catch (e) {
    error.value = errorText(e).replace(/\.$/, '')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UiDialog :open="open" title="New project" :width="480" @close="close">
    <form id="new-project-form" class="np" novalidate @submit.prevent="submit">
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

      <UiField label="Location" for="np-location" :error="touched ? locationError : null">
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
          <UiButton :disabled="busy" @click="browse">Browse…</UiButton>
        </div>
      </UiField>

      <div class="np__switch-row">
        <span class="np__switch-text">
          <span id="np-git-label" class="np__switch-label">Initialize git repository</span>
          <span class="np__switch-hint">Runs <code>git init</code> in the new folder.</span>
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
        <FolderPlus aria-hidden="true" />
        <span class="np__preview-path selectable" :title="`${parent}/${name.trim()}`">
          <span class="np__preview-inner"><span class="np__preview-base">{{ preview.base }}</span><span class="np__preview-leaf" :class="{ 'is-empty': !name.trim() }">{{ preview.leaf }}</span></span>
        </span>
      </p>

      <p v-if="error" class="np__error" role="alert">
        <CircleAlert aria-hidden="true" />
        <span>Couldn't create the project. {{ error }}. Pick another name or location and try again.</span>
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
