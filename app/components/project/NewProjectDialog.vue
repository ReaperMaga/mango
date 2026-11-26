<script setup lang="ts">
import { ChevronDown, CircleAlert, CircleCheck, FolderPlus, Server, TriangleAlert } from 'lucide-vue-next'
import type { EnvRemote, LoreNew } from '~/types/ipc'
import type { MenuItem } from '~/types/ui'
import { ENV_WORK_DIR, useEnvironments } from '~/stores/environments'
import { useLore } from '~/stores/lore'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { loreRepoNameFrom, loreRepoNameProblem, loreUrlFor } from '~/utils/lore'
import SettingsSegmented from '~/components/settings/SettingsSegmented.vue'

/**
 * Create an empty project folder under version control (git, a Lore repository, or none) and land in a
 * fresh chat. Where: on this computer, or inside an environment (the folder is made there, chats run
 * there, and so does `git init` or `lore repository create`, with the environment's own Lore sign-in).
 */
const { t } = useI18n()
const ws = useWorkspace()
const envs = useEnvironments()
const lore = useLore()
const threads = useThreads()

const open = computed(() => ws.dialog === 'new')

const where = ref<EnvRemote | null>(null)
const name = ref('')
/** Kept apart, so switching Where back and forth keeps each place's folder. */
const localLocation = ref('')
const remoteLocation = ref(ENV_WORK_DIR)
const location = computed({
  get: () => (where.value ? remoteLocation.value : localLocation.value),
  set: (v: string) => { if (where.value) remoteLocation.value = v; else localLocation.value = v },
})
type Vcs = 'git' | 'lore' | 'none'
const vcs = ref<Vcs>('git')
const vcsOptions = computed(() => [
  { value: 'git' as const, label: t('project.new.vcsGit') },
  { value: 'lore' as const, label: t('project.new.vcsLore') },
  { value: 'none' as const, label: t('project.new.vcsNone') },
])
const touched = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
/** The environment's folder list, open under Location. */
const browsing = ref(false)
const browseDir = ref<string | null>(null)
const browseSelected = ref<string | null>(null)

const tildify = (path: string) => path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~')

function errorText(e: unknown): string {
  if (typeof e === 'string') return e
  if (e instanceof Error) return e.message
  try { return JSON.stringify(e) } catch { return String(e) }
}

const nameError = computed(() => {
  const n = name.value.trim()
  if (!n) return t('project.new.nameMissing')
  if (/[/\\]/.test(n)) return t('project.slashes')
  if (n.startsWith('.')) return t('project.dotName')
  return null
})
const locationError = computed(() => {
  const l = location.value.trim()
  if (!l) return t('project.new.locationMissing')
  if (where.value && !l.startsWith('/')) return t('project.absolutePath')
  if (where.value && l.split('/').includes('..')) return t('project.dotDot')
  return null
})

const shownNameError = computed(() => (touched.value ? nameError.value : null))

const parent = computed(() => location.value.trim().replace(/(.)[\\/]+$/, '$1'))
const preview = computed(() => {
  const leaf = name.value.trim() || t('project.new.leaf')
  if (where.value) return { base: parent.value === '/' ? '/' : `${parent.value || '…'}/`, leaf }
  return { base: withTrailingSep(tildify(parent.value || '…')), leaf }
})
const place = computed(() => (where.value ? envLabels(where.value.hostId, where.value.instance) : null))

/* ---------- Lore ---------- */

const OFFLINE = 'offline'
/** A saved server's id, or `offline` (a repository only in the folder). */
const loreChoice = ref<string>(OFFLINE)
const repoName = ref('')
/** Typed by hand: stops following the project name. */
const repoEdited = ref(false)
watch(name, (n) => { if (!repoEdited.value) repoName.value = loreRepoNameFrom(n) })

const loreServer = computed(() => lore.servers?.find(s => s.id === loreChoice.value) ?? null)
/** The address `lore` will use: from inside an environment on a server's own host, its inside address. */
const loreUrl = computed(() => (loreServer.value ? loreUrlFor(loreServer.value, where.value?.hostId ?? null) : null))
const repoError = computed(() => (vcs.value === 'lore' ? loreRepoNameProblem(repoName.value) : null))
const loreServerLabel = computed(() => (loreChoice.value === OFFLINE ? t('project.new.loreOffline') : loreServer.value?.name ?? t('project.new.loreChoose')))

