<script setup lang="ts">
/**
 * Opens and closes a block by easing its height (and fading it), for content shown with `v-if`/`v-show`
 * inside it: tool output, thinking, folded steps, an answered approval. The block is measured as it really is,
 * then animated from nothing to that (and back), its padding and margins folding too, so nothing jumps at
 * either end. Extra attributes reach the Transition (`mode="out-in"` swaps one block for another).
 * Durations follow the motion tokens, so reduced motion collapses them like everything else.
 */
import { DUR, EASE_OUT, motionMs } from '~/utils/motion'

type Box = Record<'height' | 'paddingTop' | 'paddingBottom' | 'marginTop' | 'marginBottom' | 'opacity', string>
const CLOSED: Box = { height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px', opacity: '0' }

function measure(el: HTMLElement): Box {
  const cs = getComputedStyle(el)
  return {
    height: `${el.offsetHeight}px`,
    paddingTop: cs.paddingTop,
    paddingBottom: cs.paddingBottom,
    marginTop: cs.marginTop,
    marginBottom: cs.marginBottom,
    opacity: cs.opacity,
  }
}

function run(el: Element, frames: Box[], ms: number, done: () => void) {
  const box = el as HTMLElement
  box.style.overflow = 'hidden'
  const a = box.animate(frames, { duration: motionMs(ms), easing: EASE_OUT })
  const end = () => { box.style.overflow = ''; done() }
  a.onfinish = end
  a.oncancel = end
}

function enter(el: Element, done: () => void) { run(el, [CLOSED, measure(el as HTMLElement)], DUR.med, done) }
function leave(el: Element, done: () => void) { run(el, [measure(el as HTMLElement), CLOSED], DUR.fast, done) }
/** Toggled again mid-way: drop the running animation so the next one starts from where the block is. */
function stop(el: Element) { (el as HTMLElement).getAnimations().forEach(a => a.cancel()) }
</script>

<template>
  <Transition :css="false" @enter="enter" @leave="leave" @enter-cancelled="stop" @leave-cancelled="stop">
    <slot />
  </Transition>
</template>
