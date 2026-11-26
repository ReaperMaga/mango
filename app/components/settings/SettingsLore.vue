<script setup lang="ts">
import { CircleDashed, ExternalLink, Layers, RefreshCw, TriangleAlert } from 'lucide-vue-next'
import { call, openExternal } from '~/composables/useBackend'
import { useLore } from '~/stores/lore'
import SettingsSection from './SettingsSection.vue'
import SettingsLoreForm from './SettingsLoreForm.vue'
import SettingsLoreServer from './SettingsLoreServer.vue'
import LoginTerminal from './LoginTerminal.vue'

/**
 * Settings > Lore: the Lore CLI on this computer (installed with Epic's own installer, in a terminal here)
 * and the Lore servers Mango offers for new projects, each checked from this computer and signed in to
 * through the CLI. Its own section rather than part of Git hosting: Lore is a version control of its own,
 * with its own CLI, servers and sign-in, not a forge for git repositories.
 *
 * Environments run `lore` inside themselves, with their own sign-in: this section manages this computer's.
 */
/** `active`: this section is the one on screen (it stays mounted while Settings is open). */
const props = defineProps<{ active: boolean }>()

const { t } = useI18n()
const lore = useLore()

const view = computed<'checking' | 'error' | 'missing' | 'ready'>(() => {
  if (!lore.cli) return lore.cliError && !lore.cliLoading ? 'error' : 'checking'
  return lore.cli.installed ? 'ready' : 'missing'
})

async function refresh() {
  await Promise.all([lore.loadCli(), lore.loadServers()])
}

/* Each time the section shows: the CLI, the list, and a fresh check of every server. */
async function show() {
  await refresh()
  for (const s of lore.servers ?? []) void lore.check(s.url)
}
onMounted(() => { if (props.active) void show() })
watch(() => props.active, (on) => { if (on) void show() })

/* ---------- installing the CLI ---------- */

interface Job { phase: 'running' | 'checking' | 'failed'; note: string; attempt: number }
const job = ref<Job | null>(null)
let attempts = 0
const termFocused = ref(false)
const jobEl = ref<HTMLElement | null>(null)
const startInstall = (cols: number, rows: number) => call('setup_install', { tool: 'lore', cols, rows })

function install() {
  job.value = { phase: 'running', note: '', attempt: ++attempts }
  nextTick(() => jobEl.value?.scrollIntoView({ block: 'nearest' }))
}

/* The New project dialog's Install button lands here and starts it. */
watch(() => [props.active, lore.installAsked] as const, ([on, asked]) => {
  if (!on || !asked) return
  lore.installAsked = false
  if (!job.value) install()
}, { immediate: true })

async function onExit(code: number | null) {
  const j = job.value
  if (!j || j.phase !== 'running') return
  j.phase = 'checking'
  const cli = await lore.loadCli()
  if (job.value !== j) return
  if (cli?.installed) {
    job.value = null
    for (const s of lore.servers ?? []) void lore.check(s.url)
    return
  }
  j.note = code === 0
    ? t('agents.cli.installedNotFound', { name: 'lore' })
    : code === null ? t('agents.cli.installerStopped') : code === 130 ? t('agents.cli.installerInterrupted') : t('agents.cli.installerExited', { code })
  j.phase = 'failed'
}

function onFailed(message: string) {
  if (!job.value) return
  job.value.note = t('agents.cli.cantStart', { message: message.replace(/\.$/, '') })
  job.value.phase = 'failed'
}

function closeJob() {
  const wasRunning = job.value?.phase === 'running'
  job.value = null
  if (wasRunning) void lore.loadCli()
}

function help() {
  void openExternal(lore.cli?.helpUrl ?? 'https://epicgames.github.io/lore/how-to/install-lore-cli/').catch(() => {})
}

/* ---------- adding a server ---------- */

const form = ref<InstanceType<typeof SettingsLoreForm> | null>(null)
const saving = ref(false)
const saveError = ref<string | null>(null)

