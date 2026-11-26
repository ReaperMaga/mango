<script setup lang="ts">
import { ExternalLink, RefreshCw, TriangleAlert } from 'lucide-vue-next'
import type { LspServer, LspServerId } from '~/types/ipc'
import { useLanguageServers } from '~/lsp/store'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { call, openExternal } from '~/composables/useBackend'
import { isEnvPath } from '~/utils/envPath'
import { baseName } from '~/utils/paths'
import LoginTerminal from './LoginTerminal.vue'
import SettingsRow from './SettingsRow.vue'
import SettingsSwitch from './SettingsSwitch.vue'

/**
 * Settings > Editor, the language servers: whether the folder in view lets them run (they can run its
 * code), which are installed, and installing one with its own installer in a terminal the user watches.
 */
const { t } = useI18n()
const ws = useWorkspace()
const threads = useThreads()
const store = useLanguageServers()

const LANGUAGES = computed<Record<LspServerId, string>>(() => ({
  typescript: t('agents.languageServers.typescript'),
  rust: 'Rust',
  python: 'Python',
  go: 'Go',
  clangd: t('agents.languageServers.clangd'),
  csharp: 'C#',
}))

const project = computed(() => ws.activeProject)
/** The folder in view: a chat's worktree, or the project. */
const folder = computed(() => threads.workdir ?? project.value?.path)
const remote = computed(() => isEnvPath(folder.value))
/** Whose answer that folder goes by (`setConsent`): its project's, or its own. Not known until looked at. */
const answers = computed(() => (folder.value ? store.folders[folder.value]?.project : undefined))
/** That folder answers for itself alone. */
const alone = computed(() => !!answers.value && answers.value !== project.value?.path)
const consentName = computed(() => (alone.value ? baseName(answers.value!) : project.value?.name ?? ''))
const allowed = computed(() => !!folder.value && store.consentOf(folder.value) === true)
const consentHint = computed(() => {
  if (remote.value) return t('agents.languageServers.remoteHint')
  let what = alone.value ? t('agents.languageServers.folderHint') : t('agents.languageServers.projectHint')
  if (answers.value && !alone.value && project.value?.isGit && project.value.vcs !== 'plastic') what += ` ${t('agents.languageServers.worktreesHint')}`
  return ws.editorLanguageServers ? what : `${what} ${t('agents.languageServers.offHint')}`
})
function allow(on: boolean) {
  if (folder.value) store.setConsent(folder.value, on)
}

interface Job {
  server: LspServer
  phase: 'running' | 'checking' | 'failed'
  note: string
  attempt: number
}
const job = ref<Job | null>(null)
const termFocused = ref(false)
const root = ref<HTMLElement | null>(null)

function install(server: LspServer) {
  termFocused.value = false
  job.value = { server, phase: 'running', note: '', attempt: (job.value?.attempt ?? 0) + 1 }
}
const startInstall = (server: LspServerId) => (cols: number, rows: number) => call('lsp_install', { server, cols, rows, roots: store.openRoots() })

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
    ? t('agents.cli.installedNotFound', { name: j.server.name })
    : code === null
      ? t('agents.cli.installerStopped')
      : t('agents.cli.installerExited', { code })
}
async function closeJob() {
  const id = job.value?.server.id
  job.value = null
  termFocused.value = false
  await nextTick()
  // The button that had the keyboard is gone, and Install is back.
  root.value?.querySelector<HTMLElement>(`[data-install="${id}"]`)?.focus()
}
function onFailed(message: string) {
  if (!job.value) return
  job.value.phase = 'failed'
  job.value.note = t('agents.languageServers.cantStart', { message: message.replace(/\.$/, '') })
}

function help(server: LspServer) {
  void openExternal(server.helpUrl).catch(() => {})
}

onMounted(() => void store.load(true))
</script>

