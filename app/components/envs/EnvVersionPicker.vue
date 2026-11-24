<script setup lang="ts">
import { Check, RefreshCw, Search } from 'lucide-vue-next'
import { envDefaultVersion, useEnvironments } from '~/stores/environments'
import type { EnvComponentId, EnvVersion } from '~/types/ipc'
import { formatLocale } from '~/i18n'
import { useOverlay } from '~/composables/useOverlay'

/**
 * Pick a version of a component that has them (Node.js, Java): a search field over every
 * version the source offers, grouped by release line or vendor. The list is fetched once a
 * session (`envs.loadVersions`). Like UiMenu, the popup is teleported to <body> with fixed
 * coordinates; the trigger is the default slot, given `{ open, toggle }`.
 */
const props = withDefaults(defineProps<{
  component: EnvComponentId
  /** The component's name, for labels ("Node.js"). */
  name: string
  /** The picked version's id; null is the default. */
  selected?: string | null
  /** The installed version's id, marked in the list. */
  installed?: string | null
  /** Offer "Default" as the first row (picking it emits null). */
  allowDefault?: boolean
  placement?: 'bottom-start' | 'bottom-end'
}>(), { selected: null, installed: null, allowDefault: false, placement: 'bottom-start' })

const emit = defineEmits<{ pick: [id: string | null] }>()

const { t } = useI18n()
const envs = useEnvironments()
const open = ref(false)
useOverlay(() => open.value)

const root = ref<HTMLElement | null>(null)
const pop = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const scroller = ref<HTMLElement | null>(null)
const query = ref('')
const active = ref(-1)
const uid = `vp-${Math.random().toString(36).slice(2, 8)}`

const all = computed(() => envs.versions[props.component] ?? null)
const loading = computed(() => !!envs.loadingVersions[props.component])
const error = computed(() => envs.versionErrors[props.component] ?? null)
const source = computed(() => (props.component === 'java' ? 'SDKMAN' : 'nodejs.org'))
const defaultName = computed(() => envDefaultVersion(props.component))
const defaultVersion = computed(() => all.value?.find(v => v.default) ?? null)

/* ---------- filtering: every word must appear (vendor, line, version, identifier or note) ---------- */

const words = computed(() => query.value.toLowerCase().split(/\s+/).filter(Boolean))
const hay = (v: EnvVersion) => `${v.group} ${v.version} ${v.id} ${v.note ?? ''} ${v.default ? t('envs.common.default') : ''}`.toLowerCase()
/** A number ("21", "22.11") is the start of the version, so 21 finds Java 21 and not 17.0.21. */
const numeric = /^\d+(\.\d+)*\.?$/
const matches = (v: EnvVersion, word: string) => (numeric.test(word) ? v.version.startsWith(word) : hay(v).includes(word))

/** What can be picked, in order: null is the default row. */
const options = computed<Array<EnvVersion | null>>(() => {
  const w = words.value
  const list = (all.value ?? []).filter(v => w.every(word => matches(v, word)))
  const withDefault = props.allowDefault && (!w.length || w.every(word => `${t('envs.common.default')} ${defaultName.value}`.toLowerCase().includes(word)))
  return withDefault ? [null, ...list] : list
})

/** Rows to draw: group headings between the options. */
type Row = { kind: 'group'; key: string; label: string; count: number } | { kind: 'option'; key: string; at: number; v: EnvVersion | null }
const rows = computed<Row[]>(() => {
  const out: Row[] = []
  let group: string | null = null
  const counts = new Map<string, number>()
  for (const v of options.value) if (v) counts.set(v.group, (counts.get(v.group) ?? 0) + 1)
  options.value.forEach((v, at) => {
    if (v && v.group !== group) {
      group = v.group
      out.push({ kind: 'group', key: `g:${group}`, label: group, count: counts.get(group) ?? 0 })
    }
    out.push({ kind: 'option', key: v ? `v:${v.id}` : 'default', at, v })
  })
  return out
})

const optionId = (at: number) => `${uid}-o${at}`
const isSelected = (v: EnvVersion | null) => (v ? v.id === props.selected : props.selected == null && props.allowDefault)

