<script setup lang="ts">
import { CircleAlert, GitFork, Server } from 'lucide-vue-next'
import type { EnvRemote } from '~/types/ipc'
import { ENV_WORK_DIR, useEnvironments } from '~/stores/environments'
import { useWorkspace } from '~/stores/workspace'
import { GITLAB_COM } from '~/utils/gitHosts'

/**
 * Clone a git repository into a parent folder. git's own progress lines stream
 * in through `clone://progress`; the percentage drives a thin bar.
 * Where: on this computer, or inside an environment, where its own git (and GitHub or GitLab CLI
 * sign-in) does the cloning and reports no progress, only the outcome.
 */
const { t } = useI18n()
const ws = useWorkspace()
const envs = useEnvironments()

const open = computed(() => ws.dialog === 'clone')

const where = ref<EnvRemote | null>(null)
const url = ref('')
/** Kept apart, so switching Where back and forth keeps each place's folder. */
const localParent = ref('')
const remoteParent = ref(ENV_WORK_DIR)
const parentDir = computed({
  get: () => (where.value ? remoteParent.value : localParent.value),
  set: (v: string) => { if (where.value) remoteParent.value = v; else localParent.value = v },
})
const folder = ref('')
const touched = ref(false)
const browsing = ref(false)
const browseDir = ref<string | null>(null)
const browseSelected = ref<string | null>(null)
const place = computed(() => (where.value ? envLabels(where.value.hostId, where.value.instance) : null))

type Phase = 'idle' | 'cloning' | 'error'
const phase = ref<Phase>('idle')
const log = ref<string[]>([])
const percent = ref<number | null>(null)
const stage = ref('')
const error = ref<{ message: string; hint: string } | null>(null)

const tildify = (path: string) => path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~')

function errorText(e: unknown): string {
  if (typeof e === 'string') return e
  if (e instanceof Error) return e.message
  try { return JSON.stringify(e) } catch { return String(e) }
}

/* ---------- URL parsing ---------- */

interface Parsed { url: string; name: string; shorthand: boolean }

function parseRepo(raw: string): Parsed | null {
  const s = raw.trim()
  if (!s) return null
  const nameFrom = (path: string) => path.replace(/\/+$/, '').split(/[/:]/).pop()!.replace(/\.git$/, '')

  // owner/repo shorthand → GitHub over https
  const short = /^([A-Za-z0-9][\w.-]*)\/([\w.-]+?)(?:\.git)?$/.exec(s)
  if (short && !s.includes(':')) {
    return { url: `https://github.com/${short[1]}/${short[2]}.git`, name: short[2]!, shorthand: true }
  }
  // github.com/owner/repo without a scheme → https
  const bare = /^([\w-]+(?:\.[\w-]+)+)\/([\w./~-]+)$/.exec(s)
  if (bare) {
    const name = nameFrom(bare[2]!)
    return name ? { url: `https://${s}`, name, shorthand: true } : null
  }
  // https://, http://, ssh://, git://
  if (/^(?:https?|ssh|git):\/\//i.test(s)) {
    try {
      const u = new URL(s)
      const name = nameFrom(u.pathname)
      if (!u.hostname || !name) return null
      return { url: s, name, shorthand: false }
    } catch {
      return null
    }
  }
  // scp-like ssh: git@github.com:owner/repo(.git)
  const scp = /^[\w.-]+@[\w.-]+:([\w./~-]+)$/.exec(s)
  if (scp) {
    const name = nameFrom(scp[1]!)
    return name ? { url: s, name, shorthand: false } : null
  }
  return null
}

const parsed = computed(() => parseRepo(url.value))
const urlError = computed(() => {
  if (!url.value.trim()) return t('project.clone.urlMissing')
  if (!parsed.value) return t('project.clone.urlBad')
  return null
})
const folderError = computed(() => {
  const f = folder.value.trim()
  if (!f) return null
  if (/[/\\]/.test(f)) return t('project.slashes')
  if (f.startsWith('.')) return t('project.dotName')
  return null
})
const parentError = computed(() => {
  const p = parentDir.value.trim()
  if (!p) return t('project.clone.parentMissing')
  if (where.value && !p.startsWith('/')) return t('project.absolutePath')
  if (where.value && p.split('/').includes('..')) return t('project.dotDot')
  return null
})

