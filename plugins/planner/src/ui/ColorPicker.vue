<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { usePlanner } from '../context.ts'
import { isCustomColor, NAMED_COLORS, readColor, type Color } from '../model.ts'
import { strings } from '../values/strings.ts'
import { colorVar, rawColor } from './colors.ts'
import { hexToHsv, hsvToHex, type Hsv } from './hsv.ts'

/**
 * A named colour or any other. `update:modelValue` follows every move (save it deferred), `change` comes once it is
 * settled (flush it). Also when it closes in the middle of one.
 */
const props = defineProps<{ modelValue: Color; label: string }>()
const emit = defineEmits<{ 'update:modelValue': [color: Color]; change: [color: Color] }>()
const { mango } = usePlanner()

const RECENT = 'recentColors'
const RECENT_MAX = 8
function readRecent(): Color[] {
  const kept = mango.storage.get<unknown>(RECENT)
  return (Array.isArray(kept) ? kept : []).map(readColor).filter((c): c is Color => c !== null && isCustomColor(c)).slice(0, RECENT_MAX)
}
const recent = ref(readRecent())

const root = ref<HTMLElement | null>(null)
const area = ref<HTMLElement | null>(null)

/** What a token is on screen right now, so that a custom colour starts from the named one. */
function shownHex(color: Color): string {
  if (isCustomColor(color)) return color
  try {
    const probe = document.createElement('span')
    probe.style.color = rawColor(color)
    document.body.append(probe)
    const css = getComputedStyle(probe).color
    probe.remove()
    const ctx = document.createElement('canvas').getContext('2d')!
    ctx.fillStyle = css
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
    return `#${[r, g, b].map(v => v!.toString(16).padStart(2, '0')).join('')}`
  } catch {
    return '#808080'
  }
}

/** Kept apart from the hex, which forgets the hue of greys. */
const hsv = ref<Hsv>(hexToHsv(shownHex(props.modelValue)))
const hexText = ref(isCustomColor(props.modelValue) ? props.modelValue : '')
const hexBad = ref(false)
watch(() => props.modelValue, (c) => {
  hexBad.value = false
  if (!isCustomColor(c)) hexText.value = ''
  else if (hsvToHex(hsv.value) !== c) {
    hexText.value = c
    hsv.value = hexToHsv(c)
  }
})

let pending: Color | null = null
function live(color: Color) {
  pending = color
  emit('update:modelValue', color)
}
function settle() {
  if (pending === null) return
  const color = pending
  pending = null
  if (isCustomColor(color)) {
    recent.value = [color, ...readRecent().filter(c => c !== color)].slice(0, RECENT_MAX)
    mango.storage.set(RECENT, [...recent.value])
  }
  emit('change', color)
}
function choose(color: Color) {
  hsv.value = hexToHsv(shownHex(color))
  live(color)
  settle()
}
function setHsv(next: Partial<Hsv>) {
  hsv.value = { ...hsv.value, ...next }
  const hex = hsvToHex(hsv.value)
  hexText.value = hex
  live(hex)
}
onBeforeUnmount(settle)

/* ---------- area and hue */

