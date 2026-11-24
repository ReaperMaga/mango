<script setup lang="ts">
import { ArrowUp, ChevronRight, CircleAlert, Folder, FolderGit2, RotateCw } from 'lucide-vue-next'
import type { EnvDirListing } from '~/types/ipc'
import { ENV_WORK_DIR, instanceKey, useEnvironments } from '~/stores/environments'

/**
 * The folders inside an environment, one level at a time: a breadcrumb with a parent button over
 * a list of sub-folders (git repositories marked). Click selects, double-click or Enter goes in,
 * Backspace goes up. `dir` is the folder listed, `selected` the highlighted sub-folder (or null).
 * Starts where it was left in this environment, else in ~/work, else in ~.
 */
const props = withDefaults(defineProps<{
  hostId: string
  instance: string
  /** Rows of list shown before it scrolls. */
  rows?: number
  disabled?: boolean
  /** The action on a row (shown on hover and on the selected row): "Open", "Use". */
  chooseLabel?: string
}>(), { rows: 8, disabled: false, chooseLabel: undefined })

const { t } = useI18n()
const dir = defineModel<string | null>('dir', { default: null })
const selected = defineModel<string | null>('selected', { default: null })
const emit = defineEmits<{ choose: [path: string] }>()

const envs = useEnvironments()
const listing = ref<EnvDirListing | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const listEl = ref<HTMLElement | null>(null)
const uid = useId()

let seq = 0
/** List `path`; with `fallback`, try that one when `path` can't be listed. */
async function go(path: string, fallback?: string) {
  const mine = ++seq
  loading.value = true
  error.value = null
  try {
    const l = await envs.listDir(props.hostId, props.instance, path)
    if (mine !== seq) return
    listing.value = l
    dir.value = l.dir
    selected.value = null
    lastDir.set(instanceKey(props.hostId, props.instance), l.dir)
  } catch (e) {
    if (mine !== seq) return
    if (fallback) return void go(fallback)
    error.value = (e instanceof Error ? e.message : String(e)).replace(/\.$/, '')
  } finally {
    if (mine === seq) loading.value = false
  }
}

function start() {
  listing.value = null
  const last = lastDir.get(instanceKey(props.hostId, props.instance))
  go(last ?? ENV_WORK_DIR, '~')
}
watch(() => instanceKey(props.hostId, props.instance), start, { immediate: true })

const retry = () => go(dir.value ?? listing.value?.dir ?? ENV_WORK_DIR, dir.value ? undefined : '~')
const up = () => { if (listing.value?.parent) go(listing.value.parent) }

