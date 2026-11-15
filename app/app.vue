<script setup lang="ts">
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { useUpdater } from '~/stores/updater'

const ws = useWorkspace()
const threads = useThreads()
const updater = useUpdater()
const ready = ref(false)

onMounted(async () => {
  threads.load()
  await ws.init()
  ready.value = true
  updater.start()
})

useShortcuts()

/* An agent run probably changed files: let the changes panel catch up. */
function onFilesChanged(e: Event) {
  const path = (e as CustomEvent<{ path?: string }>).detail?.path
  import('~/stores/git').then(m => m.refreshGit(path)).catch(() => {})
}
onMounted(() => window.addEventListener('mango:files-changed', onFilesChanged))
onBeforeUnmount(() => window.removeEventListener('mango:files-changed', onFilesChanged))
</script>

<template>
  <div class="app" :class="{ 'is-ready': ready }">
    <AppTitlebar />
    <main class="app__body">
      <template v-if="ready">
        <WelcomeHub v-if="!ws.hasProject" />
        <AppWorkspace v-else />
      </template>
    </main>
    <ProjectNewProjectDialog />
    <ProjectCloneDialog />
    <SetupGettingStarted />
    <SettingsView />
    <CommandPalette />
    <UiImageViewer />
  </div>
</template>

<style scoped>
.app {
  display: grid;
  grid-template-rows: var(--titlebar-h) 1fr;
  height: 100vh;
  background: var(--bg-app);
}
.app__body {
  min-height: 0;
  min-width: 0;
  display: flex;
}
</style>
