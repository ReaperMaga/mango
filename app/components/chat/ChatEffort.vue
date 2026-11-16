<script setup lang="ts">
import { effortLabel } from '~/types/chat'
import { useOverlay } from '~/composables/useOverlay'

/**
 * Reasoning effort as a slider: one stop per level the model accepts, lowest on the
 * left. "Default" leaves it to the CLI; the slider then shows the CLI's own level
 * (when it says), and moving it picks a level explicitly. Only a placeholder
 * position (the CLI never said) is drawn in a muted tone.
 * The popover is teleported to <body> with fixed coordinates, like UiMenu.
 */
const props = defineProps<{
  efforts: string[]
  /** null: the CLI's default */
  modelValue: string | null
  /** The level the CLI uses by default, when known. */
  fallback?: string
  agentName: string
}>()
const emit = defineEmits<{ 'update:modelValue': [effort: string | null] }>()

const open = ref(false)
useOverlay(() => open.value)
const root = ref<HTMLElement | null>(null)
const pop = ref<HTMLElement | null>(null)
const range = ref<HTMLInputElement | null>(null)
const pos = ref({ left: 0, bottom: 0 })
const WIDTH = 300
const GAP = 6
const MARGIN = 8

const last = computed(() => Math.max(1, props.efforts.length - 1))
const isDefault = computed(() => !props.modelValue)
/** Default with no level from the CLI: the thumb is only a placeholder. */
const isUnknown = computed(() => isDefault.value && !props.efforts.includes(props.fallback ?? ''))
/** Where the thumb sits: the chosen level, else the CLI's default, else the middle. */
const index = computed(() => {
  const at = props.efforts.indexOf(props.modelValue ?? props.fallback ?? '')
  return at >= 0 ? at : Math.floor(last.value / 2)
})
const fraction = computed(() => index.value / last.value)

const HINTS: Record<string, string> = {
  none: 'No extra thinking',
  minimal: 'Barely thinks; fastest',
  low: 'Quickest answers, least thinking',
  medium: 'Balanced speed and depth',
  high: 'Thinks carefully; slower',
  xhigh: 'Deep thinking for hard problems',
  max: 'Thinks longest; slowest and uses the most quota',
}
const valueText = computed(() => {
  if (!isDefault.value) return effortLabel(props.modelValue!)
  return props.fallback ? `Default (${effortLabel(props.fallback).toLowerCase()})` : 'Default'
})
const hint = computed(() => {
  if (isDefault.value) return props.fallback ? `${props.agentName} picks its usual level` : `Whatever ${props.agentName} is set to`
  return HINTS[props.modelValue!] ?? ''
})

function set(i: number) {
  const level = props.efforts[i]
  if (level && level !== props.modelValue) emit('update:modelValue', level)
}
const onInput = (e: Event) => set(Number((e.target as HTMLInputElement).value))

function place() {
  const r = root.value?.getBoundingClientRect()
  if (!r) return
  const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - WIDTH - MARGIN))
  pos.value = { left, bottom: window.innerHeight - r.top + GAP }
}
async function show() {
  place()
  open.value = true
  await nextTick()
  range.value?.focus({ preventScroll: true })
}
function close(refocus = false) {
  if (!open.value) return
  open.value = false
  if (refocus) root.value?.querySelector<HTMLElement>('button')?.focus()
}
const toggle = () => (open.value ? close() : show())

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' || e.key === 'Enter') {
    // Escape here closes the popover; it must not reach the pane, which would stop the agent.
    e.preventDefault()
    e.stopPropagation()
    close(true)
  } else if (e.key === 'Tab' && !e.shiftKey && e.target === pop.value?.querySelector('.ef__default')) {
    e.preventDefault()
    close(true)
  }
}
function onDocDown(e: MouseEvent) {
  const t = e.target as Node
  if (open.value && !root.value?.contains(t) && !pop.value?.contains(t)) close()
}
function onViewportChange(e: Event) {
  if (!open.value || (e.type === 'scroll' && pop.value?.contains(e.target as Node))) return
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
</script>

<template>
  <div ref="root" class="ef-anchor">
    <slot :open="open" :toggle="toggle" />
    <Teleport to="body">
      <Transition name="ef">
        <div
          v-if="open"
          ref="pop"
          class="ef"
          :class="{ 'is-unknown': isUnknown }"
          role="dialog"
          aria-label="Reasoning effort"
          :style="{ width: `${WIDTH}px`, left: `${pos.left}px`, bottom: `${pos.bottom}px`, '--f': fraction }"
          @keydown="onKey"
        >
          <div class="ef__head">
            <span class="ef__title">Effort</span>
            <span class="ef__value" aria-live="polite">{{ valueText }}</span>
          </div>
          <input
            ref="range"
            class="ef__range"
            type="range"
            min="0"
            :max="efforts.length - 1"
            step="1"
            :value="index"
            :aria-valuetext="valueText"
            aria-label="Effort level"
            @input="onInput"
          >
          <div class="ef__ticks">
            <button
              v-for="(level, i) in efforts"
              :key="level"
              type="button"
              tabindex="-1"
              class="ef__tick"
              :class="{ 'is-on': !isDefault && i === index, 'is-first': i === 0, 'is-last': i === efforts.length - 1 }"
              :style="{ '--at': i / last }"
              @click="set(i)"
            >
              {{ effortLabel(level) }}
            </button>
          </div>
          <div class="ef__foot">
            <span class="ef__hint">{{ hint }}</span>
            <button
              type="button"
              class="ef__default"
              :aria-pressed="isDefault"
              :title="`Let ${agentName} decide`"
              @click="emit('update:modelValue', null)"
            >
              Default
            </button>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.ef-anchor { display: inline-flex; min-width: 0; }
</style>

<!-- The popover lives in <body>, outside this component's scoped subtree. -->
<style>
.ef {
  --thumb: 14px;
  --fill: var(--accent);
  position: fixed;
  z-index: 80;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-width: calc(100vw - 16px);
  padding: var(--space-3) var(--space-3) var(--space-2);
  background: var(--bg-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  font-size: var(--text-sm);
  transform-origin: bottom left;
}
.ef.is-unknown { --fill: var(--fg-faint); }
.ef__head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-2); }
.ef__title { font-weight: 560; color: var(--fg); }
.ef__value { font-size: var(--text-xs); color: var(--fg-muted); }
.ef:not(.is-unknown) .ef__value { color: var(--accent-ink); font-weight: 540; }

