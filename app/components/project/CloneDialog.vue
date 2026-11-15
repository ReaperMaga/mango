<script setup lang="ts">
import { CircleAlert, GitFork } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'

/**
 * Clone a git repository into a parent folder. git's own progress lines stream
 * in through `clone://progress`; the percentage drives a thin bar.
 */
const ws = useWorkspace()

const open = computed(() => ws.dialog === 'clone')

const url = ref('')
const parentDir = ref('')
const folder = ref('')
const touched = ref(false)

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
  if (!url.value.trim()) return 'Paste a repository URL.'
  if (!parsed.value) return 'Use an https or SSH URL, or owner/repo for GitHub.'
  return null
})
const folderError = computed(() => {
  const f = folder.value.trim()
  if (!f) return null
  if (/[/\\]/.test(f)) return 'Use a single folder name, without slashes.'
  if (f.startsWith('.')) return 'Names can\'t start with a dot; that would hide the folder.'
  return null
})
const parentError = computed(() => (parentDir.value.trim() ? null : 'Choose where to put the clone.'))

const shownUrlError = computed(() => (touched.value ? urlError.value : null))

const parent = computed(() => parentDir.value.trim().replace(/(.)[\\/]+$/, '$1'))
const finalName = computed(() => folder.value.trim() || parsed.value?.name || '')
const urlHint = computed(() => (parsed.value?.shorthand ? `Clones ${parsed.value.url}` : undefined))
const preview = computed(() => {
  const base = tildify(parent.value || '…')
  return { base: withTrailingSep(base), leaf: finalName.value || 'repo' }
})

const cloning = computed(() => phase.value === 'cloning')

/* ---------- lifecycle ---------- */

watch(open, async (isOpen) => {
  if (!isOpen) return
  url.value = ''
  folder.value = ''
  touched.value = false
  reset()
  if (!parentDir.value) parentDir.value = await call('default_projects_dir').catch(() => '')
}, { immediate: true })

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
  const picked = await pickFolder('Choose destination', parentDir.value || undefined)
  if (picked) parentDir.value = picked
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
      if (/receiving objects/i.test(label)) { percent.value = Math.round(pct * 0.9); stage.value = `Receiving objects ${pct}%` }
      else if (/resolving deltas/i.test(label)) { percent.value = 90 + Math.round(pct * 0.1); stage.value = `Resolving deltas ${pct}%` }
      else if (/updating files|checking out/i.test(label)) { percent.value = Math.max(percent.value ?? 0, 98); stage.value = `${label} ${pct}%` }
      else if (percent.value === null) stage.value = `${label.replace(/^remote:\s*/i, '')} ${pct}%`
    } else if (/^Cloning into/i.test(line)) {
      stage.value = 'Connecting…'
    }
  }
}

function explain(message: string): { message: string; hint: string } {
  const lines = message.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const fatal = lines.filter(l => /^(fatal|error):/i.test(l)).pop() ?? lines.pop() ?? message
  const text = fatal.replace(/^(fatal|error):\s*/i, '').replace(/\.$/, '')
  const pretty = text.charAt(0).toUpperCase() + text.slice(1)
  const m = message.toLowerCase()
  let hint = 'Check the URL and try again.'
  if (m.includes('already exists and is not an empty directory')) hint = 'Pick another folder name or destination, then try again.'
  else if (m.includes('permission denied (publickey)') || m.includes('host key verification failed')) hint = 'The host didn\'t accept your SSH key. Use the https URL, or add your key to the host.'
  else if (m.includes('authentication failed') || m.includes('could not read username')) hint = 'The host asked for credentials. Sign in with your git credential helper or use an SSH URL.'
  else if (m.includes('not found') || m.includes('does not exist')) hint = 'Check the owner and repository name, and that you have access to it.'
  else if (m.includes('could not resolve host') || m.includes('unable to access')) hint = 'Check your network connection and the host name.'
  return { message: pretty, hint }
}

async function submit() {
  touched.value = true
  if (cloning.value || urlError.value || folderError.value || parentError.value || !parsed.value) return
  reset()
  phase.value = 'cloning'
  stage.value = 'Starting git…'
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
    ws.adopt(info)
  } catch (e) {
    phase.value = 'error'
    error.value = explain(errorText(e))
  } finally {
    unlisten?.()
  }
}
</script>

<template>
  <UiDialog :open="open" title="Clone repository" :width="520" @close="close">
    <form id="clone-form" class="cl" novalidate @submit.prevent="submit">
      <UiField label="Repository URL" for="cl-url" :error="shownUrlError" :hint="urlHint">
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

      <UiField label="Destination" for="cl-parent" :error="touched ? parentError : null">
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
          <UiButton :disabled="cloning" @click="browse">Browse…</UiButton>
        </div>
      </UiField>

      <UiField label="Folder name" for="cl-folder" :error="folderError" hint="Optional. Defaults to the repository name.">
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
        <GitFork aria-hidden="true" />
        <span class="cl__preview-path selectable" :title="`${parent}/${finalName}`">
          <span class="cl__preview-inner"><span class="cl__preview-base">{{ preview.base }}</span><span class="cl__preview-leaf" :class="{ 'is-empty': !finalName }">{{ preview.leaf }}</span></span>
        </span>
      </p>

      <div v-if="phase !== 'idle' || log.length" class="cl__progress" :class="`is-${phase}`">
        <div class="cl__status">
          <span class="cl__stage tabular" aria-live="polite">{{ phase === 'error' ? 'Clone failed' : stage }}</span>
        </div>
        <div
          v-if="phase !== 'error'"
          class="cl__bar"
          :class="{ 'is-indeterminate': percent === null }"
          role="progressbar"
          aria-label="Clone progress"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="percent ?? undefined"
        >
          <span class="cl__bar-fill" :style="percent !== null ? { width: `${percent}%` } : undefined" />
        </div>
        <pre v-if="log.length" class="cl__log selectable" aria-label="git output"><span v-for="(l, i) in log" :key="i" class="cl__log-line">{{ l }}</span></pre>
      </div>

      <p v-if="error" class="cl__error" role="alert">
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
        :title="cloning ? 'Wait for git to finish' : undefined"
        @click="close"
      >
        Cancel
      </UiButton>
      <UiButton variant="primary" type="submit" form="clone-form" :loading="cloning">
        {{ cloning ? 'Cloning…' : phase === 'error' ? 'Try again' : 'Clone' }}
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
