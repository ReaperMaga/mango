<script setup lang="ts">
import { Box, ChevronDown, CircleAlert, FolderOpen, LogIn, Monitor } from 'lucide-vue-next'
import { ENV_COMPONENTS, ENV_IMAGES, instanceKey, useEnvironments } from '~/stores/environments'
import type { EnvComponentId, EnvCreateInput, EnvKind } from '~/types/ipc'
import type { MenuItem } from '~/types/ui'
import SettingsSegmented from '~/components/settings/SettingsSegmented.vue'
import EnvTerminal from './EnvTerminal.vue'

/**
 * New environment: name, image, container or VM, size, and the components to
 * install. Creating runs in a terminal inside the dialog so the launch and
 * every installer can be followed (and answered); then it offers next steps.
 */
const envs = useEnvironments()

const open = computed(() => envs.dialog?.kind === 'create')
const hostId = ref('')
const host = computed(() => envs.host(hostId.value))

const name = ref('')
const image = ref<string>(ENV_IMAGES[0].id)
const customImage = ref('')
const useCustom = ref(false)
const kind = ref<EnvKind>('container')
const cpus = ref('')
const memory = ref('')
const disk = ref('')
/** What the user ticked; requirements are added on top (see `effective`). */
const picked = ref<Set<EnvComponentId>>(new Set())

type Phase = 'form' | 'running' | 'done' | 'failed'
const phase = ref<Phase>('form')
const touched = ref(false)
const notice = ref<string | null>(null)
/** The input of the run in progress (the form may not change under it). */
const running = ref<EnvCreateInput | null>(null)

const kinds = [
  { value: 'container' as const, label: 'Container', icon: Box },
  { value: 'vm' as const, label: 'Virtual machine', icon: Monitor },
]

watch(open, (isOpen) => {
  if (!isOpen) return
  hostId.value = envs.dialog?.kind === 'create' ? envs.dialog.hostId : ''
  name.value = suggestName()
  image.value = ENV_IMAGES[0].id
  customImage.value = ''
  useCustom.value = false
  kind.value = 'container'
  cpus.value = ''
  memory.value = ''
  disk.value = ''
  const defaults: EnvComponentId[] = ['base', 'claude', 'gh']
  if (host.value?.tailscale) defaults.push('tailscale')
  picked.value = new Set(defaults)
  phase.value = 'form'
  touched.value = false
  notice.value = null
  running.value = null
})

/** "dev", or "dev-2" when that is taken. */
function suggestName() {
  const taken = new Set((envs.instances[hostId.value] ?? []).map(i => i.name))
  if (!taken.has('dev')) return 'dev'
  let n = 2
  while (taken.has(`dev-${n}`)) n++
  return `dev-${n}`
}

/* ---------- image ---------- */

const imageLabel = computed(() =>
  useCustom.value ? 'Other image' : ENV_IMAGES.find(i => i.id === image.value)?.name ?? image.value)

const imageItems = computed<MenuItem[]>(() => [
  ...ENV_IMAGES.map(i => ({
    label: i.name,
    hint: i.id,
    checked: !useCustom.value && image.value === i.id,
    onSelect: () => { useCustom.value = false; image.value = i.id },
  })),
  {
    label: 'Other image…',
    hint: 'Any remote:alias the server can pull',
    checked: useCustom.value,
    divider: true,
    onSelect: async () => {
      useCustom.value = true
      await nextTick()
      document.getElementById('ec-image-custom')?.focus()
    },
  },
])

/* ---------- components: ticking one ticks what it needs ---------- */

const byId = (id: EnvComponentId) => ENV_COMPONENTS.find(c => c.id === id)

const effective = computed(() => {
  const out = new Set<EnvComponentId>()
  const add = (id: EnvComponentId) => {
    if (out.has(id)) return
    out.add(id)
    byId(id)?.requires.forEach(add)
  }
  picked.value.forEach(add)
  return out
})

/** The ticked component that needs this one, if any (then it can't be unticked on its own). */
function neededBy(id: EnvComponentId): string | null {
  for (const c of ENV_COMPONENTS) {
    if (c.id !== id && effective.value.has(c.id) && c.requires.includes(id)) return c.name
  }
  return null
}

