<script setup lang="ts">
import type { PluginRunStatus } from '~/plugin-host/types'

/**
 * A plugin's run state as a small mark and a word (The Two-Grade Rule: the mark in `ripe-*`, the word
 * in `ripe-*-fg`). Off and paused are hollow, starting is half full, the rest are full.
 */
const props = defineProps<{ status: PluginRunStatus | null | undefined }>()

const LOOK: Record<PluginRunStatus, { word: string; tone: string; fill: 'none' | 'half' | 'full' }> = {
  active: { word: 'Active', tone: 'done', fill: 'full' },
  loading: { word: 'Starting…', tone: 'running', fill: 'half' },
  error: { word: 'Failed', tone: 'error', fill: 'full' },
  incompatible: { word: 'Needs a newer Mango', tone: 'waiting', fill: 'full' },
  paused: { word: 'Paused', tone: 'queued', fill: 'none' },
  disabled: { word: 'Off', tone: 'idle', fill: 'none' },
}
const look = computed(() => LOOK[props.status ?? 'disabled'])
</script>

<template>
  <span class="pst" :class="[`pst--${look.tone}`, `pst--${look.fill}`]">
    <span class="pst__mark" aria-hidden="true" />{{ look.word }}
  </span>
</template>

<style scoped>
.pst {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-xs);
  font-weight: 560;
  white-space: nowrap;
  color: var(--tone-fg);
}
.pst__mark {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1.25px var(--tone);
  transition: background var(--dur-med) var(--ease-out), box-shadow var(--dur-med) var(--ease-out);
}
.pst--full .pst__mark { background: var(--tone); }
.pst--half .pst__mark { background: linear-gradient(to top, var(--tone) 50%, transparent 50%); }
.pst--done { --tone: var(--ripe-done); --tone-fg: var(--ripe-done-fg); }
.pst--running { --tone: var(--ripe-running); --tone-fg: var(--ripe-running-fg); }
.pst--error { --tone: var(--ripe-error); --tone-fg: var(--ripe-error-fg); }
.pst--waiting { --tone: var(--ripe-waiting); --tone-fg: var(--ripe-waiting-fg); }
.pst--queued { --tone: var(--ripe-queued); --tone-fg: var(--ripe-queued-fg); }
.pst--idle { --tone: var(--ripe-idle); --tone-fg: var(--fg-subtle); }
</style>