watch(words, () => { active.value = options.value.length ? 0 : -1 })
watch(all, () => { if (open.value) focusCurrent() })

/** Highlight the picked (or installed) version, else the first row. */
function focusCurrent() {
  const want = props.selected ?? props.installed
  let at = want ? options.value.findIndex(v => v?.id === want) : -1
  if (at < 0 && props.selected == null && props.allowDefault) at = 0
  active.value = at >= 0 ? at : (options.value.length ? 0 : -1)
  nextTick(() => reveal('center'))
}

function reveal(block: ScrollLogicalPosition = 'nearest') {
  if (active.value < 0) return
  document.getElementById(optionId(active.value))?.scrollIntoView({ block })
}

/* ---------- placement (as UiMenu) ---------- */

const WIDTH = 380
const GAP = 6
const MARGIN = 8
const pos = ref<{ left: number; top?: number; bottom?: number; maxHeight: number; origin: string }>({ left: 0, top: 0, maxHeight: 420, origin: 'top left' })

function place() {
  const r = root.value?.getBoundingClientRect()
  if (!r) return
  const vw = window.innerWidth
  const vh = window.innerHeight
  const width = Math.min(WIDTH, vw - MARGIN * 2)
  const end = props.placement.endsWith('end')
  const left = Math.max(MARGIN, Math.min(end ? r.right - width : r.left, vw - width - MARGIN))
  const below = vh - r.bottom - GAP - MARGIN
  const above = r.top - GAP - MARGIN
  const want = 420
  const up = below < Math.min(want, 300) && above > below
  const maxHeight = Math.min(want, Math.max(180, up ? above : below))
  const origin = `${up ? 'bottom' : 'top'} ${end ? 'right' : 'left'}`
  pos.value = up ? { left, bottom: vh - r.top + GAP, maxHeight, origin } : { left, top: r.bottom + GAP, maxHeight, origin }
}

/* ---------- open, pick, close ---------- */

async function show() {
  query.value = ''
  place()
  open.value = true
  envs.loadVersions(props.component)
  focusCurrent()
  await nextTick()
  input.value?.focus({ preventScroll: true })
}

function close(refocus = false) {
  if (!open.value) return
  open.value = false
  if (refocus) root.value?.querySelector<HTMLElement>('button, [tabindex]')?.focus()
}

function toggle() {
  open.value ? close() : show()
}

function pick(at: number) {
  const v = options.value[at]
  if (v === undefined) return
  close(true)
  emit('pick', v ? v.id : null)
}

function retry() {
  envs.loadVersions(props.component, true)
  input.value?.focus()
}

function onKey(e: KeyboardEvent) {
  const n = options.value.length
  const step = (d: number) => {
    e.preventDefault()
    if (!n) return
    active.value = Math.max(0, Math.min(n - 1, (active.value < 0 ? -1 : active.value) + d))
    nextTick(() => reveal())
  }
  if (e.key === 'ArrowDown') step(1)
  else if (e.key === 'ArrowUp') step(-1)
  else if (e.key === 'PageDown') step(10)
  else if (e.key === 'PageUp') step(-10)
  else if (e.key === 'Enter') { e.preventDefault(); if (active.value >= 0) pick(active.value) }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true) }
  else if (e.key === 'Tab') { e.preventDefault(); close(true) }
}

function onDocDown(e: MouseEvent) {
  if (!open.value) return
  const target = e.target as Node
  if (root.value?.contains(target) || pop.value?.contains(target)) return
  close()
}
/** Scrolling or resizing moves the trigger: close, as UiMenu does. */
function onViewportChange(e: Event) {
  if (!open.value) return
  if (e.type === 'scroll' && pop.value?.contains(e.target as Node)) return
  close()
}

onMounted(() => {
  document.addEventListener('mousedown', onDocDown, true)
  window.addEventListener('scroll', onViewportChange, true)
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('blur', onViewportChange)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocDown, true)
  window.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('blur', onViewportChange)
})

/* ---------- presentation ---------- */