/** "/", "home", "agent", "work": each a step back. */
const crumbs = computed(() => {
  const d = listing.value?.dir ?? dir.value
  if (!d) return []
  const parts = d.split('/').filter(Boolean)
  return [{ name: '/', path: '/' }, ...parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join('/')}` }))]
})

const entries = computed(() => listing.value?.entries ?? [])
const optionId = (i: number) => `${uid}-o${i}`
const activeIndex = computed(() => entries.value.findIndex(e => e.path === selected.value))

function select(i: number) {
  const e = entries.value[i]
  if (!e) return
  selected.value = e.path
  nextTick(() => document.getElementById(optionId(i))?.scrollIntoView({ block: 'nearest' }))
}

function onKey(e: KeyboardEvent) {
  if (props.disabled) return
  const n = entries.value.length
  const i = activeIndex.value
  if (e.key === 'ArrowDown' && n) { e.preventDefault(); select(i < 0 ? 0 : Math.min(n - 1, i + 1)) }
  else if (e.key === 'ArrowUp' && n) { e.preventDefault(); select(i < 0 ? n - 1 : Math.max(0, i - 1)) }
  else if (e.key === 'Home' && n) { e.preventDefault(); select(0) }
  else if (e.key === 'End' && n) { e.preventDefault(); select(n - 1) }
  else if (e.key === 'Enter' && i >= 0) { e.preventDefault(); e.stopPropagation(); go(entries.value[i]!.path) }
  else if (e.key === 'Backspace' || (e.key === 'ArrowLeft' && e.altKey)) { e.preventDefault(); up() }
}

defineExpose({ go, focus: () => listEl.value?.focus() })
</script>

<script lang="ts">
/** Where the folder list was left, per environment (for this session). */
const lastDir = new Map<string, string>()
</script>

<template>
  <div class="fol" :class="{ 'is-disabled': disabled }" :style="{ '--rows': rows }">
    <div class="fol__bar">
      <UiIconButton :label="t('project.folders.up')" size="sm" :disabled="disabled || !listing?.parent" @click="up"><ArrowUp /></UiIconButton>
      <nav class="fol__crumbs" :aria-label="t('project.folder')">
        <template v-for="(c, i) in crumbs" :key="c.path">
          <ChevronRight v-if="i > 1" class="fol__sep" aria-hidden="true" />
          <button
            type="button"
            class="fol__crumb"
            :class="{ 'is-current': i === crumbs.length - 1 }"
            :aria-current="i === crumbs.length - 1 ? 'location' : undefined"
            :disabled="disabled"
            :title="c.path"
            @click="go(c.path)"
          >
            {{ c.name }}
          </button>
        </template>
      </nav>
      <UiIconButton :label="t('common.actions.refresh')" size="sm" :disabled="disabled || loading" @click="retry"><RotateCw /></UiIconButton>
    </div>

    <div v-if="error" class="fol__state" role="alert">
      <CircleAlert class="fol__state-icon fol__state-icon--bad" aria-hidden="true" />
      <p class="selectable">{{ t('project.folders.failed') }} {{ error }}.</p>
      <UiButton size="sm" :disabled="disabled" @click="retry">{{ t('common.actions.retry') }}</UiButton>
    </div>
    <div v-else-if="!listing" class="fol__skel" aria-busy="true" :aria-label="t('project.folders.loading')">
      <span v-for="n in 4" :key="n" class="fol__skel-row" :style="{ width: `${[46, 62, 38, 54][n - 1]}%` }" />
    </div>
    <div
      v-else
      ref="listEl"
      class="fol__list"
      :class="{ 'is-loading': loading }"
      role="listbox"
      :aria-label="t('project.folders.list', { path: listing.dir })"
      :aria-busy="loading || undefined"
      :aria-activedescendant="activeIndex >= 0 ? optionId(activeIndex) : undefined"
      :tabindex="disabled ? -1 : 0"
      @keydown="onKey"
    >
      <div
        v-for="(e, i) in entries"
        :id="optionId(i)"
        :key="e.path"
        class="fol__row"
        :class="{ 'is-selected': e.path === selected }"
        role="option"
        :aria-selected="e.path === selected"
        :title="e.path"
        @click="!disabled && select(i)"
        @dblclick="!disabled && go(e.path)"
      >
        <component :is="e.isGit ? FolderGit2 : Folder" class="fol__icon" :class="{ 'is-git': e.isGit }" aria-hidden="true" />
        <span class="fol__name">{{ e.name }}</span>
        <span v-if="e.isGit" class="fol__tag">Git</span>
        <button
          type="button"
          class="fol__open"
          tabindex="-1"
          :aria-label="t('project.folders.chooseNamed', { action: chooseLabel ?? t('common.actions.open'), name: e.name })"
          :disabled="disabled"
          @click.stop="emit('choose', e.path)"
        >
          {{ chooseLabel ?? t('common.actions.open') }}
        </button>
      </div>
      <p v-if="!entries.length" class="fol__empty">{{ t('project.folders.empty') }}</p>
      <p v-else-if="listing.truncated" class="fol__empty">{{ t('project.folders.truncated', { n: entries.length }) }}</p>
    </div>
  </div>
</template>

<style scoped>
.fol {
  --row: 30px;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.fol.is-disabled { opacity: 0.7; }

.fol__bar {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 34px;
  padding: 0 var(--space-1);
  border-bottom: 1px solid var(--line-soft);
}
.fol__crumbs {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.fol__crumb {
  flex: 0 1 auto;
  min-width: 2ch;
  height: 22px;
  padding: 0 5px;
  border-radius: var(--radius-xs);
  color: var(--fg-subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.fol__crumb:hover:not(:disabled) { background: var(--bg-hover); color: var(--fg); }
.fol__crumb.is-current { flex-shrink: 0; color: var(--fg); font-weight: 600; }
.fol__sep { flex: none; width: 12px; height: 12px; color: var(--fg-faint); }

.fol {
  /* The asked-for rows, fewer in a short window, so the dialog around it keeps its fields in view. */
  --list-h: min(calc(var(--rows) * var(--row) + var(--space-2)), max(calc(4 * var(--row)), calc(100vh - 430px)));
}
.fol__list {
  height: var(--list-h);
  overflow-y: auto;
  padding: var(--space-1);
  outline: none;
  transition: opacity var(--dur-fast) var(--ease-out);
}
.fol__list:focus-visible { box-shadow: inset 0 0 0 1.5px var(--focus-ring); }
.fol__list.is-loading { opacity: 0.6; }
.fol__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: var(--row);
  padding: 0 var(--space-1) 0 var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  color: var(--fg-muted);
  cursor: default;
}
.fol__row:hover { background: var(--bg-hover); color: var(--fg); }
.fol__row.is-selected { background: var(--bg-active); color: var(--fg); }
.fol__icon { flex: none; width: 15px; height: 15px; stroke-width: 1.75; color: var(--fg-subtle); }
.fol__icon.is-git { color: var(--fg-muted); }
.fol__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fol__tag { flex: none; font-size: var(--text-2xs); font-weight: 560; color: var(--fg-subtle); }
.fol__open {
  flex: none;
  height: 22px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-xs);
  font-size: var(--text-xs);
  font-weight: 560;
  color: var(--fg-muted);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
.fol__row:hover .fol__open, .fol__row.is-selected .fol__open { opacity: 1; }
.fol__open:hover { background: var(--bg-active); color: var(--fg); }
.fol__empty { margin: 0; padding: var(--space-2); font-size: var(--text-xs); color: var(--fg-subtle); }

.fol__state {
  height: var(--list-h);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-4);
  text-align: center;
  font-size: var(--text-sm);
  color: var(--fg-muted);
}
.fol__state p { margin: 0; max-width: 46ch; line-height: var(--leading-normal); }
.fol__state-icon { width: 18px; height: 18px; stroke-width: 1.75; }
.fol__state-icon--bad { color: var(--ripe-error); }

.fol__skel {
  height: var(--list-h);
  padding: var(--space-1);
  display: flex;
  flex-direction: column;
}
.fol__skel-row {
  height: 10px;
  margin: 10px var(--space-2);
  border-radius: var(--radius-xs);
  background: var(--bg-hover);
  animation: fol-pulse 1.4s var(--ease-in-out) infinite;
}
@keyframes fol-pulse { 50% { opacity: 0.45; } }
@media (prefers-reduced-motion: reduce) { .fol__skel-row { animation: none; } }
</style>