.ef__range {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 20px;
  margin: 2px 0 0;
  background: transparent;
  cursor: pointer;
}
.ef__range:focus-visible { outline: none; }
/* Filled up to the thumb's centre, which travels between half a thumb from either end. */
.ef__range::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: var(--radius-pill);
  background: linear-gradient(
    to right,
    var(--fill) 0 calc(var(--thumb) / 2 + (100% - var(--thumb)) * var(--f)),
    var(--line-strong) calc(var(--thumb) / 2 + (100% - var(--thumb)) * var(--f)) 100%
  );
}
.ef__range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: var(--thumb);
  height: var(--thumb);
  margin-top: calc((4px - var(--thumb)) / 2);
  border-radius: 50%;
  background: var(--fill);
  border: 2px solid var(--bg-raised);
  box-shadow: 0 0 0 1px var(--fill), 0 1px 3px rgb(0 0 0 / 0.25);
  transition: transform var(--dur-fast) var(--ease-out);
}
.ef__range:active::-webkit-slider-thumb { transform: scale(1.12); }
.ef__range:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 1px var(--fill), 0 0 0 4px var(--focus-ring); }
.ef__range::-moz-range-track { height: 4px; border-radius: var(--radius-pill); background: var(--line-strong); }
.ef__range::-moz-range-progress { height: 4px; border-radius: var(--radius-pill); background: var(--fill); }
.ef__range::-moz-range-thumb { width: var(--thumb); height: var(--thumb); border-radius: 50%; background: var(--fill); border: 2px solid var(--bg-raised); }

.ef__ticks { position: relative; height: 18px; margin-top: -4px; }
.ef__tick {
  position: absolute;
  top: 0;
  left: calc(var(--thumb) / 2 + (100% - var(--thumb)) * var(--at));
  transform: translateX(-50%);
  padding: 0 2px;
  border-radius: var(--radius-xs);
  font-size: var(--text-2xs);
  white-space: nowrap;
  color: var(--fg-subtle);
  transition: color var(--dur-fast) var(--ease-out);
}
.ef__tick.is-first { left: 0; transform: none; }
.ef__tick.is-last { left: auto; right: 0; transform: none; }
.ef__tick:hover { color: var(--fg); }
.ef__tick.is-on { color: var(--accent-ink); font-weight: 560; }

.ef__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--line-soft);
}
.ef__hint { min-width: 0; font-size: var(--text-xs); line-height: var(--leading-tight); color: var(--fg-subtle); }
.ef__default {
  flex: none;
  height: 24px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  font-size: var(--text-xs);
  font-weight: 540;
  color: var(--fg-muted);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.ef__default:hover { background: var(--bg-hover); color: var(--fg); }
.ef__default[aria-pressed='true'] { background: var(--bg-active); color: var(--fg); border-color: var(--line-strong); }
.ef__default:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }

.ef-enter-active, .ef-leave-active { transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out); }
.ef-enter-from, .ef-leave-to { opacity: 0; transform: scale(0.97); }

@media (prefers-reduced-motion: reduce) {
  .ef__range::-webkit-slider-thumb, .ef__tick, .ef__default, .ef-enter-active, .ef-leave-active { transition: none; }
}
</style>
