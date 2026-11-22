<script setup lang="ts">
import { ExternalLink, RefreshCw } from 'lucide-vue-next'
import type { LspServer, LspServerId } from '~/types/ipc'
import { useLanguageServers } from '~/lsp/store'
import { useWorkspace } from '~/stores/workspace'
import { call, openExternal } from '~/composables/useBackend'
import { isEnvPath } from '~/utils/envPath'
import LoginTerminal from './LoginTerminal.vue'
import SettingsRow from './SettingsRow.vue'
import SettingsSwitch from './SettingsSwitch.vue'

/**
 * Settings > Editor, the language servers: whether this project lets them run (they can run its
 * code), which are installed, and installing one with its own installer in a terminal the user watches.
 */
const ws = useWorkspace()
const store = useLanguageServers()

const LANGUAGES: Record<LspServerId, string> = {
  typescript: 'TypeScript and JavaScript',
  rust: 'Rust',
  python: 'Python',
  go: 'Go',
  clangd: 'C and C++',
  csharp: 'C#',
}

const project = computed(() => ws.activeProject)
const remote = computed(() => isEnvPath(project.value?.path))
const allowed = computed(() => !!project.value && store.consentOf(project.value.path) === true)
const consentHint = computed(() => {
  if (remote.value) return 'Language servers run only for projects on this computer. Completion from open files still works here.'
  const what = 'They can run this project\'s code (build scripts, plugins). Its worktrees follow this.'
  return ws.editorLanguageServers ? what : `${what} Nothing runs while language servers are turned off.`
})
function allow(on: boolean) {
  if (project.value) store.setConsent(project.value.path, on)
}

interface Job {
  server: LspServer
  phase: 'running' | 'checking' | 'failed'
  note: string
  attempt: number
}
const job = ref<Job | null>(null)

function install(server: LspServer) {
  job.value = { server, phase: 'running', note: '', attempt: (job.value?.attempt ?? 0) + 1 }
}
const startInstall = (server: LspServerId) => (cols: number, rows: number) => call('lsp_install', { server, cols, rows })

async function onExit(code: number | null) {
  const j = job.value
  if (!j || j.phase !== 'running') return
  j.phase = 'checking'
  await store.load(true)
  if (job.value !== j) return
  if (store.servers?.find(s => s.id === j.server.id)?.installed) {
    job.value = null
    return
  }
  j.phase = 'failed'
  j.note = code === 0
    ? `The installer finished, but Mango can't find ${j.server.name} yet. Restart Mango, then look again.`
    : code === null
      ? 'The installer stopped before it finished.'
      : `The installer exited with code ${code}.`
}
function onFailed(message: string) {
  if (!job.value) return
  job.value.phase = 'failed'
  job.value.note = `Mango couldn't start the installer: ${message.replace(/\.$/, '')}.`
}

function help(server: LspServer) {
  void openExternal(server.helpUrl).catch(() => {})
}

onMounted(() => void store.load(true))
</script>

<template>
  <div class="ls">
    <div v-if="project" class="ls__card">
      <SettingsRow :label="`Language servers in ${project.name}`" :hint="consentHint" class="ls__project">
        <template #default="{ labelId }">
          <SettingsSwitch v-if="!remote" :model-value="allowed" :labelledby="labelId" @update:model-value="allow" />
        </template>
      </SettingsRow>
    </div>

    <div class="ls__head">
      <h4 class="ls__title">Servers on this computer</h4>
      <UiButton size="sm" variant="ghost" :loading="store.loading" @click="store.load(true)">
        <RefreshCw v-if="!store.loading" />Look again
      </UiButton>
    </div>

    <p v-if="store.error" class="ls__note is-error selectable" role="alert">Mango couldn't look for language servers: {{ store.error }}</p>
    <p v-else-if="!store.servers" class="ls__note" role="status">Looking for language servers…</p>

    <ul v-if="store.servers" class="ls__card ls__list">
      <li v-for="s in store.servers" :key="s.id" class="ls__item">
        <div class="ls__line">
          <div class="ls__text">
            <div class="ls__name">{{ LANGUAGES[s.id] }} <span class="ls__server">{{ s.name }}</span></div>
            <div v-if="s.installed && s.path" class="ls__where selectable" :title="s.path"><bdi>{{ s.path }}</bdi></div>
            <div v-else-if="!s.installed && s.install" class="ls__command selectable">{{ s.install }}</div>
          </div>
          <span class="ls__state" :class="{ 'is-installed': s.installed }">{{ s.installed ? 'Installed' : 'Not installed' }}</span>
          <template v-if="!s.installed">
            <UiButton v-if="s.install" size="sm" :disabled="!!job && job.phase !== 'failed'" :aria-label="`Install ${s.name}`" @click="install(s)">Install</UiButton>
            <UiButton v-else size="sm" variant="ghost" :aria-label="`How to install ${s.name}`" @click="help(s)"><ExternalLink />How to install</UiButton>
          </template>
        </div>

        <div v-if="job?.server.id === s.id" class="ls__job">
          <div class="ls__term">
            <LoginTerminal
              :key="job.attempt"
              :start="startInstall(s.id)"
              :label="`${s.name} installer`"
              :rows="10"
              @exit="onExit"
              @failed="onFailed"
            />
          </div>
          <div class="ls__job-foot">
            <p class="ls__note" :class="{ 'is-error': job.phase === 'failed' }" role="status">
              {{ job.phase === 'running' ? 'If the installer asks a question, answer it here.' : job.phase === 'checking' ? 'Checking…' : job.note }}
            </p>
            <UiButton v-if="job.phase === 'failed'" size="sm" variant="ghost" @click="help(s)"><ExternalLink />How to install</UiButton>
            <UiButton v-if="job.phase !== 'checking'" size="sm" variant="ghost" @click="job = null">{{ job.phase === 'running' ? 'Cancel' : 'Close' }}</UiButton>
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.ls { display: grid; gap: var(--space-3); margin-top: var(--space-3); }
.ls__card {
  margin: 0;
  padding: 0;
  min-width: 0;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
}
.ls__project { padding: var(--space-3) var(--space-4); }
.ls__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); margin-top: var(--space-3); }
.ls__title { margin: 0; font-size: var(--text-sm); font-weight: 600; color: var(--fg); }
.ls__list { list-style: none; }
.ls__item + .ls__item { border-top: 1px solid var(--line-soft); }
.ls__line {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 52px;
  padding: var(--space-2) var(--space-4);
}
.ls__text { flex: 1; min-width: 0; }
.ls__name { font-size: var(--text-sm); font-weight: 560; color: var(--fg); }
.ls__server { margin-left: var(--space-1); font-weight: 400; color: var(--fg-subtle); }
.ls__where,
.ls__command {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--fg-subtle);
}
/* The end of a long path says the most. */
.ls__where {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}
.ls__command { overflow-wrap: anywhere; }
.ls__state { flex: none; font-size: var(--text-xs); color: var(--fg-subtle); }
.ls__state.is-installed { color: var(--ripe-queued-fg); }
.ls__job { padding: 0 var(--space-4) var(--space-3); }
.ls__term { overflow: hidden; border: 1px solid var(--line-soft); border-radius: var(--radius-sm); }
.ls__job-foot { display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-2); }
.ls__note { flex: 1; margin: 0; font-size: var(--text-xs); color: var(--fg-subtle); text-wrap: pretty; }
.ls__note.is-error { color: var(--ripe-error-fg); }
</style>
