<script setup lang="ts">
import { ExternalLink, Maximize2, Minimize2, TriangleAlert } from 'lucide-vue-next'
import { openExternal } from '~/composables/useBackend'
import { instanceKey, useEnvironments } from '~/stores/environments'

/**
 * An instance's desktop, served by noVNC through a tunnel on this computer,
 * shown in place. Closing it closes the tunnel.
 */
const props = defineProps<{ hostId: string; instance: string }>()
const emit = defineEmits<{ close: [] }>()

const envs = useEnvironments()
const key = computed(() => instanceKey(props.hostId, props.instance))
const desktop = computed(() => envs.desktops[key.value] ?? null)
const error = ref<string | null>(null)
const opening = ref(false)
const tall = ref(false)

/** "localhost:6080": where the tunnel listens, without the noVNC query string. */
const where = computed(() => {
  const url = desktop.value?.url
  if (!url || !/^https?:/i.test(url)) return null
  try { return new URL(url).host } catch { return null }
})

async function connect() {
  error.value = null
  opening.value = true
  try {
    await envs.openDesktop(props.hostId, props.instance)
  } catch (e) {
    error.value = (e instanceof Error ? e.message : String(e)).replace(/\.$/, '')
  } finally {
    opening.value = false
  }
}

async function close() {
  emit('close')
  await envs.closeDesktop(props.hostId, props.instance)
}

onMounted(() => { if (!desktop.value) connect() })
</script>

<template>
  <section class="dt" :class="{ 'dt--failed': !!error, 'dt--tall': tall }" :aria-label="`Desktop of ${instance}`">
    <header class="dt__head">
      <span class="dt__status" role="status">
        <TriangleAlert v-if="error" class="dt__warn" aria-hidden="true" />
        <span v-else-if="opening" class="ring" aria-hidden="true" />
        <span class="dt__title">{{ error ? 'The desktop didn\'t open' : opening ? 'Opening the desktop…' : 'Desktop' }}</span>
        <span v-if="desktop && !error && where" class="dt__url selectable">{{ where }}</span>
      </span>
      <span class="dt__actions">
        <UiButton v-if="error" size="sm" @click="connect">Try again</UiButton>
        <template v-else-if="desktop">
          <UiIconButton :label="tall ? 'Smaller' : 'Taller'" size="sm" @click="tall = !tall">
            <Minimize2 v-if="tall" /><Maximize2 v-else />
          </UiIconButton>
          <UiButton variant="ghost" size="sm" :title="desktop.url" @click="openExternal(desktop.url)"><ExternalLink />Open in browser</UiButton>
        </template>
        <UiButton variant="ghost" size="sm" @click="close">Close</UiButton>
      </span>
    </header>
    <p v-if="error" class="dt__note selectable" role="alert">{{ error }}. Check that the Desktop component is installed and the environment is running.</p>
    <div v-else class="dt__frame">
      <iframe v-if="desktop" :src="desktop.url" :title="`Desktop of ${instance}`" allow="clipboard-read; clipboard-write; fullscreen" />
    </div>
  </section>
</template>

<style scoped>
.dt {
  background: var(--bg-panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.dt--failed { border-color: color-mix(in oklch, var(--ripe-error) 45%, transparent); }
.dt__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 38px;
  padding: 0 var(--space-2) 0 var(--space-3);
}
.dt__status { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--space-2); }
.dt__title { flex: none; font-size: var(--text-sm); font-weight: 560; }
.dt__url {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--fg-subtle);
}
.dt__warn { flex: none; width: 14px; height: 14px; stroke-width: 1.85; color: var(--ripe-error); }
.dt__actions { flex: none; display: inline-flex; align-items: center; gap: var(--space-1); }
.dt__note {
  margin: 0;
  padding: 0 var(--space-3) var(--space-3);
  font-size: var(--text-xs);
  color: var(--ripe-error-fg);
  text-wrap: pretty;
}
.dt__frame {
  width: 100%;
  aspect-ratio: 16 / 10;
  max-height: 52vh;
  border-top: 1px solid var(--line-soft);
  background: var(--bg-inset);
}
.dt--tall .dt__frame { max-height: none; height: calc(100vh - var(--titlebar-h) - 160px); aspect-ratio: auto; }
.dt__frame iframe { display: block; width: 100%; height: 100%; border: 0; }

.ring {
  flex: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.75px solid var(--ripe-running);
  border-right-color: transparent;
  animation: dt-turn 0.7s linear infinite;
}
@keyframes dt-turn { to { transform: rotate(360deg); } }
</style>
