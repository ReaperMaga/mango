<script setup lang="ts">
import { CircleArrowUp, ExternalLink, RotateCw } from 'lucide-vue-next'
import { useUpdater } from '~/stores/updater'
import { openExternal } from '~/composables/useBackend'
import { releaseUrl, RELEASES_URL } from '~/utils/releases'
import { useNow } from '~/utils/time'

/** Settings > Maintenance: check for, and install, a newer release from GitHub. */
const up = useUpdater()
const build = useBuildInfo()
const now = useNow()
const titleId = useId()
const autoId = useId()

function ago(ts: number) {
  const m = Math.round((now.value - ts) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h} h ago` : new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
const released = computed(() => up.update?.dateMs
  ? new Date(up.update.dateMs).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  : null)

const status = computed(() => {
  switch (up.phase) {
    case 'checking': return 'Checking GitHub for a newer release…'
    case 'downloading': return up.fraction === null ? 'Downloading the update…' : `Downloading the update, ${Math.round(up.fraction * 100)}%…`
    case 'restarting': return 'Installing. Mango restarts in a moment.'
  }
  if (up.update) return `Mango ${up.update.version} is available${released.value ? `, released ${released.value}` : ''}.`
  if (up.lastChecked) return `Mango ${build.version} is the latest version. Checked ${ago(up.lastChecked)}.`
  return `You have Mango ${build.version}.`
})
const working = computed(() => up.phase === 'downloading' || up.phase === 'restarting')
</script>

<template>
  <div class="group updates" role="group" :aria-labelledby="titleId">
    <div class="updates__head">
      <h3 :id="titleId" class="group__title">Updates</h3>
      <UiButton size="sm" variant="ghost" :loading="up.phase === 'checking'" :disabled="working || undefined" @click="up.check(true)">
        <RotateCw v-if="up.phase !== 'checking'" />Check now
      </UiButton>
    </div>

    <p class="updates__status" role="status" aria-live="polite">{{ status }}</p>
    <p v-if="up.phase === 'error' && up.error" class="updates__error">{{ up.error }}</p>
    <p v-if="build.dev" class="updates__hint">
      This is a development build: Mango does not check on its own, and installing replaces it with the released app.
    </p>

    <div v-if="working" class="updates__track" aria-hidden="true">
      <span class="updates__fill" :class="{ 'is-unknown': up.fraction === null }" :style="up.fraction === null ? undefined : { transform: `scaleX(${up.fraction})` }" />
    </div>

    <div v-if="up.update && !working" class="updates__actions">
      <UiButton size="sm" variant="primary" @click="up.install()">
        <CircleArrowUp />{{ up.installFailed ? 'Try again' : 'Update and restart' }}
      </UiButton>
      <UiButton size="sm" variant="ghost" @click="openExternal(releaseUrl(up.update.version))">
        <ExternalLink />Release notes
      </UiButton>
    </div>
    <p v-if="up.update && !working" class="updates__hint">Running chats and terminals stop when Mango restarts.</p>
    <p v-if="up.installFailed" class="updates__hint">
      You can also download the installer from
      <a :href="RELEASES_URL" class="updates__link" @click.prevent="openExternal(RELEASES_URL)">GitHub releases</a>.
    </p>

    <div class="updates__auto">
      <div class="updates__auto-text">
        <span :id="autoId" class="updates__auto-label">Check for updates automatically</span>
        <span class="updates__hint">At launch and every hour, from the latest release on GitHub.</span>
      </div>
      <button
        type="button"
        class="switch"
        role="switch"
        :aria-checked="up.autoCheck"
        :aria-labelledby="autoId"
        @click="up.setAutoCheck(!up.autoCheck)"
      >
        <span class="switch__knob" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.group { padding-top: var(--space-4); border-top: 1px solid var(--line-soft); }
.group__title { margin: 0; font-size: var(--text-sm); font-weight: 560; }

.updates { margin-top: var(--space-6); display: grid; gap: var(--space-2); }
.updates__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); min-height: 28px; }
.updates :deep(.btn svg) { width: 14px; height: 14px; }
.updates__status { margin: 0; font-size: var(--text-sm); color: var(--fg); text-wrap: pretty; }
.updates__error { margin: 0; font-size: var(--text-xs); color: var(--ripe-error-fg); text-wrap: pretty; user-select: text; }
.updates__hint { margin: 0; font-size: var(--text-xs); color: var(--fg-subtle); text-wrap: pretty; }
.updates__link { color: var(--accent-ink); text-underline-offset: 2px; }
.updates__link:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; border-radius: var(--radius-xs); }
.updates__actions { display: flex; gap: var(--space-2); margin-top: var(--space-1); }

.updates__track {
  position: relative;
  height: 4px;
  max-width: 360px;
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: var(--bg-active);
}
.updates__fill {
  position: absolute;
  inset: 0;
  background: var(--accent);
  border-radius: inherit;
  transform-origin: left;
  transition: transform var(--dur-med) var(--ease-out);
}
/* Size unknown: a short segment sweeps across instead. */
.updates__fill.is-unknown { right: auto; width: 30%; animation: sweep 1.2s var(--ease-in-out) infinite; }
@keyframes sweep { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
@media (prefers-reduced-motion: reduce) {
  .updates__fill { transition: none; }
  .updates__fill.is-unknown { animation: none; width: 100%; opacity: 0.5; }
}

.updates__auto {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  margin-top: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--line-soft);
}
.updates__auto-text { display: grid; gap: 1px; min-width: 0; }
.updates__auto-label { font-size: var(--text-sm); color: var(--fg); }

.switch {
  position: relative;
  flex: none;
  width: 32px;
  height: 18px;
  border-radius: var(--radius-pill);
  background: var(--bg-active);
  box-shadow: inset 0 0 0 1px var(--line-strong);
  transition: background var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.switch:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.switch__knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--fg-muted);
  transition: transform var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
.switch[aria-checked='true'] { background: var(--accent); box-shadow: none; }
.switch[aria-checked='true'] .switch__knob { transform: translateX(14px); background: var(--accent-fg); }
</style>