function toggle(id: EnvComponentId) {
  const next = new Set(picked.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  picked.value = next
}

/* ---------- validation ---------- */

const nameError = computed(() => {
  const n = name.value.trim()
  if (!n) return 'Enter a name for the environment.'
  if (!/^[A-Za-z][A-Za-z0-9-]{0,62}$/.test(n) || n.endsWith('-')) return 'Use a letter, then letters, digits and dashes (up to 63), not ending in a dash.'
  if ((envs.instances[hostId.value] ?? []).some(i => i.name === n)) return `There is already an environment called ${n} on this server.`
  return null
})
const imageError = computed(() => {
  if (!useCustom.value) return null
  const s = customImage.value.trim()
  if (!s) return 'Enter an image, such as images:fedora/42.'
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(s) ? null : 'Images look like remote:alias, e.g. images:fedora/42.'
})
function sizeError(v: string, max: number) {
  const s = v.trim()
  if (!s) return null
  const n = Number(s)
  return Number.isInteger(n) && n > 0 && n <= max ? null : `A whole number from 1 to ${max}.`
}
const cpusError = computed(() => sizeError(cpus.value, 512))
const memoryError = computed(() => sizeError(memory.value, 4096))
const diskError = computed(() => sizeError(disk.value, 65536))
const invalid = computed(() => !!(nameError.value || imageError.value || cpusError.value || memoryError.value || diskError.value))

const num = (v: string) => (v.trim() ? Number(v) : null)

/* ---------- run ---------- */

function submit() {
  touched.value = true
  notice.value = null
  if (invalid.value || phase.value === 'running' || !hostId.value) return
  running.value = {
    hostId: hostId.value,
    name: name.value.trim(),
    image: useCustom.value ? customImage.value.trim() : image.value,
    kind: kind.value,
    cpus: num(cpus.value),
    memoryGib: num(memory.value),
    diskGib: num(disk.value),
    // In the order of the catalogue, so requirements come first.
    components: ENV_COMPONENTS.map(c => c.id).filter(id => effective.value.has(id)),
  }
  phase.value = 'running'
}

const start = (cols: number, rows: number) => envs.create(running.value!, cols, rows)

function onExit(code: number | null) {
  phase.value = code === 0 ? 'done' : 'failed'
  envs.refreshInstances(hostId.value)
}

function stop() {
  // Unmounting the terminal kills the process.
  phase.value = 'form'
  notice.value = 'Stopped. Part of the environment may already exist; check the list before creating it again.'
  envs.refreshInstances(hostId.value)
}

function back() {
  phase.value = 'form'
  notice.value = 'It didn\'t finish. If the environment was created anyway, open it from the list and install what is missing.'
}

function close() {
  if (phase.value === 'running') return
  envs.dialog = null
}

/** Leave for the new instance's page, optionally with a next step for it to start. */
function finish(intent: 'login-claude' | 'open-project' | null) {
  const input = running.value
  envs.dialog = null
  if (!input) return
  if (intent) envs.intents[instanceKey(input.hostId, input.name)] = intent
  envs.select(input.hostId, input.name)
}

const title = computed(() => (host.value ? `New environment on ${host.value.name}` : 'New environment'))
</script>

<template>
  <UiDialog :open="open" :title="title" :width="580" :dismissible="phase !== 'running'" @close="close">
    <form v-if="phase === 'form'" id="env-create-form" class="ec" novalidate @submit.prevent="submit">
      <UiField label="Name" for="ec-name" :error="touched ? nameError : null">
        <input
          id="ec-name"
          v-model="name"
          class="input"
          type="text"
          placeholder="dev"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          :aria-invalid="(touched && !!nameError) || undefined"
          @blur="touched = true"
        >
      </UiField>

      <div class="ec__row">
        <UiField label="Image" for="ec-image" :error="touched ? imageError : null">
          <UiMenu :items="imageItems" :width="300" label="Image">
            <template #default="{ toggle: toggleMenu, open: menuOpen }">
              <button
                id="ec-image"
                type="button"
                class="ec__select"
                :class="{ 'is-open': menuOpen }"
                aria-haspopup="menu"
                :aria-expanded="menuOpen"
                @click="toggleMenu"
              >
                <span class="ec__select-label">{{ imageLabel }}</span>
                <ChevronDown aria-hidden="true" />
              </button>
            </template>
          </UiMenu>
          <input
            v-if="useCustom"
            id="ec-image-custom"
            v-model="customImage"
            class="input ec__mono"
            type="text"
            placeholder="images:fedora/42"
            aria-label="Image (remote:alias)"
            autocomplete="off"
            spellcheck="false"
          >
        </UiField>

        <div class="ec__kind">
          <span id="ec-kind-label" class="ec__label">Type</span>
          <SettingsSegmented v-model="kind" :options="kinds" labelledby="ec-kind-label" />
        </div>
      </div>
      <p class="ec__hint">
        {{ kind === 'container'
          ? 'Starts in seconds and shares the server\'s kernel.'
          : 'Fully separate, with its own kernel. Slower to start; uses the image\'s cloud variant.' }}
      </p>

      <div class="ec__sizes">
        <UiField label="CPUs" for="ec-cpus" :error="touched ? cpusError : null">
          <input id="ec-cpus" v-model="cpus" class="input tabular" type="text" inputmode="numeric" placeholder="Default" autocomplete="off">
        </UiField>
        <UiField label="Memory (GiB)" for="ec-mem" :error="touched ? memoryError : null">
          <input id="ec-mem" v-model="memory" class="input tabular" type="text" inputmode="numeric" placeholder="Default" autocomplete="off">
        </UiField>
        <UiField label="Disk (GiB)" for="ec-disk" :error="touched ? diskError : null">
          <input id="ec-disk" v-model="disk" class="input tabular" type="text" inputmode="numeric" placeholder="Default" autocomplete="off">
        </UiField>
      </div>
      <p class="ec__hint">Empty fields use the server's profile.</p>

      <fieldset class="ec__comps">
        <legend class="ec__label">Install</legend>
        <ul class="ec__list">
          <li v-for="c in ENV_COMPONENTS" :key="c.id">
            <label class="ec__comp" :class="{ 'is-locked': !!neededBy(c.id) }">
              <input
                type="checkbox"
                class="ec__check"
                :checked="effective.has(c.id)"
                :disabled="!!neededBy(c.id)"
                @change="toggle(c.id)"
              >
              <span class="ec__comp-text">
                <span class="ec__comp-name">{{ c.name }}</span>
                <span class="ec__comp-desc">
                  <template v-if="neededBy(c.id)">Needed by {{ neededBy(c.id) }}.</template>
                  <template v-else>{{ c.description }}</template>
                  <template v-if="c.id === 'tailscale' && !host?.tailscale"> Set up Tailscale for this server to give it tags.</template>
                </span>
              </span>
            </label>
          </li>
        </ul>
      </fieldset>

      <p v-if="notice" class="ec__notice" role="status">
        <CircleAlert aria-hidden="true" />
        <span>{{ notice }}</span>
      </p>
    </form>

    <div v-else class="ec__run">
      <EnvTerminal
        :start="start"
        :title="`Creating ${running?.name}…`"
        :done-title="`${running?.name} is ready`"
        failed-title="Creating it didn't finish"
        :label="`Creating ${running?.name}`"
        :rows="14"
        flat
        :closable="false"
        :retryable="false"
        @exit="onExit"
      >
        <template #hint>
          The server downloads the image the first time, which can take a few minutes. If an installer asks something, answer it here.
        </template>
      </EnvTerminal>

      <div v-if="phase === 'done'" class="ec__next">
        <p class="ec__next-lede">Next, sign in to the agents inside it, or open a project there.</p>
        <div class="ec__next-actions">
          <UiButton v-if="running?.components.includes('claude')" @click="finish('login-claude')">
            <LogIn />Sign in to Claude Code
          </UiButton>
          <UiButton @click="finish('open-project')"><FolderOpen />Open project…</UiButton>
        </div>
      </div>
    </div>

    <template #footer>
      <template v-if="phase === 'form'">
        <UiButton variant="ghost" @click="close">Cancel</UiButton>
        <UiButton variant="primary" type="submit" form="env-create-form" :disabled="!host">Create environment</UiButton>
      </template>
      <UiButton v-else-if="phase === 'running'" variant="ghost" @click="stop">Stop</UiButton>
      <template v-else-if="phase === 'failed'">
        <UiButton variant="ghost" @click="close">Close</UiButton>
        <UiButton @click="back">Back to settings</UiButton>
      </template>
      <UiButton v-else variant="primary" data-autofocus @click="finish(null)">Done</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.ec { display: grid; border: 0; }
.ec__mono { font-family: var(--font-mono); }
.ec .input.ec__mono { font-size: var(--text-xs); }
.ec__label { font-size: var(--text-xs); font-weight: 560; color: var(--fg-muted); padding: 0; }
.ec__hint {
  margin: 6px 0 0;
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  line-height: var(--leading-tight);
}

.ec__row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: var(--space-4);
  align-items: start;
  margin-top: var(--space-4);
}
.ec__row :deep(.menu) { display: flex; }
.ec__kind { display: grid; gap: 6px; }