const shownUrlError = computed(() => (touched.value ? urlError.value : null))

const parent = computed(() => parentDir.value.trim().replace(/(.)[\\/]+$/, '$1'))
const finalName = computed(() => folder.value.trim() || parsed.value?.name || '')
const urlHint = computed(() => (parsed.value?.shorthand ? t('project.clone.clones', { url: parsed.value.url }) : undefined))
const preview = computed(() => {
  const leaf = finalName.value || 'repo'
  if (where.value) return { base: parent.value === '/' ? '/' : `${parent.value || '…'}/`, leaf }
  return { base: withTrailingSep(tildify(parent.value || '…')), leaf }
})

const cloning = computed(() => phase.value === 'cloning')

/* ---------- lifecycle ---------- */

watch(open, async (isOpen) => {
  if (!isOpen) return
  where.value = projectWhere()
  url.value = ''
  folder.value = ''
  touched.value = false
  browsing.value = false
  reset()
  void envs.loadGitlabHosts()
  if (!localParent.value) localParent.value = await call('default_projects_dir').catch(() => '')
}, { immediate: true })

function changeWhere(w: EnvRemote | null) {
  where.value = w
  ws.setWhere(w)
  browsing.value = false
  reset()
}

/* While browsing, Destination follows the folder list. */
watch([browseDir, browseSelected], ([d, s]) => {
  const at = s ?? d
  if (browsing.value && at) remoteParent.value = at
})

function useFolder(path: string) {
  remoteParent.value = path
  browsing.value = false
}

/** The host a clone URL names: the https one with its port (glab's server name), else the bare name. */
function urlHost(u: string): { name: string; host: string } | null {
  let name: string
  let host: string
  if (/^[a-z+]+:\/\//i.test(u)) {
    try {
      const x = new URL(u)
      name = x.hostname
      host = /^https?:/i.test(u) ? x.host : x.hostname
    } catch {
      return null
    }
  } else {
    const scp = /^[\w.-]+@([\w.-]+):/.exec(u)
    if (!scp) return null
    name = host = scp[1]!
  }
  const clean = (h: string) => h.toLowerCase().replace(/^www\./, '')
  return { name: clean(name), host: clean(host) }
}

/**
 * The GitLab server a clone URL points at, the way the backend tells (`is_gitlab_host_in` in
 * gitlab.rs): gitlab.com, a gitlab.* name, or a server Mango knows. Null for anything else.
 */
const gitlabServer = computed(() => {
  const h = parsed.value ? urlHost(parsed.value.url) : null
  if (!h) return null
  const known = envs.gitlabHosts ?? []
  const listed = known.find(k => k === h.host) ?? known.find(k => k.split(':')[0] === h.name)
  if (listed) return listed
  if (h.name === GITLAB_COM || h.name.endsWith('.gitlab.com')) return GITLAB_COM
  return h.name.startsWith('gitlab.') && h.name.split('.').length >= 3 ? h.host : null
})

/** Sign in to the GitLab CLI for that server inside the environment, for private repositories. */
function signInGitLab() {
  const w = where.value
  if (!w || cloning.value || !gitlabServer.value) return
  ws.dialog = null
  envs.openInstance(w.hostId, w.instance, `login-glab:${gitlabServer.value}`)
}

/** Sign in to the GitHub CLI inside the environment (on its page in Settings), for private repositories. */
function signInGitHub() {
  const w = where.value
  if (!w || cloning.value) return
  ws.dialog = null
  envs.openInstance(w.hostId, w.instance, 'login-gh')
}

function reset() {
  phase.value = 'idle'
  log.value = []
  percent.value = null
  stage.value = ''
  error.value = null
}

function close() {
  // git clone has no cancel yet; keep the dialog until it finishes.
  if (cloning.value) return
  ws.dialog = null
}

async function browse() {
  if (where.value) {
    browsing.value = !browsing.value
    return
  }
  const picked = await pickFolder(t('project.clone.chooseDestination'), localParent.value || undefined)
  if (picked) localParent.value = picked
}

/* ---------- progress ---------- */

const PROGRESS = /^(?:remote:\s*)?([A-Za-z ]+?):\s+(\d{1,3})%/