const loreItems = computed<MenuItem[]>(() => [
  ...(lore.servers ?? []).map(s => ({
    label: s.name,
    hint: loreUrlFor(s, where.value?.hostId ?? null),
    hintMono: true,
    check: 'radio' as const,
    checked: s.id === loreChoice.value,
    onSelect: () => { loreChoice.value = s.id },
  })),
  {
    label: t('project.new.loreOffline'),
    divider: !!lore.servers?.length,
    check: 'radio' as const,
    checked: loreChoice.value === OFFLINE,
    onSelect: () => { loreChoice.value = OFFLINE },
  },
  { label: t('project.new.loreAddServer'), divider: true, onSelect: openLoreSettings },
])

/** This computer's CLI, when the project is made here. */
const cliMissing = computed(() => vcs.value === 'lore' && !where.value && lore.cli !== null && !lore.cli.installed)
/** The chosen server as this computer last saw it (only checked for projects made here). */
const serverCheck = computed(() => (!where.value && loreUrl.value ? lore.checkOf(loreUrl.value) : null))
const serverState = computed<{ tone: 'checking' | 'ok' | 'warn' | 'error'; word: string; detail: string | null; signIn?: boolean } | null>(() => {
  const s = serverCheck.value
  if (!s || cliMissing.value) return null
  const c = s.check
  if (s.loading && !c) return { tone: 'checking', word: t('lore.state.checking'), detail: null }
  if (!c) return s.error ? { tone: 'error', word: t('lore.state.checkFailed'), detail: s.error } : null
  if (c.reach === 'udp') return { tone: 'warn', word: t('lore.state.udp'), detail: c.message }
  if (c.reach === 'error') return { tone: 'error', word: t('lore.state.error'), detail: c.message }
  if (c.reach !== 'ok') return { tone: 'error', word: t('lore.state.unreachable'), detail: c.message }
  if (c.auth === 'signedOut') return { tone: 'warn', word: t('lore.state.signInNeeded'), detail: null, signIn: true }
  const who = c.auth === 'signedIn' && c.user ? t('lore.state.signedInAs', { user: c.user }) : c.auth === 'notRequired' ? t('lore.state.noSignIn') : null
  return { tone: 'ok', word: t('lore.state.ready'), detail: who }
})

watch([vcs, loreUrl, where], ([v, url, w]) => {
  if (v === 'lore' && url && !w && !lore.checkOf(url)) void lore.check(url)
})

function openLoreSettings() {
  if (busy.value) return
  ws.dialog = null
  ws.openSettings('lore')
}

/** Settings > Lore, with the sign-in for the chosen server already started in its row. */
function signInLore() {
  if (!loreUrl.value) return
  lore.signInAsked = loreUrl.value
  openLoreSettings()
}

function installLore() {
  lore.installAsked = true
  openLoreSettings()
}

/** An environment without the Lore CLI: its page has the component to add. */
const envNeedsLore = computed(() => !!where.value && vcs.value === 'lore' && !!error.value?.includes('Lore CLI isn\'t installed in this environment'))
function openEnv() {
  const w = where.value
  if (!w || busy.value) return
  ws.dialog = null
  envs.openInstance(w.hostId, w.instance)
}

watch(open, async (isOpen) => {
  if (!isOpen) return
  where.value = projectWhere()
  name.value = ''
  vcs.value = 'git'
  repoName.value = ''
  repoEdited.value = false
  void lore.loadCli()
  void lore.loadServers().then((list) => {
    if (!list.some(s => s.id === loreChoice.value)) loreChoice.value = list[0]?.id ?? OFFLINE
  })
  touched.value = false
  busy.value = false
  error.value = null
  browsing.value = false
  if (!localLocation.value) {
    localLocation.value = await call('default_projects_dir').catch(() => '')
  }
}, { immediate: true })

function changeWhere(w: EnvRemote | null) {
  where.value = w
  ws.setWhere(w)
  browsing.value = false
  error.value = null
}

/* While browsing, Location follows the folder list. */
watch([browseDir, browseSelected], ([d, s]) => {
  const at = s ?? d
  if (browsing.value && at) remoteLocation.value = at
})

function close() {
  if (busy.value) return
  ws.dialog = null
}

async function browse() {
  if (where.value) {
    browsing.value = !browsing.value
    return
  }
  const picked = await pickFolder(t('project.new.chooseLocation'), localLocation.value || undefined)
  if (picked) localLocation.value = picked
}

function useFolder(path: string) {
  remoteLocation.value = path
  browsing.value = false
}