/* A menu trigger that reads as a field. */
.ec__select {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  height: 32px;
  padding: 0 var(--space-2) 0 var(--space-3);
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  text-align: left;
  color: var(--fg);
  transition: border-color var(--dur-fast) var(--ease-out);
}
.ec__select:hover { border-color: var(--line-strong); }
.ec__select.is-open { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.ec__select-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ec__select :deep(svg) { flex: none; width: 14px; height: 14px; color: var(--fg-subtle); }

.ec__sizes {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-2);
  margin-top: var(--space-4);
}
.ec__sizes :deep(.field + .field) { margin-top: 0; }

/* ---- components ---- */
.ec__comps {
  margin: var(--space-5) 0 0;
  padding: var(--space-4) 0 0;
  border: 0;
  border-top: 1px solid var(--line-soft);
  min-width: 0;
}
.ec__comps legend { float: left; width: 100%; margin-bottom: var(--space-2); }
.ec__list {
  clear: both;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.ec__comp {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: 6px var(--space-2);
  margin: 0 calc(var(--space-2) * -1);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.ec__comp:hover { background: var(--bg-hover); }
.ec__comp.is-locked { cursor: default; }
.ec__comp.is-locked:hover { background: none; }
.ec__comp-text { display: grid; min-width: 0; }
.ec__comp-name { font-size: var(--text-sm); font-weight: 560; color: var(--fg); }
.ec__comp-desc { font-size: var(--text-xs); color: var(--fg-subtle); text-wrap: pretty; }

/* 13px inset square that fills with Ripe Mango and a Mango Stone Ink tick. */
.ec__check {
  appearance: none;
  flex: none;
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  margin: 2px 0 0;
  background: var(--bg-inset);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-xs);
  cursor: inherit;
  transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.ec__check::after {
  content: '';
  width: 7px;
  height: 4px;
  margin-top: -2px;
  border: solid var(--accent-fg);
  border-width: 0 0 1.75px 1.75px;
  rotate: -45deg;
  opacity: 0;
}
.ec__check:checked { background: var(--accent); border-color: var(--accent); }
.ec__check:checked::after { opacity: 1; }
.ec__check:disabled { opacity: 0.6; }
.ec__check:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }

.ec__notice {
  display: flex;
  gap: var(--space-2);
  margin: var(--space-4) 0 0;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--ripe-waiting);
}
.ec__notice :deep(svg) { width: 15px; height: 15px; margin-top: 2px; flex: none; }
.ec__notice span { color: var(--fg); }

/* ---- running ---- */
.ec__run { display: grid; gap: var(--space-4); padding-top: var(--space-2); }
.ec__next { display: grid; gap: var(--space-3); }
.ec__next-lede { margin: 0; font-size: var(--text-sm); color: var(--fg-muted); }
.ec__next-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
</style>