async function add(name: string, url: string) {
  saving.value = true
  saveError.value = null
  try {
    const saved = await lore.upsert({ name, url })
    form.value?.reset()
    if (saved) void lore.check(saved.url)
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <SettingsSection :title="t('settings.nav.lore')" :description="t('lore.description')">
    <div class="cli" :class="`cli--${view}`">
      <div class="cli__head">
        <span class="cli__lead" aria-hidden="true"><Layers class="cli__mark" /></span>
        <h3 class="cli__name">{{ t('lore.cli.name') }}</h3>
        <template v-if="lore.cli?.installed">
          <span v-if="lore.cli.version" class="cli__version tabular">{{ lore.cli.version }}</span>
          <code v-if="lore.cli.path" class="cli__path selectable" :title="lore.cli.path">{{ lore.cli.path }}</code>
        </template>
        <span class="cli__grow" />
        <UiIconButton size="sm" :label="t('lore.cli.recheck')" :disabled="lore.cliLoading" @click="refresh">
          <RefreshCw :class="{ 'is-turning': lore.cliLoading }" />
        </UiIconButton>
      </div>

      <p v-if="view === 'checking'" class="cli__state" role="status">
        <span class="cli__lead" aria-hidden="true"><span class="ring" /></span>
        <span class="cli__more">{{ t('lore.cli.checking') }}</span>
      </p>
      <p v-else-if="view === 'error'" class="cli__state" role="status">
        <span class="cli__lead" aria-hidden="true"><TriangleAlert class="cli__icon cli__icon--error" /></span>
        <span class="cli__word cli__word--error">{{ t('lore.cli.checkFailed') }}</span>
        <span class="cli__more selectable">{{ lore.cliError }}</span>
      </p>
      <template v-else-if="view === 'missing'">
        <p class="cli__state" role="status">
          <span class="cli__lead" aria-hidden="true"><CircleDashed class="cli__icon cli__icon--idle" /></span>
          <span class="cli__word">{{ t('lore.cli.notInstalled') }}</span>
          <span class="cli__more"><i18n-t keypath="lore.cli.notFound" scope="global"><template #command><code>lore</code></template></i18n-t></span>
        </p>
        <div v-if="!job" class="cli__after">
          <span v-if="lore.cli?.install" class="cli__more">
            <i18n-t keypath="lore.cli.canInstall" scope="global">
              <template #via>{{ lore.cli.install.via }}</template>
              <template #command><code class="selectable">{{ lore.cli.install.command }}</code></template>
            </i18n-t>
          </span>
          <span v-else class="cli__more">{{ t('lore.cli.installYourself') }}</span>
          <span class="cli__actions">
            <UiButton v-if="lore.cli?.install" size="sm" @click="install">{{ t('common.actions.install') }}</UiButton>
            <UiButton v-else size="sm" variant="ghost" @click="help"><ExternalLink />{{ t('agents.cli.howToInstall') }}</UiButton>
          </span>
        </div>
      </template>

      <section
        v-if="job"
        ref="jobEl"
        class="job"
        :class="[`job--${job.phase}`, { 'is-focused': termFocused }]"
        :aria-label="t('lore.cli.install')"
      >
        <header class="job__head">
          <span class="job__status" role="status">
            <TriangleAlert v-if="job.phase === 'failed'" class="job__warn" aria-hidden="true" />
            <span v-else class="ring" :class="{ 'ring--work': job.phase === 'running' }" aria-hidden="true" />
            <span class="job__title">{{ job.phase === 'checking' ? t('lore.cli.checkingInstall') : job.phase === 'failed' ? t('lore.cli.stillMissing') : t('lore.cli.installing') }}</span>
          </span>
          <span v-if="job.phase !== 'checking'" class="job__actions">
            <template v-if="job.phase === 'failed'">
              <UiButton size="sm" @click="install">{{ t('common.actions.retry') }}</UiButton>
              <UiButton size="sm" variant="ghost" @click="help"><ExternalLink />{{ t('agents.cli.howToInstall') }}</UiButton>
            </template>
            <UiButton size="sm" variant="ghost" @click="closeJob">{{ job.phase === 'running' ? t('common.actions.cancel') : t('common.actions.close') }}</UiButton>
          </span>
        </header>
        <p v-if="job.phase === 'failed'" class="job__note selectable" role="alert">{{ job.note }} {{ t('agents.cli.outputKept') }}</p>
        <div class="job__term" @focusin="termFocused = true" @focusout="termFocused = false">
          <LoginTerminal :key="job.attempt" :start="startInstall" :label="t('lore.cli.installer')" :rows="10" @exit="onExit" @failed="onFailed" />
        </div>
        <p v-if="job.phase === 'running'" class="job__hint">{{ t('agents.cli.answerInstaller') }}</p>
      </section>
    </div>

    <section class="servers" aria-labelledby="lore-servers">
      <h3 id="lore-servers" class="servers__title">{{ t('lore.servers.title') }}</h3>
      <p class="servers__note">{{ t('lore.servers.note') }}</p>

      <ul v-if="lore.servers?.length" class="servers__list" :aria-label="t('lore.servers.list')">
        <SettingsLoreServer v-for="s in lore.servers" :key="s.id" :server="s" :cli-installed="!!lore.cli?.installed" />
      </ul>
      <p v-else-if="lore.servers" class="servers__empty">{{ t('lore.servers.empty') }}</p>
      <p v-if="lore.serversError" class="servers__error selectable" role="alert">{{ lore.serversError }}</p>

      <h4 class="servers__add">{{ t('lore.servers.add') }}</h4>
      <SettingsLoreForm ref="form" class="servers__form" :server="null" :list="lore.servers ?? []" :saving="saving" :error="saveError" @edit="saveError = null" @save="add" />

      <p class="servers__env">
        <i18n-t keypath="lore.servers.envNote" scope="global">
          <template #command><code>lore login</code></template>
        </i18n-t>
      </p>
    </section>
  </SettingsSection>
</template>

<style scoped>
.cli {
  padding: var(--space-3) 0;
  border-top: 1px solid var(--line-soft);
  border-bottom: 1px solid var(--line-soft);
}
.cli__lead { flex: none; display: inline-grid; place-items: center; width: 14px; height: 14px; }
.cli__head { display: flex; align-items: center; gap: var(--space-2); height: 28px; min-width: 0; }
.cli__mark { width: 14px; height: 14px; color: var(--fg); stroke-width: 1.75; }
.cli--missing .cli__mark { color: var(--fg-subtle); }
.cli__name { margin: 0; flex: none; font-size: var(--text-md); font-weight: 600; letter-spacing: -0.005em; color: var(--fg); }
.cli__version { flex: none; margin-left: var(--space-1); font-size: var(--text-xs); color: var(--fg-subtle); }
.cli__path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-xs); color: var(--fg-faint); }
.cli__grow { flex: 1; }
.is-turning { animation: lore-turn 0.8s linear infinite; }
@keyframes lore-turn { to { transform: rotate(360deg); } }
.cli__state { display: flex; align-items: center; gap: var(--space-2); min-height: 30px; margin: 0; min-width: 0; font-size: var(--text-sm); }
.cli__icon { width: 14px; height: 14px; stroke-width: 1.85; }
.cli__icon--error { color: var(--ripe-error); }
.cli__icon--idle { color: var(--ripe-idle); }
.cli__word { flex: none; font-weight: 560; color: var(--fg-muted); }
.cli__word--error { color: var(--ripe-error-fg); }
.cli__more { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-muted); }
.cli__more code { font-size: var(--text-xs); color: var(--fg); }
.cli__actions { flex: none; display: inline-flex; align-items: center; gap: var(--space-1); margin-left: auto; padding-left: var(--space-2); }
.cli__after { display: flex; align-items: center; gap: var(--space-3); margin: var(--space-1) 0 0 22px; font-size: var(--text-xs); }
.cli__after .cli__more { color: var(--fg-subtle); }