async function createRemote(w: EnvRemote) {
  const leaf = name.value.trim()
  // Never "create" over a folder that is already there: that one is opened with Open folder.
  const there = await envs.listDir(w.hostId, w.instance, parent.value)
  if (there.entries.some(e => e.name === leaf)) {
    throw new Error(t('project.new.exists', { path: `${there.dir === '/' ? '' : there.dir}/${leaf}` }))
  }
  const dir = await envs.prepareDir(w.hostId, w.instance, `${there.dir === '/' ? '' : there.dir}/${leaf}`, null, vcs.value === 'git', loreNew())
  const opened = await ws.openEnvProject({ ...w, dir }, leaf)
  // Created either way: the dialog is done even when the user chose not to open it.
  ws.dialog = null
  if (opened === 'this' && ws.activeProjectPath) threads.create(ws.activeProjectPath)
}

/** What `lore repository create` gets: null unless Lore is chosen. */
function loreNew(): LoreNew | null {
  return vcs.value === 'lore' ? { server: loreUrl.value, repository: repoName.value.trim() } : null
}

const repoInput = ref<HTMLInputElement | null>(null)

/* A failure can land below the fold in a short window: bring it into view. */
const errorEl = ref<HTMLElement | null>(null)
watch(error, async (e) => {
  if (!e) return
  await nextTick()
  errorEl.value?.scrollIntoView({ block: 'nearest' })
})

