<script setup lang="ts">
import { ChevronDown, CircleAlert, FolderPlus, ShieldAlert } from 'lucide-vue-next'
import type { PluginProbe } from '~/types/ipc'
import { on } from '~/composables/useBackend'
import { pluginJobId, usePlugins } from '~/stores/plugins'
import { addLocalFolder, openPlugins, usePluginsView } from '~/composables/pluginsView'
import { parsePluginSource } from '~/utils/pluginSource'

/**
 * Add plugin: a repository link (a folder in it, a branch or tag), checked first (`plugins_probe`), then
 * the plugins found in it to pick from, with a trust notice and the commit that will be installed.
 * "Add local folder" uses a folder on this computer in place instead.
 */
const plugins = usePlugins()
const view = usePluginsView()

type Step = 'link' | 'probing' | 'pick' | 'installing'
const step = ref<Step>('link')
const link = ref('')
const ref_ = ref('')
const folder = ref('')
const more = ref(false)
const tried = ref(false)
const error = ref<string | null>(null)
const lines = ref<string[]>([])
const probe = ref<PluginProbe | null>(null)
const picked = ref<string[]>([])
const linkId = useId()
const refId = useId()
const folderId = useId()

/** Each probe has a number; a dialog closed or restarted meanwhile ignores the old answer. */
let seq = 0

watch(() => view.addOpen, (open) => {
  if (!open) return
  seq++
  step.value = 'link'
  link.value = view.addLink
  ref_.value = ''
  folder.value = ''
  more.value = false
  tried.value = false
  error.value = null
  lines.value = []
  probe.value = null
  picked.value = []
})

const parsed = computed(() => parsePluginSource(link.value, { ref: ref_.value, subpath: folder.value }))
const fieldError = computed(() => (tried.value && !parsed.value.ok ? parsed.value.error : null))