const day = (d: string | null) => {
  if (!d) return null
  const ms = Date.parse(`${d}T00:00:00Z`)
  return Number.isNaN(ms) ? d : new Date(ms).toLocaleDateString(formatLocale(), { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
}
const count = computed(() => (all.value ? options.value.filter(Boolean).length : 0))

defineExpose({ show, close, toggle })
</script>

<template>
  <div ref="root" class="vp-anchor">
    <slot :open="open" :toggle="toggle" />
    <Teleport to="body">
      <Transition name="vp">
        <div
          v-if="open"
          ref="pop"
          class="vp"
          role="dialog"
          :aria-label="t('envs.versions.label', { name })"
          data-own-escape
          :style="{
            left: `${pos.left}px`,
            top: pos.top != null ? `${pos.top}px` : undefined,
            bottom: pos.bottom != null ? `${pos.bottom}px` : undefined,
            maxHeight: `${pos.maxHeight}px`,
            width: `min(${WIDTH}px, calc(100vw - 16px))`,
            transformOrigin: pos.origin,
          }"
          @keydown="onKey"
        >
          <div class="vp__search">
            <Search aria-hidden="true" />
            <input
              ref="input"
              v-model="query"
              type="text"
              role="combobox"
              :placeholder="component === 'java' ? t('envs.versions.searchJava') : t('envs.versions.search')"
              :aria-label="t('envs.versions.searchLabel', { name })"
              aria-autocomplete="list"
              aria-expanded="true"
              :aria-controls="`${uid}-list`"
              :aria-activedescendant="active >= 0 && all ? optionId(active) : undefined"
              spellcheck="false"
              autocomplete="off"
            >
            <span v-if="loading && all" class="vp__spin" aria-hidden="true" />
          </div>

          <div :id="`${uid}-list`" ref="scroller" class="vp__scroll" role="listbox" :aria-label="t('envs.versions.label', { name })" :aria-busy="loading || undefined">
            <template v-if="all">
              <template v-for="r in rows" :key="r.key">
                <div v-if="r.kind === 'group'" class="vp__group" role="presentation">
                  <span>{{ r.label }}</span><span class="vp__group-n tabular">{{ r.count }}</span>
                </div>
                <div
                  v-else
                  :id="optionId(r.at)"
                  class="vp__opt"
                  :class="{ 'is-active': r.at === active, 'is-default-row': !r.v }"
                  role="option"
                  :aria-selected="isSelected(r.v)"
                  @mousemove="active = r.at"
                  @click="pick(r.at)"
                >
                  <span class="vp__mark"><Check v-if="isSelected(r.v)" /></span>
                  <template v-if="r.v">
                    <span class="vp__main">
                      <span class="vp__version tabular">{{ r.v.version }}</span>
                      <span v-if="r.v.note" class="vp__note">{{ r.v.note }}</span>
                      <span v-if="r.v.id === installed" class="vp__tag">{{ t('envs.common.installed') }}</span>
                      <span v-else-if="r.v.default" class="vp__tag">{{ t('envs.common.default') }}</span>
                    </span>
                    <span v-if="component === 'java'" class="vp__aside vp__aside--mono">{{ r.v.id }}</span>
                    <span v-else-if="r.v.date" class="vp__aside tabular">{{ day(r.v.date) }}</span>
                  </template>
                  <span v-else class="vp__main">
                    <span class="vp__version">{{ defaultName }}</span>
                    <span v-if="defaultVersion" class="vp__note tabular">{{ defaultVersion.version }}</span>
                  </span>
                </div>
              </template>
              <p v-if="!options.length" class="vp__empty">{{ t('envs.versions.none', { name, query: query.trim() }) }}</p>
            </template>
            <div v-else-if="error" class="vp__error" role="alert">
              <p>{{ t('envs.versions.failed') }} <span class="selectable">{{ error }}</span></p>
              <UiButton size="sm" :loading="loading" @click="retry"><RefreshCw />{{ t('common.actions.retry') }}</UiButton>
            </div>
            <div v-else class="vp__bones" aria-hidden="true">
              <span v-for="n in 7" :key="n" class="vp__bone" :style="{ width: `${36 + ((n * 23) % 40)}%` }" />
            </div>
          </div>

          <i18n-t v-if="all" :keypath="component === 'java' ? 'envs.versions.fromJava' : 'envs.versions.from'" tag="p" class="vp__foot" scope="global">
            <template #count><span class="tabular">{{ t('envs.versions.count', count) }}</span></template>
            <template #source>{{ source }}</template>
          </i18n-t>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.vp-anchor { position: relative; display: inline-flex; min-width: 0; }
</style>

<!-- The popup lives in <body>, outside this component's scoped subtree. -->
<style>
.vp {
  position: fixed;
  z-index: 80;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  font-size: var(--text-sm);
  overflow: hidden;
}

.vp__search {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 34px;
  margin: var(--space-2) var(--space-2) 0;
  padding: 0 var(--space-2);
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}
.vp__search:focus-within { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.vp__search svg { flex: none; width: 15px; height: 15px; color: var(--fg-subtle); }
.vp__search input { flex: 1; min-width: 0; border: 0; background: transparent; font-size: var(--text-sm); color: var(--fg); }
.vp__search input::placeholder { color: var(--fg-faint); }
.vp__search input:focus-visible { outline: none; }

.vp__scroll { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-1); overscroll-behavior: contain; }

.vp__group {
  position: sticky;
  top: calc(var(--space-1) * -1);
  z-index: 1;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-2) 3px;
  background: var(--bg-raised);
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--fg-subtle);
}
.vp__group-n { font-weight: 500; color: var(--fg-faint); }

