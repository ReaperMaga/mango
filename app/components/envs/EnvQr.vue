<script setup lang="ts">
import { encode } from 'uqr'
import { useWorkspace } from '~/stores/workspace'

/**
 * A QR code of `value` (a share link), drawn as one SVG path. Phones read dark
 * modules on a light ground far more reliably than the reverse, so the plate is
 * always the light theme's panel with its ink, whatever the app's theme: the
 * plate carries `data-theme="light"` and the current scheme, and tokens.css
 * re-derives the light theme inside it.
 */
const props = defineProps<{ value: string; label: string }>()
const ws = useWorkspace()

const qr = computed(() => {
  // L is enough on a screen; uqr raises it when that doesn't make the code bigger.
  const { size, data } = encode(props.value, { ecc: 'L', boostEcc: true, border: 0 })
  let d = ''
  for (let y = 0; y < size; y++) {
    const row = data[y]!
    let x = 0
    while (x < size) {
      if (!row[x]) { x++; continue }
      const start = x
      while (x < size && row[x]) x++
      d += `M${start} ${y}h${x - start}v1h${start - x}z`
    }
  }
  return { size, d }
})
</script>

<template>
  <div class="qr-theme" data-theme="light">
    <div class="qr" :data-scheme="ws.scheme">
      <svg
        class="qr__code"
        :viewBox="`0 0 ${qr.size} ${qr.size}`"
        role="img"
        :aria-label="label"
        shape-rendering="crispEdges"
      >
        <path :d="qr.d" />
      </svg>
    </div>
  </div>
</template>

<style scoped>
.qr-theme { display: contents; }
.qr {
  display: grid;
  place-items: center;
  /* The quiet zone a scanner needs: about four modules at the usual sizes. */
  padding: var(--space-3);
  background: var(--bg-panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
}
.qr__code { display: block; width: 100%; height: auto; }
.qr__code path { fill: var(--fg); }
</style>