async function check() {
  tried.value = true
  error.value = null
  const p = parsed.value
  if (!p.ok) return
  const mine = ++seq
  const jobId = pluginJobId()
  step.value = 'probing'
  lines.value = []
  const stop = await on('plugins://progress', (e) => {
    if (e.jobId !== jobId || mine !== seq) return
    const line = e.line.trim()
    if (!line) return
    // git rewrites one line while it counts: keep the latest of each kind.
    const head = line.replace(/[\d(].*$/, '')
    const last = lines.value[lines.value.length - 1]
    if (last && head && last.startsWith(head)) lines.value[lines.value.length - 1] = line
    else lines.value = [...lines.value.slice(-5), line]
  })
  try {
    const result = await plugins.probe({ kind: 'git', ...p.source }, jobId)
    if (mine !== seq) return
    if (!result.candidates.length) {
      error.value = 'No plugin was found in that repository: there is no mango-plugin.json in it (a few folders deep). Check the link, or name the folder that holds the plugin.'
      step.value = 'link'
      return
    }
    probe.value = result
    picked.value = result.candidates.length === 1 ? [result.candidates[0]!.subpath] : result.candidates.filter(c => !c.installed).map(c => c.subpath)
    step.value = 'pick'
  } catch (e) {
    if (mine !== seq) return
    error.value = e instanceof Error ? e.message : String(e)
    step.value = 'link'
  } finally {
    stop()
  }
}

const allPicked = computed(() => !!probe.value && picked.value.length === probe.value.candidates.length)
function toggleAll() {
  picked.value = allPicked.value ? [] : probe.value?.candidates.map(c => c.subpath) ?? []
}

async function install() {
  if (!probe.value || !picked.value.length) return
  const mine = ++seq
  step.value = 'installing'
  error.value = null
  try {
    const added = await plugins.install(probe.value.probeId, picked.value)
    for (const a of added) if (!a.enabled) await plugins.setEnabled(a.manifest.id, true)
    if (mine !== seq) return
    view.addOpen = false
    openPlugins(added.length === 1 ? { tab: 'installed', detail: added[0]!.manifest.id } : { tab: 'installed' })
  } catch (e) {
    if (mine !== seq) return
    error.value = e instanceof Error ? e.message : String(e)
    step.value = 'pick'
  }
}

const localBusy = ref(false)
async function addLocal() {
  localBusy.value = true
  error.value = null
  try {
    const id = await addLocalFolder()
    if (id) {
      seq++
      view.addOpen = false
      openPlugins({ tab: 'installed', detail: id })
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    localBusy.value = false
  }
}

function back() {
  seq++
  step.value = 'link'
  error.value = null
}
function close() {
  seq++
  view.addOpen = false
}

const title = computed(() => (step.value === 'pick' || step.value === 'installing') && probe.value && probe.value.candidates.length > 1
  ? 'Choose plugins to install'
  : 'Add plugin')
const installLabel = computed(() => (picked.value.length > 1 ? `Install ${picked.value.length} plugins` : 'Install'))
</script>

<template>
  <UiDialog :open="view.addOpen" :title="title" :width="560" :dismissible="step !== 'installing'" @close="close">
    <form v-if="step === 'link' || step === 'probing'" id="plugin-add-form" class="pa" @submit.prevent="check">
      <UiField label="Repository link" :for="linkId" :error="fieldError">
        <input
          :id="linkId"
          v-model="link"
          class="input mono-input"
          type="text"
          placeholder="https://github.com/owner/repo"
          spellcheck="false"
          autocomplete="off"
          :disabled="step === 'probing'"
        >
      </UiField>

      <!-- What the link is read as, live -->
      <dl v-if="parsed.ok" class="pa__read" aria-label="Read as">
        <div><dt>Repository</dt><dd class="selectable">{{ parsed.repo }}</dd></div>
        <div><dt>Branch or tag</dt><dd :class="{ 'is-default': !parsed.source.ref }">{{ parsed.source.ref ?? 'Default branch' }}</dd></div>
        <div><dt>Folder</dt><dd :class="{ 'is-default': !parsed.source.subpath }">{{ parsed.source.subpath ?? 'Every plugin in the repository' }}</dd></div>
      </dl>
      <p v-else-if="!fieldError && !parsed.empty" class="pa__hint" :class="{ 'is-local': parsed.local }">{{ parsed.error }}</p>
      <p v-else-if="!fieldError" class="pa__hint">
        A repository, or a folder in one: a GitHub, GitLab or Codeberg link to the folder works, as does
        <code>git@host:owner/repo.git</code>. Add <code>#branch:folder</code> to pick a branch and folder.
      </p>

      <button type="button" class="pa__more" :aria-expanded="more" @click="more = !more">
        <ChevronDown aria-hidden="true" :class="{ 'is-open': more }" />Branch and folder
      </button>
      <div v-if="more" class="pa__fields">
        <UiField label="Branch, tag or commit" :for="refId" hint="Empty: the repository's default branch.">
          <input :id="refId" v-model="ref_" class="input mono-input" type="text" placeholder="main" spellcheck="false" autocomplete="off" :disabled="step === 'probing'">
        </UiField>
        <UiField label="Folder" :for="folderId" hint="Empty: list every plugin in the repository.">
          <input :id="folderId" v-model="folder" class="input mono-input" type="text" placeholder="plugins/my-plugin" spellcheck="false" autocomplete="off" :disabled="step === 'probing'">
        </UiField>
      </div>

      <div v-if="step === 'probing'" class="pa__progress" aria-live="polite">
        <p class="pa__progress-title">Checking the repository…</p>
        <pre v-if="lines.length" class="pa__lines selectable">{{ lines.join('\n') }}</pre>
      </div>
      <p v-if="error" class="pa__error selectable" role="alert"><CircleAlert aria-hidden="true" /><span>{{ error }}</span></p>
    </form>

    <div v-else class="pa">
      <p class="pa__from">
        From <span class="mono selectable">{{ parsed.ok ? parsed.repo : probe?.url }}</span><template v-if="probe?.ref"> at <span class="mono">{{ probe.ref }}</span></template>,
        commit <span class="mono selectable" :title="probe?.commit">{{ probe?.commit.slice(0, 10) }}</span>
      </p>

      <div v-if="probe" class="pa__cands">
        <label v-if="probe.candidates.length > 1" class="pa__all">
          <input type="checkbox" :checked="allPicked" :indeterminate="picked.length > 0 && !allPicked" :disabled="step === 'installing'" @change="toggleAll">
          Select all <span class="tabular">({{ picked.length }} of {{ probe.candidates.length }})</span>
        </label>
        <ul class="pa__list" aria-label="Plugins in the repository">
          <li v-for="c in probe.candidates" :key="c.subpath">
            <label class="pa__cand">
              <input v-model="picked" type="checkbox" :value="c.subpath" :disabled="step === 'installing' || probe.candidates.length === 1">
              <span class="pa__cand-text">
                <span class="pa__cand-line">
                  <span class="pa__cand-name">{{ c.manifest.name }}</span>
                  <span class="pa__cand-ver tabular">{{ c.manifest.version }}</span>
                  <span v-if="c.installed" class="pa__cand-installed">Installed: this replaces it</span>
                </span>
                <span v-if="c.manifest.description" class="pa__cand-desc">{{ c.manifest.description }}</span>
                <span class="pa__cand-meta">
                  <span class="mono">{{ c.manifest.id }}</span>
                  <span class="mono" :title="c.subpath || 'Repository root'">{{ c.subpath || '/' }}</span>
                  <span v-if="c.manifest.author">{{ c.manifest.author }}</span>
                </span>
              </span>
            </label>
          </li>
        </ul>
      </div>

      <div class="pa__trust">
        <ShieldAlert aria-hidden="true" />
        <p>
          Plugins run inside Mango with full access to Mango, your projects and your chats. Install only from sources you trust;
          you can read the code at this commit first.
        </p>
      </div>
      <p v-if="error" class="pa__error selectable" role="alert"><CircleAlert aria-hidden="true" /><span>{{ error }}</span></p>
    </div>

    <template #footer>
      <UiButton v-if="step === 'link' || step === 'probing'" variant="ghost" class="pa__local" :loading="localBusy" :disabled="step === 'probing'" @click="addLocal">
        <FolderPlus v-if="!localBusy" />Add local folder…
      </UiButton>
      <UiButton v-if="step === 'pick' || step === 'installing'" variant="ghost" class="pa__local" :disabled="step === 'installing'" @click="back">Back</UiButton>
      <UiButton variant="ghost" :disabled="step === 'installing'" @click="close">Cancel</UiButton>
      <UiButton v-if="step === 'link' || step === 'probing'" type="submit" form="plugin-add-form" variant="primary" :loading="step === 'probing'">Check repository</UiButton>
      <UiButton v-else variant="primary" :loading="step === 'installing'" :disabled="!picked.length" @click="install">{{ installLabel }}</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.pa { display: grid; gap: var(--space-3); }
.pa :deep(.mono-input) { font-family: var(--font-mono); font-size: var(--text-xs); }
.pa code, .mono { font-family: var(--font-mono); font-size: var(--text-xs); }
.pa code { color: var(--fg-muted); }

.pa__hint { margin: calc(var(--space-1) * -1) 0 0; font-size: var(--text-xs); color: var(--fg-subtle); text-wrap: pretty; }
.pa__hint.is-local { color: var(--ripe-waiting-fg); }

.pa__read {
  display: grid;
  gap: 2px;
  margin: calc(var(--space-1) * -1) 0 0;
  padding: var(--space-2) var(--space-3);
  background: var(--bg-inset);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
}
.pa__read > div { display: grid; grid-template-columns: 100px minmax(0, 1fr); gap: var(--space-2); align-items: baseline; }
.pa__read dt { font-size: var(--text-xs); color: var(--fg-subtle); }
.pa__read dd {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--fg);
}
.pa__read dd.is-default { font-family: var(--font-sans); color: var(--fg-faint); }

.pa__more {
  justify-self: start;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 6px 0 2px;
  font-size: var(--text-xs);
  font-weight: 560;
  color: var(--fg-subtle);
  border-radius: var(--radius-xs);
}
.pa__more:hover { color: var(--fg); background: var(--bg-hover); }
.pa__more svg { width: 14px; height: 14px; stroke-width: 1.85; transform: rotate(-90deg); transition: transform var(--dur-fast) var(--ease-out); }
.pa__more svg.is-open { transform: none; }
.pa__fields { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.pa__fields :deep(.field + .field) { margin-top: 0; }

.pa__progress { display: grid; gap: var(--space-2); }
.pa__progress-title { margin: 0; font-size: var(--text-sm); color: var(--ripe-running-fg); }
.pa__lines {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  max-height: 120px;
  overflow: auto;
  background: var(--bg-inset);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  line-height: 1.55;
  color: var(--fg-subtle);
  white-space: pre-wrap;
}

.pa__error {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--text-sm);
  color: var(--ripe-error-fg);
}
.pa__error svg { flex: none; width: 15px; height: 15px; margin-top: 2px; stroke-width: 1.85; color: var(--ripe-error); }
.pa__error span { min-width: 0; overflow-wrap: anywhere; text-wrap: pretty; }

.pa__from { margin: 0; font-size: var(--text-sm); color: var(--fg-subtle); overflow-wrap: anywhere; }
.pa__from .mono { color: var(--fg); }

.pa__cands { display: grid; gap: var(--space-1); }
.pa__all { display: inline-flex; align-items: center; gap: var(--space-2); justify-self: start; font-size: var(--text-xs); font-weight: 560; color: var(--fg-muted); }
.pa__list { margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--line-soft); }
.pa__list > li { border-bottom: 1px solid var(--line-soft); }
.pa__cand { display: flex; align-items: flex-start; gap: var(--space-3); padding: var(--space-2) 0; cursor: pointer; }
.pa__cand input { margin-top: 3px; }
.pa input[type='checkbox'] { flex: none; width: 14px; height: 14px; accent-color: var(--accent); }
.pa__cand-text { flex: 1; min-width: 0; display: grid; gap: 2px; }
.pa__cand-line { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; }
.pa__cand-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); font-weight: 600; color: var(--fg); }
.pa__cand-ver { flex: none; font-size: var(--text-xs); color: var(--fg-faint); }
.pa__cand-installed { flex: none; margin-left: auto; font-size: var(--text-xs); font-weight: 560; color: var(--ripe-waiting-fg); }
.pa__cand-desc { font-size: var(--text-xs); color: var(--fg-muted); text-wrap: pretty; }
.pa__cand-meta { display: flex; gap: var(--space-3); min-width: 0; font-size: var(--text-xs); color: var(--fg-faint); }
.pa__cand-meta > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.pa__trust {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid color-mix(in oklch, var(--ripe-waiting) 40%, transparent);
  border-radius: var(--radius-sm);
}
.pa__trust svg { flex: none; width: 15px; height: 15px; margin-top: 2px; stroke-width: 1.85; color: var(--ripe-waiting); }
.pa__trust p { margin: 0; font-size: var(--text-xs); color: var(--fg-muted); text-wrap: pretty; }

.pa__local { margin-right: auto; }
:deep(.pa__local svg) { width: 14px; height: 14px; }
</style>