.servers { margin-top: var(--space-8); }
.servers__title { margin: 0; font-size: var(--text-md); font-weight: 600; letter-spacing: -0.005em; color: var(--fg); }
.servers__note { margin: var(--space-1) 0 var(--space-3); max-width: 62ch; font-size: var(--text-xs); color: var(--fg-subtle); text-wrap: pretty; }
.servers__list { margin: 0 0 var(--space-3); padding: 0; list-style: none; border-top: 1px solid var(--line-soft); }
.servers__empty { margin: 0 0 var(--space-3); font-size: var(--text-xs); color: var(--fg-faint); }
.servers__error { margin: 0 0 var(--space-3); font-size: var(--text-xs); color: var(--ripe-error-fg); text-wrap: pretty; }
.servers__add { margin: var(--space-5) 0 var(--space-2); font-size: var(--text-sm); font-weight: 600; color: var(--fg); }
.servers__form { max-width: 620px; }
.servers__env { margin: var(--space-5) 0 0; max-width: 62ch; font-size: var(--text-xs); color: var(--fg-subtle); text-wrap: pretty; }
.servers__env code { font-size: var(--text-2xs); color: var(--fg-muted); }

.job {
  margin: var(--space-2) 0 var(--space-1);
  scroll-margin: var(--space-4);
  background: var(--bg-panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  overflow: hidden;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.job.is-focused { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.job--failed, .job--failed.is-focused { border-color: color-mix(in oklch, var(--ripe-error) 45%, transparent); box-shadow: none; }
.job__head { display: flex; align-items: center; gap: var(--space-2); min-height: 38px; padding: 0 var(--space-2) 0 var(--space-3); }
.job__status { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--space-2); }
.job__title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); font-weight: 560; }
.job__warn { flex: none; width: 14px; height: 14px; stroke-width: 1.85; color: var(--ripe-error); }
.job__actions { flex: none; display: inline-flex; align-items: center; gap: var(--space-1); }
.job__note { margin: 0; padding: 0 var(--space-3) var(--space-2); font-size: var(--text-xs); color: var(--ripe-error-fg); text-wrap: pretty; }
.job__term { border-top: 1px solid var(--line-soft); background: var(--term-bg); }
.job__hint { margin: 0; padding: var(--space-2) var(--space-3); border-top: 1px solid var(--line-soft); font-size: var(--text-xs); color: var(--fg-subtle); text-wrap: pretty; }
.ring {
  flex: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.75px solid var(--fg-subtle);
  border-right-color: transparent;
  animation: lore-turn 0.7s linear infinite;
}
.ring--work { border-color: var(--ripe-running); border-right-color: transparent; }
</style>
