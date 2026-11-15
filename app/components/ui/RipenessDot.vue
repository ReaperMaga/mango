<script setup lang="ts">
import type { ThreadStatus } from '~/types/chat'

/**
 * Mango's signature status mark: a small fruit whose colour and fill show how
 * ripe a thread is. idle and queued are hollow (grey, then unripe leaf green), running is
 * half-filled mango whose level breathes, waiting is full blush (needs you),
 * done is full gold, error is red.
 */
const props = withDefaults(defineProps<{ status: ThreadStatus; size?: number; unseen?: boolean }>(), { size: 12, unseen: false })

const clipId = useId()
const body = 'M6.6 1.6c2.6.3 4.1 2.6 3.7 5.1-.4 2.4-2.4 3.9-4.6 3.7C3.3 10.2 1.6 8.3 1.8 6c.3-2.6 2.3-4.6 4.8-4.4Z'

const labels: Record<ThreadStatus, string> = {
  idle: 'Idle',
  queued: 'Queued',
  running: 'Working',
  working: 'Working',
  waiting: 'Needs you',
  done: 'Settled',
  error: 'Failed',
}
</script>

<template>
  <span
    class="ripe"
    :class="[`ripe--${props.status}`, { 'ripe--unseen': props.unseen }]"
    :style="{ '--s': `${props.size}px` }"
    role="img"
    :aria-label="labels[props.status]"
    :title="labels[props.status]"
  >
    <svg :width="props.size" :height="props.size" viewBox="0 0 12 12" aria-hidden="true">
      <defs>
        <clipPath :id="clipId">
          <rect class="ripe__level" x="0" y="0" width="12" height="12" />
        </clipPath>
      </defs>
      <!-- mango body: outline always, flesh fills up as the thread ripens -->
      <path class="ripe__skin" :d="body" />
      <path class="ripe__flesh" :d="body" :clip-path="`url(#${clipId})`" />
      <path class="ripe__leaf" d="M6.9 1.9c.3-.9 1.1-1.5 2.2-1.5-.2 1-1 1.6-2.2 1.5Z" />
    </svg>
  </span>
</template>

<style scoped>
.ripe {
  position: relative;
  display: inline-grid;
  place-items: center;
  width: var(--s);
  height: var(--s);
  flex: none;
  --c: var(--ripe-idle);
  --level: 12px; /* y of the fill line: 12 = empty, 0 = full */
}
.ripe svg { display: block; overflow: visible; }
.ripe__skin { fill: none; stroke: var(--c); stroke-width: 1.2; transition: stroke var(--dur-med) var(--ease-out); }
.ripe__flesh { fill: var(--c); stroke: var(--c); stroke-width: 1.2; transition: fill var(--dur-med) var(--ease-out), stroke var(--dur-med) var(--ease-out); }
.ripe__level { transform: translateY(var(--level)); transition: transform var(--dur-slow) var(--ease-out); }
.ripe__leaf { fill: var(--ripe-queued); opacity: 0.9; }

.ripe--idle { --c: var(--ripe-idle); --level: 12px; }
.ripe--idle .ripe__leaf { fill: var(--ripe-idle); }
.ripe--queued { --c: var(--ripe-queued); --level: 12px; }
.ripe--running { --c: var(--ripe-running); --level: 6px; }
.ripe--running .ripe__level { animation: ripen 1.8s var(--ease-in-out) infinite; }
/* Marked as in progress by hand: the same half-ripe fruit, at rest. */
.ripe--working { --c: var(--ripe-running); --level: 6px; }
.ripe--waiting { --c: var(--ripe-waiting); --level: 0px; }
.ripe--done { --c: var(--ripe-done); --level: 0px; }
.ripe--error { --c: var(--ripe-error); --level: 0px; }
.ripe--error .ripe__leaf { fill: var(--ripe-error); opacity: 0.6; }

/* Unseen results and requests get a soft halo ring so they read at a glance. */
.ripe--unseen::after {
  content: '';
  position: absolute;
  inset: -3px;
  border-radius: 50%;
  border: 1.5px solid var(--c);
  opacity: 0.45;
}

/* Running: the flesh level rises and settles, like fruit filling out. */
@keyframes ripen {
  0%, 100% { transform: translateY(7.5px); }
  50% { transform: translateY(4px); }
}
</style>
