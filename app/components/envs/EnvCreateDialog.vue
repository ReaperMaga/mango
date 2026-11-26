<script setup lang="ts">
import { Box, ChevronDown, CircleAlert, FolderOpen, LogIn, Monitor } from 'lucide-vue-next'
import { ENV_COMPONENTS, ENV_IMAGES, envComponentName, envDefaultVersion, instanceKey, useEnvironments } from '~/stores/environments'
import type { EnvComponentId, EnvCreateInput, EnvKind, EnvVersions } from '~/types/ipc'
import type { MenuItem } from '~/types/ui'
import SettingsSegmented from '~/components/settings/SettingsSegmented.vue'
import EnvTerminal from './EnvTerminal.vue'
import EnvVersionPicker from './EnvVersionPicker.vue'

/**
 * New environment: name, image, container or VM, size, and the components to
 * install. Creating runs in a terminal inside the dialog so the launch and
 * every installer can be followed (and answered); then it offers next steps.
 */
const { t } = useI18n()
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
/** Versions picked for Node.js and Java; a missing one installs the default. */
const versions = ref<EnvVersions>({})

type Phase = 'form' | 'running' | 'done' | 'failed'
const phase = ref<Phase>('form')
const touched = ref(false)
const notice = ref<string | null>(null)
/** The input of the run in progress (the form may not change under it). */
const running = ref<EnvCreateInput | null>(null)

const kinds = computed(() => [
  { value: 'container' as const, label: t('envs.common.container'), icon: Box },
  { value: 'vm' as const, label: t('envs.common.vm'), icon: Monitor },
])

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
  versions.value = {}
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
  useCustom.value ? t('envs.create.otherImage') : ENV_IMAGES.find(i => i.id === image.value)?.name ?? image.value)

