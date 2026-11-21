<script setup lang="ts">
/**
 * The app mark: a kidney-shaped mango split down its ridge into two halves (two
 * chats side by side), the left in the accent, the right a step lighter and
 * warmer, with the leaf in unripe green. Same geometry as assets/icon.svg (the
 * source for the app icons), which uses fixed colours.
 */
withDefaults(defineProps<{ size?: number }>(), { size: 18 })

const maskId = useId()
</script>

<template>
  <svg class="mark" :width="size" :height="size" viewBox="5 1.2 56.6 56.6" role="img" aria-label="Mango">
    <defs>
      <mask :id="maskId" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
        <path fill="#fff" d="M37 10C50.5 9.4 58.6 20.6 57 34.5C55.5 47.8 45.2 57 32.6 57.2C22.8 57.4 13.6 53.6 10.4 46.2C8.4 41.2 12.2 35.6 17.6 30C22.6 24.8 25 13.2 37 10Z" />
        <path d="M37.4 7C31.6 21 31.2 40 36.4 60" fill="none" stroke="#000" stroke-width="3.6" stroke-linecap="round" />
      </mask>
    </defs>
    <g :mask="`url(#${maskId})`">
      <rect class="mark__flesh" width="64" height="64" />
      <path class="mark__light" d="M37.4 0V7C31.6 21 31.2 40 36.4 60V64H64V0Z" />
    </g>
    <path class="mark__leaf" d="M36.4 10.6C37 4.6 43 .8 51.8 1.8C50.6 8.2 44.4 12 36.4 10.6Z" />
  </svg>
</template>

<style scoped>
.mark { display: block; flex: none; }
.mark__flesh { fill: var(--accent); }
/* The lighter half: the accent, lighter and turned towards gold. The phone computes
   the same colour (`markLight` in mobile/scripts/schemes.ts). Older webviews without
   relative colours get a plain lighter accent. */
.mark__light { fill: color-mix(in oklch, var(--accent) 62%, white); }
@supports (color: oklch(from red l c h)) {
  .mark__light { fill: oklch(from var(--accent) calc(l + 0.07) calc(c * 0.85) calc(h + 20)); }
}
.mark__leaf { fill: var(--ripe-queued); }
</style>
