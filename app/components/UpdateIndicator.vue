<script setup lang="ts">
import { CircleArrowUp, ExternalLink, RotateCw, Settings } from 'lucide-vue-next'
import type { MenuItem } from '~/types/ui'
import { useUpdater } from '~/stores/updater'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { openExternal } from '~/composables/useBackend'
import { releaseUrl } from '~/utils/releases'

/** Titlebar entry for a newer release: shows while one is available or installing. */
const up = useUpdater()
const ws = useWorkspace()
const threads = useThreads()

const running = computed(() => threads.threads.filter(t => t.status === 'running' || t.status === 'queued').length)

const items = computed<MenuItem[]>(() => {
  const v = up.update?.version
  return [
    {
      label: up.installFailed ? 'Try the update again' : 'Update and restart',
      hint: running.value ? `Stops ${running.value} running chat${running.value === 1 ? '' : 's'}` : v,
      icon: up.installFailed ? RotateCw : CircleArrowUp,
      onSelect: () => up.install(),
    },
    { label: 'Release notes', icon: ExternalLink, onSelect: () => v && openExternal(releaseUrl(v)) },
    { label: 'Update settings', icon: Settings, divider: true, onSelect: () => ws.openSettings('general') },
  ]
})

const label = computed(() => {
  if (up.phase === 'restarting') return 'Restarting…'
  if (up.phase === 'downloading') return up.fraction === null ? 'Updating…' : `Updating ${Math.round(up.fraction * 100)}%`
  if (up.installFailed) return 'Update failed'
  return 'Update'
})
const working = computed(() => up.phase === 'downloading' || up.phase === 'restarting')
const title = computed(() => up.installFailed ? up.error ?? undefined : up.update ? `Mango ${up.update.version} is available` : undefined)
</script>

<template>
  <div v-if="up.update && up.phase !== 'checking' || working" class="upd">
    <span v-if="working" class="upd__btn is-working" role="status" aria-live="polite">
      <CircleArrowUp />
      <span class="tabular">{{ label }}</span>
      <span v-if="up.fraction !== null" class="upd__bar" :style="{ transform: `scaleX(${up.fraction})` }" aria-hidden="true" />
    </span>
    <UiMenu v-else :items="items" :width="250" label="Update">
      <template #default="{ toggle, open }">
        <button
          type="button"
          class="upd__btn"
          :class="{ 'is-open': open, 'is-failed': up.installFailed }"
          aria-haspopup="menu"
          :aria-expanded="open"
          :title="open ? undefined : title"
          @click="toggle"
        >
          <CircleArrowUp />
          <span>{{ label }}</span>
        </button>
      </template>
    </UiMenu>
  </div>
</template>

<style scoped>
.upd { display: flex; margin-right: var(--space-1); }
.upd__btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px 0 6px;
  overflow: hidden;
  border-radius: var(--radius-pill);
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--accent-ink);
  background: var(--accent-soft);
  white-space: nowrap;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.upd__btn svg { width: 13px; height: 13px; stroke-width: 2; flex: none; }
button.upd__btn:hover, .upd__btn.is-open { background: color-mix(in oklch, var(--accent-soft), var(--accent) 12%); }
button.upd__btn:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.upd__btn.is-failed { color: var(--ripe-error-fg); background: var(--bg-hover); }
.upd__btn.is-failed:hover, .upd__btn.is-failed.is-open { background: var(--bg-active); }
.upd__btn.is-working { cursor: default; }

/* Download progress along the bottom edge of the pill. */
.upd__bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: var(--accent);
  transform-origin: left;
  transition: transform var(--dur-med) var(--ease-out);
}
@media (prefers-reduced-motion: reduce) {
  .upd__bar { transition: none; }
}
</style>