const hue = computed(() => `hsl(${hsv.value.h} 100% 50%)`)
const clamp = (n: number) => Math.min(1, Math.max(0, n))
let dragging = false
function toPoint(e: PointerEvent) {
  const r = area.value!.getBoundingClientRect()
  setHsv({ s: clamp((e.clientX - r.left) / r.width), v: 1 - clamp((e.clientY - r.top) / r.height) })
}
function onDown(e: PointerEvent) {
  if (e.button !== 0) return
  dragging = true
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  toPoint(e)
}
function onMove(e: PointerEvent) {
  if (dragging) toPoint(e)
}
function onUp() {
  if (!dragging) return
  dragging = false
  settle()
}
function onAreaKey(e: KeyboardEvent) {
  const by = e.shiftKey ? 0.1 : 0.02
  const { s, v } = hsv.value
  const next = ({ ArrowLeft: { s: s - by }, ArrowRight: { s: s + by }, ArrowUp: { v: v + by }, ArrowDown: { v: v - by } } as Record<string, Partial<Hsv>>)[e.key]
  if (!next) return
  e.preventDefault()
  setHsv({ s: clamp(next.s ?? s), v: clamp(next.v ?? v) })
}
function onKeyUp(e: KeyboardEvent) {
  if (e.key.startsWith('Arrow') || ['Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) settle()
}

/* ---------- hex */

function typeHex(e: Event) {
  hexText.value = (e.target as HTMLInputElement).value
  hexBad.value = false
  // Three digits may be the start of six: only Enter or leaving takes those.
  if (hexText.value.trim().replace('#', '').length === 6) takeHex(false)
}
function takeHex(done: boolean) {
  const t = hexText.value.trim()
  const c = t ? readColor(t) : null
  if (c && isCustomColor(c)) {
    if (c !== props.modelValue || pending) {
      hsv.value = hexToHsv(c)
      live(c)
    }
    if (done) {
      hexText.value = c
      settle()
    }
  } else if (done && t) hexBad.value = true
}

/* ---------- swatches */

const swatches = computed<Color[]>(() => [...NAMED_COLORS, ...recent.value])
const nameOf = (c: Color) => (isCustomColor(c) ? c : strings.colors[c])
const tabStop = computed(() => (swatches.value.includes(props.modelValue) ? props.modelValue : 'neutral'))
function onSwatchKey(e: KeyboardEvent, i: number) {
  const n = swatches.value.length
  const to = ({ ArrowRight: i + 1, ArrowLeft: i - 1, ArrowDown: i + 8, ArrowUp: i - 8 } as Record<string, number>)[e.key]
  if (to === undefined) return
  e.preventDefault()
  const next = e.key === 'ArrowDown' || e.key === 'ArrowUp' ? Math.min(n - 1, Math.max(0, to)) : (to + n) % n
  root.value?.querySelectorAll<HTMLElement>('.pl-color__swatch')[next]?.focus()
}
</script>

<template>
  <div ref="root" class="pl-color" role="group" :aria-label="label">
    <div class="pl-color__swatches" role="radiogroup" :aria-label="label">
      <button
        v-for="(c, i) in swatches"
        :key="c"
        type="button"
        role="radio"
        class="pl-color__swatch"
        :aria-checked="c === modelValue"
        :aria-label="nameOf(c)"
        :title="nameOf(c)"
        :tabindex="c === tabStop ? 0 : -1"
        :data-autofocus="c === tabStop ? '' : undefined"
        @click="choose(c)"
        @keydown="onSwatchKey($event, i)"
      ><span :style="{ background: isCustomColor(c) ? c : colorVar(c).dot }" /></button>
    </div>
    <div
      ref="area"
      class="pl-color__area"
      role="slider"
      tabindex="0"
      :aria-label="strings.saturation"
      :aria-valuenow="Math.round(hsv.s * 100)"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuetext="strings.saturationValue(Math.round(hsv.s * 100), Math.round(hsv.v * 100))"
      :style="{ '--pl-hue': hue }"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
      @keydown="onAreaKey"
      @keyup="onKeyUp"
      @blur="settle"
    >
      <span class="pl-color__thumb" :style="{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hsvToHex(hsv) }" />
    </div>
    <input
      type="range"
      class="pl-color__hue"
      min="0"
      max="359"
      step="1"
      :value="Math.round(hsv.h) % 360"
      :aria-label="strings.hue"
      @input="setHsv({ h: Number(($event.target as HTMLInputElement).value) })"
      @change="settle"
    >
    <label class="pl-color__hex" :class="{ 'is-bad': hexBad }">
      <span :style="{ background: rawColor(modelValue) }" aria-hidden="true" />
      <input
        :value="hexText"
        type="text"
        maxlength="9"
        spellcheck="false"
        autocomplete="off"
        placeholder="#rrggbb"
        :aria-label="strings.hex"
        :aria-invalid="hexBad || undefined"
        @input="typeHex"
        @change="takeHex(true)"
        @keydown.enter.prevent="takeHex(true)"
      >
    </label>
  </div>
</template>

<style scoped>
.pl-color { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-2); padding: var(--space-2); }
.pl-color__swatches { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: 2px; }
.pl-color__swatch { display: grid; place-items: center; height: 26px; border: 1px solid transparent; border-radius: var(--radius-sm); }
.pl-color__swatch:hover { background: var(--bg-hover); }
.pl-color__swatch[aria-checked='true'] { border-color: var(--line-strong); background: var(--bg-active); }
.pl-color__swatch span { width: 13px; height: 13px; border-radius: 50%; box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--fg) 18%, transparent); }
/* A colour field is made of gradients: here they are the content. */
.pl-color__area {
  position: relative;
  height: 112px;
  border-radius: var(--radius-sm);
  background: linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, var(--pl-hue));
  cursor: crosshair;
  touch-action: none;
}
.pl-color__area:focus-visible { outline-offset: 2px; border-radius: var(--radius-sm); }
.pl-color__thumb { position: absolute; width: 14px; height: 14px; margin: -7px 0 0 -7px; border: 2px solid #fff; border-radius: 50%; box-shadow: 0 1px 3px rgb(0 0 0 / 0.5); pointer-events: none; }
.pl-color__hue { width: 100%; height: 12px; margin: 2px 0; appearance: none; border-radius: var(--radius-pill); background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00); cursor: pointer; }
.pl-color__hue:focus-visible { outline-offset: 2px; border-radius: var(--radius-pill); }
.pl-color__hue::-webkit-slider-thumb { appearance: none; width: 14px; height: 14px; border: 2px solid #fff; border-radius: 50%; background: transparent; box-shadow: 0 1px 3px rgb(0 0 0 / 0.5); }
.pl-color__hex { display: flex; align-items: center; gap: var(--space-2); height: 30px; padding: 0 var(--space-2); background: var(--bg-inset); border: 1px solid var(--line); border-radius: var(--radius-sm); }
.pl-color__hex:focus-within { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.pl-color__hex.is-bad { border-color: color-mix(in oklch, var(--ripe-error) 60%, transparent); }
.pl-color__hex span { width: 14px; height: 14px; border-radius: 4px; flex: none; box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--fg) 18%, transparent); }
.pl-color__hex input { flex: 1; min-width: 0; height: 100%; padding: 0; border: 0; background: none; font-family: var(--font-mono); font-size: var(--text-xs); }
.pl-color__hex input::placeholder { color: var(--fg-faint); }
.pl-color__hex input:focus-visible { outline: none; }
</style>