function pushLine(rawLine: string) {
  // git rewrites progress in place with \r; each segment is a state update.
  for (const seg of rawLine.split(/[\r\n]+/)) {
    const line = seg.replace(/\s+$/, '')
    if (!line) continue
    const m = PROGRESS.exec(line)
    const last = log.value[log.value.length - 1]
    const lastKey = last ? PROGRESS.exec(last)?.[1] : undefined
    if (m && lastKey === m[1]) log.value[log.value.length - 1] = line
    else log.value.push(line)
    if (log.value.length > 6) log.value.splice(0, log.value.length - 6)

    if (m) {
      const label = m[1]!.trim()
      const pct = Math.min(100, Number(m[2]))
      // Receiving is the long part; resolving deltas fills the last stretch.
      if (/receiving objects/i.test(label)) { percent.value = Math.round(pct * 0.9); stage.value = t('project.clone.receiving', { percent: pct }) }
      else if (/resolving deltas/i.test(label)) { percent.value = 90 + Math.round(pct * 0.1); stage.value = t('project.clone.resolving', { percent: pct }) }
      else if (/updating files|checking out/i.test(label)) { percent.value = Math.max(percent.value ?? 0, 98); stage.value = `${label} ${pct}%` }
      else if (percent.value === null) stage.value = `${label.replace(/^remote:\s*/i, '')} ${pct}%`
    } else if (/^Cloning into/i.test(line)) {
      stage.value = t('project.clone.connecting')
    }
  }
}

function explain(message: string): { message: string; hint: string } {
  const lines = message.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const fatal = lines.filter(l => /^(fatal|error):/i.test(l)).pop() ?? lines.pop() ?? message
  const text = fatal.replace(/^(fatal|error):\s*/i, '').replace(/\.$/, '')
  const pretty = text.charAt(0).toUpperCase() + text.slice(1)
  const m = message.toLowerCase()
  let hint = t('project.clone.hintUrl')
  if (m.includes('already exists and is not an empty directory')) hint = t('project.clone.hintExists')
  else if (m.includes('permission denied (publickey)') || m.includes('host key verification failed')) hint = t('project.clone.hintKey')
  else if (m.includes('authentication failed') || m.includes('could not read username')) hint = t('project.clone.hintCredentials')
  else if (m.includes('not found') || m.includes('does not exist')) hint = t('project.clone.hintNotFound')
  else if (m.includes('could not resolve host') || m.includes('unable to access')) hint = t('project.clone.hintNetwork')
  if (where.value && (m.includes('could not read username') || m.includes('authentication failed') || m.includes('terminal prompts disabled'))) {
    hint = t('project.clone.hintEnvCredentials', { place: place.value?.label ?? t('project.clone.theEnvironment') })
  }
  return { message: pretty, hint }
}