.vp__opt {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 30px;
  padding: 4px var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--fg);
  cursor: default;
}
.vp__opt.is-active { background: var(--bg-hover); }
.vp__opt[aria-selected='true'] .vp__version { font-weight: 600; }
.vp__opt.is-default-row { margin-bottom: 2px; }
.vp__mark { flex: none; display: grid; place-items: center; width: 16px; height: 16px; }
.vp__mark svg { width: 14px; height: 14px; color: var(--accent-ink); }
.vp__main { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: var(--space-2); overflow: hidden; white-space: nowrap; }
.vp__version { flex: none; }
.vp__note { min-width: 0; font-size: var(--text-xs); color: var(--fg-subtle); overflow: hidden; text-overflow: ellipsis; }
.vp__tag { flex: none; font-size: var(--text-xs); font-weight: 560; color: var(--accent-ink); }
.vp__aside { flex: 0 1 auto; min-width: 0; max-width: 55%; font-size: var(--text-xs); color: var(--fg-subtle); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vp__aside--mono { font-family: var(--font-mono); font-size: var(--text-2xs); }

.vp__empty { margin: 0; padding: var(--space-4) var(--space-3); font-size: var(--text-xs); color: var(--fg-subtle); }
.vp__error { display: grid; justify-items: start; gap: var(--space-2); padding: var(--space-3); }
.vp__error p { margin: 0; font-size: var(--text-xs); color: var(--ripe-error-fg); overflow-wrap: anywhere; text-wrap: pretty; }

.vp__bones { display: grid; gap: 12px; padding: var(--space-3) var(--space-2) var(--space-3) calc(var(--space-2) + 24px); }
.vp__bone { height: 10px; border-radius: var(--radius-xs); background: var(--bg-hover); }

.vp__foot {
  flex: none;
  margin: 0;
  padding: 6px var(--space-3);
  border-top: 1px solid var(--line-soft);
  font-size: var(--text-2xs);
  color: var(--fg-subtle);
}

.vp__spin {
  flex: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.5px solid var(--fg-subtle);
  border-right-color: transparent;
  animation: vp-turn 0.7s linear infinite;
}
@keyframes vp-turn { to { transform: rotate(360deg); } }

.vp-enter-active, .vp-leave-active { transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out); }
.vp-enter-from, .vp-leave-to { opacity: 0; transform: scale(0.98); }
@media (prefers-reduced-motion: reduce) {
  .vp-enter-active, .vp-leave-active { transition: opacity var(--dur-fast) linear; }
  .vp-enter-from, .vp-leave-to { transform: none; }
  .vp__spin { animation-duration: 2s; }
}
</style>