const imageItems = computed<MenuItem[]>(() => [
  ...ENV_IMAGES.map(i => ({
    label: i.name,
    hint: i.id,
    checked: !useCustom.value && image.value === i.id,
    onSelect: () => { useCustom.value = false; image.value = i.id },
  })),
  {
    label: t('envs.create.otherImageMore'),
    hint: t('envs.create.otherImageHint'),
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
    if (c.id !== id && effective.value.has(c.id) && c.requires.includes(id)) return envComponentName(c.id)
  }
  return null
}

function setVersion(id: EnvComponentId, v: string | null) {
  const next = { ...versions.value }
  if (v) next[id] = v
  else delete next[id]
  versions.value = next
}
const versionLabel = (id: EnvComponentId) => versions.value[id] ?? envDefaultVersion(id)

function toggle(id: EnvComponentId) {
  const next = new Set(picked.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  picked.value = next
}

/* ---------- validation ---------- */

const nameError = computed(() => {
  const n = name.value.trim()
  if (!n) return t('envs.create.nameEmpty')
  if (!/^[A-Za-z][A-Za-z0-9-]{0,62}$/.test(n) || n.endsWith('-')) return t('envs.common.nameRule')
  if ((envs.instances[hostId.value] ?? []).some(i => i.name === n)) return t('envs.common.nameTaken', { name: n })
  return null
})
const imageError = computed(() => {
  if (!useCustom.value) return null
  const s = customImage.value.trim()
  if (!s) return t('envs.create.imageEmpty')
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(s) ? null : t('envs.create.imageInvalid')
})
function sizeError(v: string, max: number) {
  const s = v.trim()
  if (!s) return null
  const n = Number(s)
  return Number.isInteger(n) && n > 0 && n <= max ? null : t('envs.common.wholeNumber', { min: 1, max })
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
    // Only for what gets installed.
    versions: Object.fromEntries(Object.entries(versions.value).filter(([id]) => effective.value.has(id as EnvComponentId))),
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
  notice.value = t('envs.create.stopped')
  envs.refreshInstances(hostId.value)
}

function back() {
  phase.value = 'form'
  notice.value = t('envs.create.unfinished')
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

const title = computed(() => (host.value ? t('envs.create.titleOn', { host: host.value.name }) : t('envs.common.newEnvironment')))
</script>

<template>
  <UiDialog :open="open" :title="title" :width="580" :dismissible="phase !== 'running'" @close="close">
    <form v-if="phase === 'form'" id="env-create-form" class="ec" novalidate @submit.prevent="submit">
      <UiField :label="t('envs.common.name')" for="ec-name" :error="touched ? nameError : null">
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
        <UiField :label="t('envs.common.image')" for="ec-image" :error="touched ? imageError : null">
          <UiMenu :items="imageItems" :width="300" :label="t('envs.common.image')">
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
            :aria-label="t('envs.create.imageLabel')"
            autocomplete="off"
            spellcheck="false"
          >
        </UiField>

        <div class="ec__kind">
          <span id="ec-kind-label" class="ec__label">{{ t('envs.create.type') }}</span>
          <SettingsSegmented v-model="kind" :options="kinds" labelledby="ec-kind-label" />
        </div>
      </div>
      <p class="ec__hint">
        {{ kind === 'container'
          ? t('envs.create.containerHint')
          : t('envs.create.vmHint') }}
      </p>

      <div class="ec__sizes">
        <UiField :label="t('envs.common.cpus')" for="ec-cpus" :error="touched ? cpusError : null">
          <input id="ec-cpus" v-model="cpus" class="input tabular" type="text" inputmode="numeric" :placeholder="t('envs.common.default')" autocomplete="off">
        </UiField>
        <UiField :label="t('envs.common.memoryGib')" for="ec-mem" :error="touched ? memoryError : null">
          <input id="ec-mem" v-model="memory" class="input tabular" type="text" inputmode="numeric" :placeholder="t('envs.common.default')" autocomplete="off">
        </UiField>
        <UiField :label="t('envs.common.diskGib')" for="ec-disk" :error="touched ? diskError : null">
          <input id="ec-disk" v-model="disk" class="input tabular" type="text" inputmode="numeric" :placeholder="t('envs.common.default')" autocomplete="off">
        </UiField>
      </div>
      <p class="ec__hint">{{ t('envs.create.sizesHint') }}</p>

      <fieldset class="ec__comps">
        <legend class="ec__label">{{ t('envs.create.install') }}</legend>
        <ul class="ec__list">
          <li v-for="c in ENV_COMPONENTS" :key="c.id" class="ec__item">
            <label class="ec__comp" :class="{ 'is-locked': !!neededBy(c.id) }">
              <input
                type="checkbox"
                class="ec__check"
                :checked="effective.has(c.id)"
                :disabled="!!neededBy(c.id)"
                @change="toggle(c.id)"
              >
              <span class="ec__comp-text">
                <span class="ec__comp-name">{{ envComponentName(c.id) }}</span>
                <span class="ec__comp-desc">
                  <template v-if="neededBy(c.id)">{{ t('envs.create.neededBy', { name: neededBy(c.id) }) }}</template>
                  <template v-else>{{ t(`envs.components.${c.id}.description`) }}</template>
                  <template v-if="c.id === 'tailscale' && !host?.tailscale">{{ ` ${t('envs.create.tailscaleTags')}` }}</template>
                </span>
              </span>
            </label>
            <!-- Outside the label: a click on it must not tick the box. -->
            <EnvVersionPicker
              v-if="c.versioned && effective.has(c.id)"
              class="ec__ver-anchor"
              :component="c.id"
              :name="envComponentName(c.id)"
              :selected="versions[c.id] ?? null"
              allow-default
              @pick="(v) => setVersion(c.id, v)"
            >
              <template #default="{ toggle: toggleVersions, open: versionsOpen }">
                <button
                  type="button"
                  class="ec__ver"
                  :class="{ 'is-open': versionsOpen }"
                  aria-haspopup="dialog"
                  :aria-expanded="versionsOpen"
                  :aria-label="t('envs.create.versionLabel', { name: envComponentName(c.id), version: versionLabel(c.id) })"
                  @click="toggleVersions"
                >
                  <span class="ec__ver-label" :class="{ 'is-picked': !!versions[c.id] }">{{ versionLabel(c.id) }}</span>
                  <ChevronDown aria-hidden="true" />
                </button>
              </template>
            </EnvVersionPicker>
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
        :title="t('envs.create.creatingTitle', { name: running?.name })"
        :done-title="t('envs.create.ready', { name: running?.name })"
        :failed-title="t('envs.create.failed')"
        :label="t('envs.create.creating', { name: running?.name })"
        :rows="14"
        flat
        :closable="false"
        :retryable="false"
        @exit="onExit"
      >
        <template #hint>
          {{ t('envs.create.runHint') }}
        </template>
      </EnvTerminal>

      <div v-if="phase === 'done'" class="ec__next">
        <p class="ec__next-lede">{{ t('envs.create.next') }}</p>
        <div class="ec__next-actions">
          <UiButton v-if="running?.components.includes('claude')" @click="finish('login-claude')">
            <LogIn />{{ t('envs.create.signInClaude') }}
          </UiButton>
          <UiButton @click="finish('open-project')"><FolderOpen />{{ t('envs.instance.openProject') }}</UiButton>
        </div>
      </div>
    </div>

    <template #footer>
      <template v-if="phase === 'form'">
        <UiButton variant="ghost" @click="close">{{ t('common.actions.cancel') }}</UiButton>
        <UiButton variant="primary" type="submit" form="env-create-form" :disabled="!host">{{ t('envs.create.submit') }}</UiButton>
      </template>
      <UiButton v-else-if="phase === 'running'" variant="ghost" @click="stop">{{ t('envs.common.stop') }}</UiButton>
      <template v-else-if="phase === 'failed'">
        <UiButton variant="ghost" @click="close">{{ t('common.actions.close') }}</UiButton>
        <UiButton @click="back">{{ t('envs.create.backToSettings') }}</UiButton>
      </template>
      <UiButton v-else variant="primary" data-autofocus @click="finish(null)">{{ t('common.actions.done') }}</UiButton>
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

/* A versioned component's version, under its text (checkbox 14px + the gap). */
.ec__item { display: grid; justify-items: start; }
.ec__item > .ec__ver-anchor { margin: 0 0 6px calc(14px + var(--space-2)); max-width: calc(100% - 14px - var(--space-2)); }
.ec__ver {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  height: 24px;
  padding: 0 6px 0 var(--space-2);
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  color: var(--fg-muted);
  transition: border-color var(--dur-fast) var(--ease-out);
}
.ec__ver:hover { border-color: var(--line-strong); }
.ec__ver.is-open { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.ec__ver:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.ec__ver-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.ec__ver-label.is-picked { color: var(--fg); }
.ec__ver svg { flex: none; width: 13px; height: 13px; color: var(--fg-subtle); }

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