async function submit() {
  touched.value = true
  if (cloning.value || urlError.value || folderError.value || parentError.value || !parsed.value) return
  reset()
  phase.value = 'cloning'
  if (where.value) return cloneRemote(where.value, parsed.value.url)
  stage.value = t('project.clone.starting')
  const jobId = `clone-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  let unlisten: (() => void) | null = null
  try {
    unlisten = await on('clone://progress', (p) => {
      if (p.jobId === jobId) pushLine(p.line)
    })
    const info = await call('git_clone', {
      url: parsed.value.url,
      parent: parent.value,
      name: folder.value.trim() || null,
      jobId,
    })
    percent.value = 100
    phase.value = 'idle'
    await ws.placeProject(info)
  } catch (e) {
    phase.value = 'error'
    error.value = explain(errorText(e))
  } finally {
    unlisten?.()
  }
}

async function cloneRemote(w: EnvRemote, repo: string) {
  stage.value = t('project.clone.cloningIn', { place: place.value?.label ?? t('project.clone.theEnvironment') })
  try {
    const name = finalName.value
    const base = parent.value === '/' ? '' : parent.value
    const dir = await envs.prepareDir(w.hostId, w.instance, `${base}/${name}`, repo)
    percent.value = 100
    phase.value = 'idle'
    await ws.openEnvProject({ ...w, dir }, name)
    // Cloned either way: the dialog is done even when the user chose not to open it.
    ws.dialog = null
  } catch (e) {
    phase.value = 'error'
    error.value = explain(errorText(e))
  }
}

/* A failure can land below the fold in a short window: bring it into view. */
const errorEl = ref<HTMLElement | null>(null)
watch(error, async (e) => {
  if (!e) return
  await nextTick()
  errorEl.value?.scrollIntoView({ block: 'nearest' })
})
</script>

<template>
  <UiDialog :open="open" :title="t('project.clone.title')" :width="520" :dismissible="!cloning" @close="close">
    <form id="clone-form" class="cl" novalidate @submit.prevent="submit">
      <UiField :label="t('project.where')" for="cl-where">
        <ProjectWhere id="cl-where" :model-value="where" :disabled="cloning" @update:model-value="changeWhere" />
      </UiField>

      <UiField :label="t('project.clone.url')" for="cl-url" :error="shownUrlError" :hint="urlHint">
        <input
          id="cl-url"
          v-model="url"
          class="input cl__mono"
          type="text"
          placeholder="https://github.com/owner/repo.git"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          :disabled="cloning"
          :aria-invalid="!!shownUrlError || undefined"
          @blur="url && (touched = true)"
        >
      </UiField>

      <p v-if="place" class="cl__note">
        {{ t('project.clone.note', { place: place.label, tool: gitlabServer ? 'GitLab' : 'GitHub' }) }}
        <button v-if="gitlabServer" type="button" class="cl__link" :disabled="cloning" @click="signInGitLab">{{ t('project.clone.signIn', { server: gitlabServer, place: place.label }) }}</button>
        <button v-else type="button" class="cl__link" :disabled="cloning" @click="signInGitHub">{{ t('project.clone.signIn', { server: 'GitHub', place: place.label }) }}</button>
      </p>

      <UiField :label="where ? t('project.clone.destinationEnv') : t('project.clone.destination')" for="cl-parent" :error="touched ? parentError : null">
        <div class="cl__picker">
          <input
            id="cl-parent"
            v-model="parentDir"
            class="input cl__mono"
            type="text"
            autocomplete="off"
            spellcheck="false"
            :disabled="cloning"
          >
          <UiButton :disabled="cloning" :aria-expanded="where ? browsing : undefined" @click="browse">{{ where && browsing ? t('common.actions.done') : t('project.browse') }}</UiButton>
        </div>
      </UiField>
      <ProjectEnvFolders
        v-if="where && browsing"
        v-model:dir="browseDir"
        v-model:selected="browseSelected"
        class="cl__browse"
        :host-id="where.hostId"
        :instance="where.instance"
        :rows="5"
        :choose-label="t('project.use')"
        :disabled="cloning"
        @choose="useFolder"
      />

      <UiField :label="t('project.clone.folder')" for="cl-folder" :error="folderError" :hint="t('project.clone.folderHint')">
        <input
          id="cl-folder"
          v-model="folder"
          class="input"
          type="text"
          :placeholder="parsed?.name || 'repo'"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          :disabled="cloning"
        >
      </UiField>

      <p class="cl__preview" aria-live="polite">
        <component :is="where ? Server : GitFork" aria-hidden="true" />
        <span v-if="place" class="cl__preview-place">{{ place.label }}</span>
        <span class="cl__preview-path selectable" :title="`${parent}/${finalName}`">
          <span class="cl__preview-inner"><span class="cl__preview-base">{{ preview.base }}</span><span class="cl__preview-leaf" :class="{ 'is-empty': !finalName }">{{ preview.leaf }}</span></span>
        </span>
      </p>

      <div v-if="phase !== 'idle' || log.length" class="cl__progress" :class="`is-${phase}`">
        <div class="cl__status">
          <span class="cl__stage tabular" aria-live="polite">{{ phase === 'error' ? t('project.clone.failed') : stage }}</span>
        </div>
        <div
          v-if="phase !== 'error'"
          class="cl__bar"
          :class="{ 'is-indeterminate': percent === null }"
          role="progressbar"
          :aria-label="t('project.clone.progress')"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="percent ?? undefined"
        >
          <span class="cl__bar-fill" :style="percent !== null ? { width: `${percent}%` } : undefined" />
        </div>
        <pre v-if="log.length" class="cl__log selectable" :aria-label="t('project.clone.output')"><span v-for="(l, i) in log" :key="i" class="cl__log-line">{{ l }}</span></pre>
      </div>

      <p v-if="error" ref="errorEl" class="cl__error" role="alert">
        <CircleAlert aria-hidden="true" />
        <span>
          <span class="cl__error-msg">{{ error.message }}.</span>
          {{ error.hint }}
        </span>
      </p>
    </form>

    <template #footer>
      <UiButton
        variant="ghost"
        :disabled="cloning"
        :title="cloning ? t('project.clone.wait') : undefined"
        @click="close"
      >
        {{ t('common.actions.cancel') }}
      </UiButton>
      <UiButton variant="primary" type="submit" form="clone-form" :loading="cloning">
        {{ cloning ? t('project.clone.cloning') : phase === 'error' ? t('common.actions.retry') : t('project.clone.clone') }}
      </UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.cl { display: grid; }
.cl .cl__picker { display: flex; gap: var(--space-2); }
.cl .cl__picker .input { flex: 1; min-width: 0; }
.cl .input.cl__mono { font-family: var(--font-mono); font-size: var(--text-xs); }
.cl .input:disabled { color: var(--fg-muted); cursor: default; }
.cl__browse { margin-top: var(--space-2); }
.cl__note {
  margin: var(--space-3) 0 0;
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--fg-subtle);
}
.cl__note + .field { margin-top: var(--space-4); }
.cl__link {
  display: inline;
  padding: 0;
  font: inherit;
  font-weight: 560;
  color: var(--accent-ink);
  border-radius: var(--radius-xs);
}
.cl__link:hover:not(:disabled) { text-decoration: underline; text-underline-offset: 3px; }
.cl__link:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.cl__preview-place { flex: none; font-size: var(--text-xs); font-weight: 560; color: var(--fg-muted); }

.cl__preview {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-5) 0 0;
  padding: var(--space-2) var(--space-3);
  background: var(--bg-inset);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
}
.cl__preview :deep(svg) { width: 14px; height: 14px; stroke-width: 1.75; color: var(--fg-subtle); flex: none; }
.cl__preview-path {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}
.cl__preview-inner { direction: ltr; unicode-bidi: isolate; }
.cl__preview-base { color: var(--fg-subtle); }
.cl__preview-leaf { color: var(--fg); font-weight: 600; }
.cl__preview-leaf.is-empty { color: var(--fg-faint); font-weight: 400; }

/* ---------- progress ---------- */
.cl__progress {
  display: grid;
  gap: var(--space-2);
  margin-top: var(--space-3);
}
.cl__status { display: flex; justify-content: space-between; font-size: var(--text-xs); color: var(--fg-muted); }
.cl__progress.is-error .cl__stage { color: var(--ripe-error); font-weight: 560; }

.cl__bar {
  position: relative;
  height: 3px;
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: var(--bg-active);
}
.cl__bar-fill {
  position: absolute;
  inset: 0 auto 0 0;
  width: 0;
  border-radius: inherit;
  background: var(--accent);
  transition: width var(--dur-med) var(--ease-out);
}
.cl__bar.is-indeterminate .cl__bar-fill {
  width: 30%;
  animation: cl-slide 1.2s var(--ease-in-out) infinite;
}
@keyframes cl-slide {
  from { translate: -100% 0; }
  to { translate: 340% 0; }
}
@media (prefers-reduced-motion: reduce) {
  .cl__bar.is-indeterminate .cl__bar-fill { animation: none; width: 100%; opacity: 0.35; }
}

.cl__log {
  display: grid;
  align-content: start;
  margin: 0;
  padding: var(--space-2) var(--space-3);
  min-height: calc(6 * 1.55em + 2 * var(--space-2));
  font-size: var(--text-2xs);
  line-height: 1.55;
  color: var(--fg-muted);
  background: var(--bg-inset);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.cl__log-line { white-space: pre; overflow: hidden; text-overflow: ellipsis; }
.cl__log-line:last-child { color: var(--fg); }

.cl__error {
  display: flex;
  gap: var(--space-2);
  margin: var(--space-3) 0 0;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--ripe-error);
}
.cl__error :deep(svg) { width: 15px; height: 15px; margin-top: 2px; flex: none; }
.cl__error > span { color: var(--fg-muted); }
.cl__error-msg { color: var(--fg); }
</style>