async function submit() {
  touched.value = true
  error.value = null
  if (nameError.value || locationError.value || busy.value) return
  if (repoError.value) {
    repoInput.value?.focus()
    return
  }
  busy.value = true
  try {
    if (where.value) {
      await createRemote(where.value)
    } else {
      const info = await call('create_project', { parent: parent.value, name: name.value.trim(), gitInit: vcs.value === 'git', lore: loreNew() })
      if (await ws.placeProject(info) === 'this') threads.create(info.path)
    }
  } catch (e) {
    error.value = errorText(e).replace(/\.$/, '')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UiDialog :open="open" :title="t('project.new.title')" :width="480" :dismissible="!busy" @close="close">
    <form id="new-project-form" class="np" novalidate @submit.prevent="submit">
      <UiField :label="t('project.where')" for="np-where">
        <ProjectWhere id="np-where" :model-value="where" :disabled="busy" @update:model-value="changeWhere" />
      </UiField>

      <UiField :label="t('project.new.name')" for="np-name" :error="shownNameError">
        <input
          id="np-name"
          v-model="name"
          class="input"
          type="text"
          placeholder="my-app"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          :disabled="busy"
          :aria-invalid="!!shownNameError || undefined"
          @blur="name && (touched = true)"
        >
      </UiField>

      <UiField :label="where ? t('project.new.locationEnv') : t('project.new.location')" for="np-location" :error="touched ? locationError : null">
        <div class="np__picker">
          <input
            id="np-location"
            v-model="location"
            class="input np__mono"
            type="text"
            autocomplete="off"
            spellcheck="false"
            :disabled="busy"
          >
          <UiButton :disabled="busy" :aria-expanded="where ? browsing : undefined" @click="browse">{{ where && browsing ? t('common.actions.done') : t('project.browse') }}</UiButton>
        </div>
      </UiField>
      <ProjectEnvFolders
        v-if="where && browsing"
        v-model:dir="browseDir"
        v-model:selected="browseSelected"
        class="np__browse"
        :host-id="where.hostId"
        :instance="where.instance"
        :rows="5"
        :choose-label="t('project.use')"
        :disabled="busy"
        @choose="useFolder"
      />

      <div class="np__vcs">
        <span id="np-vcs-label" class="np__vcs-label">{{ t('project.new.vcs') }}</span>
        <SettingsSegmented v-model="vcs" :options="vcsOptions" labelledby="np-vcs-label" describedby="np-vcs-hint" />
      </div>
      <p v-if="vcs !== 'lore'" id="np-vcs-hint" class="np__hint">
        <i18n-t v-if="vcs === 'git'" :keypath="place ? 'project.new.gitHintEnv' : 'project.new.gitHint'" scope="global">
          <template #command><code>git init</code></template>
          <template v-if="place" #place>{{ place.label }}</template>
        </i18n-t>
        <template v-else>{{ t('project.new.noneHint') }}</template>
      </p>

      <div v-else id="np-vcs-hint" class="np__lore">
        <p v-if="cliMissing" class="np__notice" role="status">
          <CircleAlert class="np__notice-icon np__notice-icon--warn" aria-hidden="true" />
          <span class="np__notice-text">{{ t('project.new.loreNoCli') }}</span>
          <UiButton size="sm" :disabled="busy" @click="installLore">{{ t('project.new.loreInstall') }}</UiButton>
        </p>

        <UiField :label="t('project.new.loreServer')" for="np-lore-server">
          <UiMenu :items="loreItems" :width="320" :label="t('project.new.loreServer')">
            <template #default="{ toggle, open: menuOpen }">
              <button
                id="np-lore-server"
                type="button"
                class="np__select"
                :class="{ 'is-open': menuOpen }"
                aria-haspopup="menu"
                :aria-expanded="menuOpen"
                :disabled="busy"
                @click="toggle"
              >
                <span class="np__select-label">{{ loreServerLabel }}</span>
                <code v-if="loreUrl" class="np__select-sub">{{ loreUrl }}</code>
                <ChevronDown class="np__select-chev" aria-hidden="true" />
              </button>
            </template>
          </UiMenu>
        </UiField>
        <p v-if="!lore.servers?.length && lore.servers" class="np__hint">
          {{ t('project.new.loreNoServers') }}
          <button type="button" class="np__link" :disabled="busy" @click="openLoreSettings">{{ t('project.new.loreAddServer') }}</button>
        </p>
        <p v-if="loreChoice === OFFLINE" class="np__hint">{{ t('project.new.loreOfflineHint', { place: place?.label ?? t('project.new.thisComputer') }) }}</p>
        <p v-else-if="place" class="np__hint">{{ t('project.new.loreEnvNote', { place: place.label }) }}</p>
        <p v-else-if="serverState" class="np__state" :class="`np__state--${serverState.tone}`" role="status">
          <span class="np__state-lead" aria-hidden="true">
            <span v-if="serverState.tone === 'checking'" class="np__ring" />
            <CircleCheck v-else-if="serverState.tone === 'ok'" />
            <CircleAlert v-else-if="serverState.tone === 'warn'" />
            <TriangleAlert v-else />
          </span>
          <span class="np__state-text">
            <span class="np__state-word">{{ serverState.word }}</span>
            <span v-if="serverState.detail" class="np__state-detail selectable">{{ serverState.detail }}</span>
          </span>
          <button v-if="serverState.signIn" type="button" class="np__link" :disabled="busy" @click="signInLore">{{ t('project.new.loreSignIn') }}</button>
          <button v-else-if="serverState.tone !== 'ok' && serverState.tone !== 'checking' && loreUrl" type="button" class="np__link" :disabled="busy" @click="lore.check(loreUrl)">{{ t('project.new.loreCheck') }}</button>
        </p>

        <UiField
          :label="t('project.new.loreRepo')"
          for="np-lore-repo"
          :error="touched || repoEdited ? repoError : null"
          :hint="loreUrl && !repoError ? t('project.new.loreRepoHint', { url: `${loreUrl}/${repoName.trim()}` }) : undefined"
        >
          <input
            id="np-lore-repo"
            ref="repoInput"
            v-model="repoName"
            class="input np__mono"
            type="text"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            :placeholder="loreRepoNameFrom(name) || 'my-app'"
            :disabled="busy"
            :aria-invalid="!!((touched || repoEdited) && repoError) || undefined"
            @input="repoEdited = true"
          >
        </UiField>
      </div>

      <p class="np__preview" aria-live="polite">
        <component :is="where ? Server : FolderPlus" aria-hidden="true" />
        <span v-if="place" class="np__preview-place">{{ place.label }}</span>
        <span class="np__preview-path selectable" :title="`${parent}/${name.trim()}`">
          <span class="np__preview-inner"><span class="np__preview-base">{{ preview.base }}</span><span class="np__preview-leaf" :class="{ 'is-empty': !name.trim() }">{{ preview.leaf }}</span></span>
        </span>
      </p>

      <p v-if="error" ref="errorEl" class="np__error" role="alert">
        <CircleAlert aria-hidden="true" />
        <span class="np__error-text">
          <span class="selectable">{{ t('project.new.failed') }} {{ error }}.{{ vcs === 'lore' || where ? '' : ` ${t('project.new.failedHint')}` }}</span>
          <button v-if="envNeedsLore && place" type="button" class="np__link" @click="openEnv">{{ t('project.new.loreOpenEnv', { place: place.label }) }}</button>
        </span>
      </p>
    </form>

    <template #footer>
      <UiButton variant="ghost" :disabled="busy" @click="close">{{ t('common.actions.cancel') }}</UiButton>
      <UiButton variant="primary" type="submit" form="new-project-form" :loading="busy">
        {{ busy ? t('project.new.creating') : t('project.new.create') }}
      </UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.np { display: grid; }
.np__picker { display: flex; gap: var(--space-2); }
.np__picker .input { flex: 1; min-width: 0; }
.np .np__picker .input.np__mono { font-family: var(--font-mono); font-size: var(--text-xs); }
.np .input:disabled { color: var(--fg-muted); cursor: default; }
.np__browse { margin-top: var(--space-2); }

.np__vcs {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  margin-top: var(--space-4);
}
.np__vcs-label { font-size: var(--text-xs); font-weight: 560; color: var(--fg-muted); }
.np__hint { margin: 6px 0 0; font-size: var(--text-xs); line-height: var(--leading-tight); color: var(--fg-subtle); text-wrap: pretty; }
.np__hint code { font-size: var(--text-2xs); color: var(--fg-muted); }
.np__lore { display: grid; margin-top: var(--space-3); }
.np__lore > .field + .np__hint { margin-top: 6px; }
.np__lore > .np__hint + .field, .np__lore > .np__state + .field { margin-top: var(--space-4); }

.np__link {
  display: inline;
  padding: 0;
  font: inherit;
  font-weight: 560;
  color: var(--accent-ink);
  white-space: nowrap;
  border-radius: var(--radius-xs);
}
.np__link:hover:not(:disabled) { text-decoration: underline; text-underline-offset: 3px; }
.np__link:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }

/* The server choice: a select like Where. */
.np__select {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
  height: 32px;
  padding: 0 var(--space-2) 0 var(--space-3);
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  color: var(--fg);
  font-size: var(--text-sm);
  white-space: nowrap;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.np__select:hover:not(:disabled), .np__select.is-open { border-color: var(--line-strong); }
.np__select:focus-visible { outline: none; border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.np__select:disabled { opacity: 0.55; }
.np__select-label { flex: none; max-width: 50%; overflow: hidden; text-overflow: ellipsis; }
.np__select-sub { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: var(--text-xs); color: var(--fg-subtle); }
.np__select-chev { flex: none; width: 14px; height: 14px; margin-left: auto; color: var(--fg-subtle); }

/* How the chosen server answered this computer. */
.np__state {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 6px 0 0;
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}
.np__state-lead { flex: none; display: inline-grid; place-items: center; width: 14px; height: 18px; }
.np__state-lead :deep(svg) { width: 14px; height: 14px; stroke-width: 1.85; }
.np__state--ok .np__state-lead { color: var(--ripe-queued); }
.np__state--warn .np__state-lead { color: var(--ripe-waiting); }
.np__state--error .np__state-lead { color: var(--ripe-error); }
.np__state-text { flex: 1; min-width: 0; text-wrap: pretty; }
.np__state-word { font-weight: 560; color: var(--fg-muted); margin-right: var(--space-2); }
.np__state--ok .np__state-word { color: var(--ripe-queued-fg); }
.np__state--warn .np__state-word { color: var(--ripe-waiting-fg); }
.np__state--error .np__state-word { color: var(--ripe-error-fg); }
.np__state-detail { color: var(--fg-muted); }
.np__ring {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 1.75px solid var(--fg-subtle);
  border-right-color: transparent;
  animation: np-turn 0.7s linear infinite;
}
@keyframes np-turn { to { transform: rotate(360deg); } }

.np__notice {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 0 var(--space-3);
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  background: var(--bg-inset);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  color: var(--fg);
}
.np__notice-icon { flex: none; width: 14px; height: 14px; stroke-width: 1.85; }
.np__notice-icon--warn { color: var(--ripe-waiting); }
.np__notice-text { flex: 1; min-width: 0; }

.np__preview {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-5) 0 0;
  padding: var(--space-2) var(--space-3);
  background: var(--bg-inset);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
}
.np__preview :deep(svg) { width: 14px; height: 14px; stroke-width: 1.75; color: var(--fg-subtle); flex: none; }
.np__preview-place { flex: none; font-size: var(--text-xs); font-weight: 560; color: var(--fg-muted); }
.np__preview-path {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}
.np__preview-inner { direction: ltr; unicode-bidi: isolate; }
.np__preview-base { color: var(--fg-subtle); }
.np__preview-leaf { color: var(--fg); font-weight: 600; }
.np__preview-leaf.is-empty { color: var(--fg-faint); font-weight: 400; }

.np__error {
  display: flex;
  gap: var(--space-2);
  margin: var(--space-3) 0 0;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--ripe-error);
}
.np__error :deep(svg) { width: 15px; height: 15px; margin-top: 2px; flex: none; }
.np__error-text { display: grid; gap: var(--space-1); justify-items: start; color: var(--fg); }
</style>
