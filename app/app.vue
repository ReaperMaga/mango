<script setup lang="ts">
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { useUpdater } from '~/stores/updater'
import { useEnvironments } from '~/stores/environments'
import { useBrowser } from '~/stores/browser'
import { useWindows } from '~/stores/windows'
import { useConnectivity } from '~/stores/connectivity'
import { on } from '~/composables/useBackend'

const ws = useWorkspace()
const threads = useThreads()
const updater = useUpdater()
const win = useWindows()
const ready = ref(false)
// Remote projects' chats, kept in their environments: looked at once the chats and projects are loaded.
useRemoteChatSync(ready)
// Which environments' servers are reachable; what a dropped connection broke picks up when one is back.
const connectivity = useConnectivity()
onMounted(() => { void connectivity.start() })
onBeforeUnmount(() => connectivity.stop())

onMounted(async () => {
  // First what the other windows hold: this window loads only the chats it owns (stores/windows.ts).
  await win.start()
  await threads.load()
  await ws.init()
  // Claim the open projects (a new window takes its project over from the window that had it).
  win.follow()
  ready.value = true
  // Updates are the main window's business: one prompt, not one per window.
  if (win.isMain) updater.start()
  // Drops the webviews a reloaded UI left behind, then listens for pages and agents.
  void useBrowser().init()
})

useShortcuts()

/* Something this window could not take over (a chat still running in another window). */
watch(() => win.refused, (reason) => {
  if (!reason) return
  ws.notify('Opened in another window', reason)
  win.refused = null
})

/* An agent run probably changed files: let the changes panel catch up. */
function onFilesChanged(e: Event) {
  const path = (e as CustomEvent<{ path?: string }>).detail?.path
  import('~/stores/git').then(m => m.refreshGit(path)).catch(() => {})
}
onMounted(() => window.addEventListener('mango:files-changed', onFilesChanged))
onBeforeUnmount(() => window.removeEventListener('mango:files-changed', onFilesChanged))

/* A `mango://join/…` link was opened: Settings > Environments, with the join dialog filled in. */
let unlistenJoin: (() => void) | undefined
onMounted(async () => {
  // The backend repeats a link that started the app (the page may not have listened yet): act on each link once.
  const seen = new Map<string, number>()
  // The main window shows the join dialog (the backend brings it to the front).
  if (!win.isMain) return
  unlistenJoin = await on('envs://join', ({ link }) => {
    const now = Date.now()
    if (now - (seen.get(link) ?? -Infinity) < 15_000) return
    seen.set(link, now)
    useEnvironments().openJoin(link)
  })
})
onBeforeUnmount(() => unlistenJoin?.())
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
    <ProjectOpenEnvFolderDialog />
    <SetupGettingStarted />
    <UsageDialog />
    <ConfirmDialog />
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