<template>
  <div ref="root" class="ls">
    <div v-if="project" class="ls__card">
      <SettingsRow :label="t('agents.languageServers.in', { name: consentName })" :hint="consentHint" class="ls__project">
        <template #default="{ labelId }">
          <SettingsSwitch v-if="!remote && answers" :model-value="allowed" :labelledby="labelId" @update:model-value="allow" />
        </template>
      </SettingsRow>
    </div>

    <div class="ls__head">
      <h4 class="ls__title">{{ t('agents.languageServers.servers') }}</h4>
      <UiButton size="sm" variant="ghost" :loading="store.loading" @click="store.load(true)">
        <RefreshCw v-if="!store.loading" />{{ t('agents.languageServers.lookAgain') }}
      </UiButton>
    </div>

    <p v-if="store.error" class="ls__note is-error selectable" role="alert">{{ t('agents.languageServers.failed', { error: store.error }) }}</p>
    <p v-else-if="!store.servers" class="ls__note" role="status">{{ t('agents.languageServers.looking') }}</p>

    <ul v-if="store.servers" class="ls__card ls__list">
      <li v-for="s in store.servers" :key="s.id" class="ls__item">
        <div class="ls__line">
          <div class="ls__text">
            <div class="ls__name">{{ LANGUAGES[s.id] }} <span class="ls__server">{{ s.name }}</span></div>
            <div v-if="s.installed && s.path" class="ls__where selectable" :title="s.path"><bdi>{{ s.path }}</bdi></div>
            <div v-else-if="!s.installed && s.install" class="ls__command selectable">{{ s.install }}</div>
          </div>
          <span class="ls__state" :class="{ 'is-installed': s.installed }">{{ s.installed ? t('agents.cli.installed') : t('agents.cli.notInstalled') }}</span>
          <template v-if="!s.installed">
            <template v-if="s.install">
              <UiButton
                v-if="job?.server.id !== s.id"
                size="sm"
                :data-install="s.id"
                :disabled="!!job && job.phase !== 'failed'"
                :aria-label="t('agents.cli.installNamed', { name: s.name })"
                @click="install(s)"
              >{{ t('common.actions.install') }}</UiButton>
            </template>
            <UiButton v-else size="sm" variant="ghost" :aria-label="t('agents.cli.howToInstallNamed', { name: s.name })" @click="help(s)"><ExternalLink />{{ t('agents.cli.howToInstall') }}</UiButton>
          </template>
        </div>

        <section
          v-if="job?.server.id === s.id"
          class="ls__job"
          :class="{ 'is-failed': job.phase === 'failed', 'is-focused': termFocused }"
          :aria-label="t('agents.cli.installNamed', { name: s.name })"
        >
          <header class="ls__job-head">
            <span class="ls__job-status" role="status">
              <TriangleAlert v-if="job.phase === 'failed'" class="ls__warn" aria-hidden="true" />
              <span v-else class="ring" :class="{ 'ring--work': job.phase === 'running' }" aria-hidden="true" />
              <span class="ls__job-title">
                {{ job.phase === 'running' ? t('agents.cli.installing', { name: s.name }) : job.phase === 'checking' ? t('agents.languageServers.checking', { name: s.name }) : t('agents.languageServers.missing', { name: s.name }) }}
              </span>
            </span>
            <span v-if="job.phase !== 'checking'" class="ls__job-actions">
              <template v-if="job.phase === 'failed'">
                <UiButton size="sm" @click="install(s)">{{ t('common.actions.retry') }}</UiButton>
                <UiButton size="sm" variant="ghost" @click="help(s)"><ExternalLink />{{ t('agents.cli.howToInstall') }}</UiButton>
              </template>
              <UiButton size="sm" variant="ghost" @click="closeJob">{{ job.phase === 'running' ? t('common.actions.cancel') : t('common.actions.close') }}</UiButton>
            </span>
          </header>

          <p v-if="job.phase === 'failed'" class="ls__job-note selectable" role="alert">{{ job.note }} {{ t('agents.cli.outputKept') }}</p>

          <div class="ls__term" @focusin="termFocused = true" @focusout="termFocused = false">
            <LoginTerminal
              :key="job.attempt"
              :start="startInstall(s.id)"
              :label="t('agents.cli.installer', { name: s.name })"
              :rows="10"
              @exit="onExit"
              @failed="onFailed"
            />
          </div>
          <p v-if="job.phase === 'running'" class="ls__hint">{{ t('agents.cli.answerInstaller') }}</p>
        </section>
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
  font-variant-ligatures: none;
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
/* The installer, running in place: Mango's job panel, as the agents' sign-in (SettingsAgentRow). */
.ls__job {
  margin: 0 var(--space-4) var(--space-3);
  background: var(--bg-panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  overflow: hidden;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.ls__job.is-focused {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.ls__job.is-failed,
.ls__job.is-failed.is-focused {
  border-color: color-mix(in oklch, var(--ripe-error) 45%, transparent);
  box-shadow: none;
}
.ls__job-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 38px;
  padding: 0 var(--space-2) 0 var(--space-3);
}
.ls__job-status { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--space-2); }
.ls__job-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
  font-weight: 560;
}
.ls__job-actions { flex: none; display: inline-flex; align-items: center; gap: var(--space-1); }
.ls__warn { flex: none; width: 14px; height: 14px; stroke-width: 1.85; color: var(--ripe-error); }
.ls__job-note {
  margin: 0;
  padding: 0 var(--space-3) var(--space-2);
  font-size: var(--text-xs);
  color: var(--ripe-error-fg);
  text-wrap: pretty;
}
.ls__term { border-top: 1px solid var(--line-soft); background: var(--term-bg); }
.ls__hint {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--line-soft);
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  text-wrap: pretty;
}
.ring {
  flex: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.75px solid var(--fg-subtle);
  border-right-color: transparent;
  animation: ls-turn 0.7s linear infinite;
}
.ring--work { border-color: var(--ripe-running); border-right-color: transparent; }
@keyframes ls-turn { to { transform: rotate(360deg); } }
.ls__note { margin: 0; font-size: var(--text-xs); color: var(--fg-subtle); text-wrap: pretty; }
.ls__note.is-error { color: var(--ripe-error-fg); }
</style>
