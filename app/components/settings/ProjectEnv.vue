<script setup lang="ts">
import { CircleAlert, Eye, EyeOff, FilePlus, List, RefreshCw, TextCursorInput, Trash2, TriangleAlert } from 'lucide-vue-next'
import { useWorkspace, type EnvEditMode } from '~/stores/workspace'
import { envNameProblem, useProjectEnv } from '~/stores/projectEnv'
import { parseEnv } from '~/utils/dotenv'
import { isMod, modLabel } from '~/composables/useShortcuts'
import SettingsSection from './SettingsSection.vue'
import SettingsSegmented from './SettingsSegmented.vue'
import ProjectEnvFields from './ProjectEnvFields.vue'

/**
 * Project settings > Environment variables: the .env-style files at the active project's root
 * (a remote project's too; the backend reaches into its environment). Each file is edited as
 * rows or as raw text; both edit the same draft, which stays in memory (`stores/projectEnv.ts`)
 * until it is saved, so moving to another file, section or project keeps it.
 */
const ws = useWorkspace()
const env = useProjectEnv()
const mod = ref('Ctrl')
onMounted(() => { mod.value = modLabel() })

const root = computed(() => ws.activeProjectPath)
const files = computed(() => (root.value ? env.files[root.value] ?? [] : []))
const listing = computed(() => !!root.value && !!env.listing[root.value])
const listError = computed(() => (root.value ? env.listError[root.value] ?? null : null))
const selected = computed(() => (root.value ? env.selected[root.value] ?? null : null))
const current = computed(() => files.value.find(f => f.name === selected.value) ?? null)
const doc = computed(() => (root.value && selected.value ? env.doc(root.value, selected.value) : null))
const dirty = computed(() => !!doc.value && doc.value.text !== doc.value.saved)
const isDirty = (name: string) => !!root.value && env.isDirty(root.value, name)

/**
 * "Show values", for both modes. Kept in this component only, never persisted: leaving the
 * section unmounts it, and switching project (the watch on `root`) hides the values again.
 */
const revealed = ref(false)
const rawEl = ref<HTMLTextAreaElement | null>(null)
function showToEdit() {
  revealed.value = true
  void nextTick(() => rawEl.value?.focus())
}

function pick(name: string) {
  if (!root.value || name === selected.value) return
  resetTransient()
  env.select(root.value, name)
}

async function refresh() {
  const r = root.value
  if (!r) return
  await env.list(r)
  const s = env.selected[r]
  if (s) await env.read(r, s)
}

/* ---------- file tabs: arrow keys walk them ---------- */

const tabsEl = ref<HTMLElement | null>(null)
function onTabKey(e: KeyboardEvent) {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
  if (!keys.includes(e.key) || !files.value.length) return
  e.preventDefault()
  const i = files.value.findIndex(f => f.name === selected.value)
  const n = files.value.length
  const j = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + n) % n
  const f = files.value[j]
  if (!f) return
  pick(f.name)
  void nextTick(() => tabsEl.value?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus())
}

/* ---------- mode ---------- */

const modes: Array<{ value: EnvEditMode; label: string; icon: typeof List }> = [
  { value: 'fields', label: 'Fields', icon: List },
  { value: 'raw', label: 'Raw', icon: TextCursorInput },
]
const invalid = ref(0)
watch(() => ws.envEditMode, (m) => { if (m === 'raw') invalid.value = 0 })

const rawText = computed({
  get: () => doc.value?.text ?? '',
  /* A textarea hands back bare \n line breaks; keep the file's own CRLF. */
  set: (t: string) => setText(doc.value?.saved.includes('\r\n') ? t.replace(/\r?\n/g, '\r\n') : t),
})
function setText(t: string) {
  if (root.value && selected.value) env.setText(root.value, selected.value, t)
}

/* ---------- save, revert, conflicts ---------- */

/* A conflict is answered in its own prompt; a plain Save would only stop again. */
const canSave = computed(() => dirty.value && !doc.value?.saving && !doc.value?.conflict && invalid.value === 0)
const saveTitle = computed(() =>
  doc.value?.conflict ? 'The file changed on disk: reload it or overwrite it'
    : invalid.value ? 'Fix the names marked in red to save' : `Save (${mod.value}+S)`)

async function save(force = false) {
  if (!root.value || !selected.value) return
  if (!force && !canSave.value) return
  await env.save(root.value, selected.value, force)
}
function revert() {
  if (root.value && selected.value) env.revert(root.value, selected.value)
}
async function reloadFromDisk() {
  if (root.value && selected.value) await env.read(root.value, selected.value, true)
}

/**
 * The version on disk against the draft, by variable name only (values stay off screen). Read
 * when asked, kept only while the conflict prompt shows.
 */
const diskDiff = ref<{ added: string[]; removed: string[]; changed: string[] } | null>(null)
const diskBusy = ref(false)
const diskError = ref<string | null>(null)
const diffSame = computed(() =>
  !!diskDiff.value && !diskDiff.value.added.length && !diskDiff.value.removed.length && !diskDiff.value.changed.length)
async function compareWithDisk() {
  const r = root.value
  const name = selected.value
  const d = doc.value
  if (!r || !name || !d) return
  if (diskDiff.value) {
    diskDiff.value = null
    return
  }
  diskBusy.value = true
  diskError.value = null
  try {
    const disk = await env.diskText(r, name)
    // The last of a repeated name wins, as in most loaders.
    const vars = (text: string) => new Map(parseEnv(text).map(e => [e.key, e.value]))
    const onDisk = vars(disk)
    const mine = vars(d.text)
    diskDiff.value = {
      added: [...onDisk.keys()].filter(k => !mine.has(k)),
      removed: [...mine.keys()].filter(k => !onDisk.has(k)),
      changed: [...onDisk.keys()].filter(k => mine.has(k) && mine.get(k) !== onDisk.get(k)),
    }
  } catch (e) {
    diskError.value = e instanceof Error ? e.message : String(e)
  } finally {
    diskBusy.value = false
  }
}
watch(() => doc.value?.conflict, (on) => { if (!on) { diskDiff.value = null; diskError.value = null } })

/** Raw fits its text: about 8 lines at least, growing to 28 before it scrolls. */
const rawRows = computed(() => Math.min(28, Math.max(8, (doc.value?.text.split('\n').length ?? 0) + 1)))

function onKeydown(e: KeyboardEvent) {
  if (isMod(e) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
    e.preventDefault()
    void save()
  }
}

/* ---------- new file ---------- */

const creating = ref(false)
const newName = ref('')
const newError = ref<string | null>(null)
const newBusy = ref(false)
const newInput = ref<HTMLInputElement | null>(null)
const newId = useId()

function startNew() {
  const has = (n: string) => files.value.some(f => f.name === n)
  newName.value = !has('.env') ? '.env' : !has('.env.local') ? '.env.local' : ''
  newError.value = null
  creating.value = true
  confirmDelete.value = false
  void nextTick(() => { newInput.value?.focus(); newInput.value?.select() })
}
function cancelNew() {
  creating.value = false
  newError.value = null
}
async function createFile() {
  const r = root.value
  if (!r || newBusy.value) return
  const name = newName.value
  const problem = envNameProblem(name)
    ?? (files.value.some(f => f.name.toLowerCase() === name.toLowerCase()) ? `${name} is already here.` : null)
  if (problem) {
    newError.value = problem
    return
  }
  newBusy.value = true
  try {
    await env.create(r, name)
    creating.value = false
    void nextTick(() => tabsEl.value?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus())
  } catch (e) {
    newError.value = e instanceof Error ? e.message : String(e)
  } finally {
    newBusy.value = false
  }
}

/* ---------- delete ---------- */

const confirmDelete = ref(false)
const panelEl = ref<HTMLElement | null>(null)
/* The question takes focus, on its safe answer. */
watch(confirmDelete, async (on) => {
  if (!on) return
  await nextTick()
  panelEl.value?.querySelector<HTMLElement>('.pe__ask [data-autofocus]')?.focus()
})
const deleting = ref(false)
const deleteError = ref<string | null>(null)
async function deleteFile() {
  const r = root.value
  const name = selected.value
  if (!r || !name || deleting.value) return
  deleting.value = true
  deleteError.value = null
  try {
    await env.remove(r, name)
    confirmDelete.value = false
  } catch (e) {
    deleteError.value = e instanceof Error ? e.message : String(e)
  } finally {
    deleting.value = false
  }
}

/* ---------- git ---------- */

const ignoring = ref(false)
const ignoreError = ref<string | null>(null)
async function addToGitignore() {
  const r = root.value
  const name = selected.value
  if (!r || !name) return
  ignoring.value = true
  ignoreError.value = null
  try {
    await env.ignore(r, name)
  } catch (e) {
    ignoreError.value = e instanceof Error ? e.message : String(e)
  } finally {
    ignoring.value = false
  }
}

/** Questions and messages that belong to one file go away with it. */
function resetTransient() {
  confirmDelete.value = false
  deleteError.value = null
  ignoreError.value = null
  invalid.value = 0
  // Another file (or project) starts with its values hidden again.
  revealed.value = false
  diskDiff.value = null
  diskError.value = null
}

/** The project changed (or Settings opened): list its files and read the one shown. */
watch(root, async (r) => {
  resetTransient()
  cancelNew()
  revealed.value = false
  if (!r) return
  await env.list(r)
  const s = env.selected[r]
  if (s) await env.read(r, s)
}, { immediate: true })

const panelId = useId()
const tabId = (name: string) => `${panelId}-tab-${encodeURIComponent(name)}`
</script>

<template>
  <div class="pe" @keydown="onKeydown">
    <SettingsSection
      title="Environment variables"
      :description="`The .env files at the root of ${ws.activeProject?.name ?? 'the project'}. Changes stay here until you save them; values stay hidden until you show them.`"
    >
      <!-- Files, with the actions on files at the end of the row -->
      <div class="pe__files">
        <div
          v-if="files.length"
          ref="tabsEl"
          class="pe__tabs"
          role="tablist"
          aria-label="Environment files"
          @keydown="onTabKey"
        >
          <button
            v-for="f in files"
            :id="tabId(f.name)"
            :key="f.name"
            type="button"
            role="tab"
            class="pe__tab"
            :class="{ 'is-current': f.name === selected }"
            :aria-selected="f.name === selected"
            :aria-controls="panelId"
            :tabindex="f.name === selected ? 0 : -1"
            :title="isDirty(f.name) ? `${f.name}, unsaved changes` : f.name"
            @click="pick(f.name)"
          >
            <span class="pe__tab-name">{{ f.name }}</span>
            <span v-if="isDirty(f.name)" class="pe__dot" aria-hidden="true" />
          </button>
        </div>
        <div class="pe__files-actions">
          <UiButton v-if="files.length || creating" size="sm" :aria-expanded="creating" @click="creating ? cancelNew() : startNew()"><FilePlus />New file</UiButton>
          <UiIconButton size="sm" label="Look for files again" :disabled="listing" @click="refresh"><RefreshCw /></UiIconButton>
          <UiButton
            v-if="current && doc"
            size="sm"
            variant="ghost"
            :title="`Delete ${current.name}`"
            :aria-expanded="confirmDelete"
            @click="confirmDelete = !confirmDelete; creating = false"
          >
            <Trash2 />Delete file
          </UiButton>
        </div>
      </div>

      <form v-if="creating" class="pe__new" @submit.prevent="createFile" @keydown.esc.stop.prevent="cancelNew">
        <UiField label="File name" :for="newId" :error="newError" hint="Created empty at the root of the project. An example file that already exists, such as .env.example, is added to the list instead.">
          <div class="pe__new-row">
            <input
              :id="newId"
              ref="newInput"
              v-model="newName"
              class="input pe__new-input"
              type="text"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              placeholder=".env.local"
              @input="newError = null"
            >
            <UiButton size="sm" type="submit" variant="primary" :loading="newBusy">Create</UiButton>
            <UiButton size="sm" variant="ghost" @click="cancelNew">Cancel</UiButton>
          </div>
        </UiField>
      </form>

      <p v-if="listError" class="pe__note is-error selectable" role="alert">
        <CircleAlert aria-hidden="true" />The files could not be listed. {{ listError }}
      </p>
      <p v-else-if="listing && !files.length" class="pe__note" role="status">Looking for .env files…</p>
      <div v-else-if="!files.length && !creating" class="pe__empty">
        <p>
          This project has no .env files yet. Existing ones are picked up automatically; example and template files
          such as .env.example are left out until you add them by name with New file.
        </p>
        <UiButton size="sm" variant="primary" @click="startNew"><FilePlus />New file</UiButton>
      </div>

      <!-- The file shown -->
      <div
        v-if="current && doc"
        :id="panelId"
        ref="panelEl"
        class="pe__panel"
        role="tabpanel"
        :aria-labelledby="tabId(current.name)"
      >
        <div
          v-if="confirmDelete"
          class="pe__msg is-danger pe__ask"
          role="alertdialog"
          :aria-label="`Delete ${current.name}`"
          @keydown.esc.stop.prevent="confirmDelete = false"
        >
          <Trash2 class="pe__msg-icon" aria-hidden="true" />
          <p class="pe__msg-text">
            Delete <code>{{ current.name }}</code> from the project?
            <template v-if="dirty">Your unsaved changes go with it.</template>
            This can't be undone.
            <span v-if="deleteError" class="pe__msg-error selectable" role="alert">{{ deleteError }}</span>
          </p>
          <div class="pe__msg-actions">
            <UiButton size="sm" variant="ghost" data-autofocus @click="confirmDelete = false">Keep</UiButton>
            <UiButton size="sm" variant="danger" :loading="deleting" @click="deleteFile">Delete file</UiButton>
          </div>
        </div>

        <div v-if="current.ignored === false" class="pe__msg is-waiting" role="note">
          <TriangleAlert class="pe__msg-icon" aria-hidden="true" />
          <p class="pe__msg-text">
            <span class="pe__msg-lead">Not ignored by git,</span>
            so <code>{{ current.name }}</code> would be committed with your changes and its values shared with everyone who can read the repository.
            <span v-if="ignoreError" class="pe__msg-error selectable" role="alert">{{ ignoreError }}</span>
          </p>
          <div class="pe__msg-actions">
            <UiButton size="sm" :loading="ignoring" @click="addToGitignore">Add to .gitignore</UiButton>
          </div>
        </div>

        <div class="pe__bar">
          <SettingsSegmented
            :model-value="ws.envEditMode"
            :options="modes"
            label="Edit as"
            @update:model-value="ws.setEnvEditMode"
          />
          <UiButton
            v-if="!doc.unreadable && (ws.envEditMode === 'fields' || revealed)"
            size="sm"
            variant="ghost"
            :aria-pressed="revealed"
            @click="revealed = !revealed"
          >
            <EyeOff v-if="revealed" /><Eye v-else />{{ revealed ? 'Hide values' : 'Show values' }}
          </UiButton>
          <span class="pe__state" aria-live="polite">
            <template v-if="doc.saving">Saving…</template>
            <template v-else-if="dirty">Unsaved changes</template>
          </span>
          <template v-if="dirty || doc.saving">
            <UiButton size="sm" variant="ghost" :disabled="doc.saving" @click="revert">Revert</UiButton>
            <UiButton
              size="sm"
              :variant="creating || doc.conflict ? 'secondary' : 'primary'"
              :disabled="!canSave"
              :loading="doc.saving"
              :title="saveTitle"
              @click="save()"
            >
              Save
            </UiButton>
          </template>
        </div>

        <div v-if="doc.conflict" class="pe__msg is-waiting" role="alert">
          <TriangleAlert class="pe__msg-icon" aria-hidden="true" />
          <p class="pe__msg-text">
            <span class="pe__msg-lead">Not saved:</span> <code>{{ current.name }}</code> changed on disk since you opened it. Use the version on disk and drop your edits,
            or overwrite it with your version and lose the change made on disk.
            <span v-if="diskDiff && !diffSame" class="pe__diff">
              <span v-if="diskDiff.added.length" class="pe__diff-row"><span class="pe__diff-label">Only on disk</span><code>{{ diskDiff.added.join(', ') }}</code></span>
              <span v-if="diskDiff.removed.length" class="pe__diff-row"><span class="pe__diff-label">Only in yours</span><code>{{ diskDiff.removed.join(', ') }}</code></span>
              <span v-if="diskDiff.changed.length" class="pe__diff-row"><span class="pe__diff-label">Different values</span><code>{{ diskDiff.changed.join(', ') }}</code></span>
            </span>
            <span v-else-if="diffSame" class="pe__diff">Both have the same variables and values; only comments or layout differ.</span>
            <span v-if="diskError" class="pe__msg-error selectable" role="alert">{{ diskError }}</span>
          </p>
          <div class="pe__msg-actions">
            <UiButton size="sm" variant="ghost" :loading="diskBusy" :aria-expanded="!!diskDiff" @click="compareWithDisk">{{ diskDiff ? 'Hide differences' : 'Compare with disk' }}</UiButton>
            <UiButton size="sm" :disabled="doc.saving" @click="reloadFromDisk">Use the disk version</UiButton>
            <UiButton size="sm" variant="danger" :loading="doc.saving" @click="save(true)">Overwrite the file</UiButton>
          </div>
        </div>
        <div v-else-if="doc.error" class="pe__msg is-danger" role="alert">
          <CircleAlert class="pe__msg-icon" aria-hidden="true" />
          <p class="pe__msg-text selectable">{{ doc.error }}</p>
          <div class="pe__msg-actions">
            <UiButton size="sm" variant="ghost" @click="doc.error = null">Dismiss</UiButton>
          </div>
        </div>


        <p v-if="doc.loading && !doc.saved && !dirty" class="pe__note" role="status">Reading {{ current.name }}…</p>
        <p v-else-if="doc.unreadable" class="pe__note">
          {{ current.name }} {{ doc.unreadable === 'binary' ? 'is not a text file' : 'is too large' }}, so it can't be edited here.
        </p>
        <template v-else>
          <ProjectEnvFields
            v-if="ws.envEditMode === 'fields'"
            :doc-key="`${root}\u0000${current.name}`"
            :text="doc.text"
            :revealed="revealed"
            @update:text="setText"
            @invalid="invalid = $event"
          />
          <div v-else-if="!revealed" class="pe__msg pe__gate" :style="{ '--rows': rawRows }">
            <EyeOff class="pe__msg-icon" aria-hidden="true" />
            <p class="pe__msg-text">The values in <code>{{ current.name }}</code> are hidden.</p>
            <div class="pe__msg-actions">
              <UiButton size="sm" @click="showToEdit"><Eye />Show values to edit</UiButton>
            </div>
          </div>
          <textarea
            v-else
            ref="rawEl"
            v-model="rawText"
            :rows="rawRows"
            class="pe__raw"
            :aria-label="`${current.name} as text`"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            data-1p-ignore
            data-lpignore="true"
            wrap="off"
            placeholder="NAME=value"
          />
        </template>
      </div>
    </SettingsSection>
  </div>
</template>

<style scoped>
/* ---- files: tabs with the file actions at the end ---- */
.pe__files {
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
  border-bottom: 1px solid var(--line-soft);
}
.pe__tabs {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}
.pe__tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  height: 32px;
  padding: 0 var(--space-3);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.pe__tab:hover { background: var(--bg-hover); color: var(--fg); }
.pe__tab.is-current { color: var(--fg); box-shadow: inset 0 -2px 0 var(--accent); }
.pe__tab-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pe__dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
.pe__files-actions { display: flex; align-items: center; gap: var(--space-1); margin-left: auto; padding-bottom: 3px; }

/* ---- new file: an inline field, not a dialog ---- */
.pe__new { margin-top: var(--space-4); }
.pe__new-row { display: flex; align-items: center; gap: var(--space-2); }
.pe__new-row .pe__new-input { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: var(--text-xs); }

.pe__note {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: var(--space-4) 0 0;
  font-size: var(--text-sm);
  color: var(--fg-subtle);
}
.pe__note svg { flex: none; width: 15px; height: 15px; margin-top: 1px; stroke-width: 1.85; color: var(--ripe-error); }
.pe__note.is-error { color: var(--ripe-error-fg); }

.pe__empty {
  display: grid;
  justify-items: start;
  gap: var(--space-3);
  margin-top: var(--space-5);
}
.pe__empty p { margin: 0; max-width: 58ch; font-size: var(--text-sm); color: var(--fg-subtle); text-wrap: pretty; }

/* ---- the file ---- */
.pe__panel { display: grid; gap: var(--space-3); margin-top: var(--space-3); }
.pe__bar { display: flex; align-items: center; gap: var(--space-2); min-height: 26px; }
.pe__state { margin-left: auto; font-size: var(--text-xs); color: var(--fg-subtle); white-space: nowrap; }

/*
 * Messages: icon, text, then the answers at the end of the row; on a narrow window the answers
 * wrap under the text. Only the tone changes between them.
 */
.pe__msg {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: var(--space-2) var(--space-3);
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
  --msg-tone: var(--fg-subtle);
}
.pe__msg.is-waiting {
  --msg-tone: var(--ripe-waiting);
  border-color: color-mix(in oklch, var(--ripe-waiting) 35%, transparent);
  background: color-mix(in oklch, var(--ripe-waiting) 6%, transparent);
}
.pe__msg.is-danger {
  --msg-tone: var(--ripe-error);
  border-color: color-mix(in oklch, var(--ripe-error) 35%, transparent);
  background: color-mix(in oklch, var(--ripe-error) 7%, transparent);
}
.pe__msg-icon { flex: none; width: 15px; height: 15px; margin-top: 5px; stroke-width: 1.85; color: var(--msg-tone); }
.pe__msg-text {
  flex: 1 1 32ch;
  min-width: 0;
  margin: 0;
  padding: 3px 0;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--fg-muted);
  text-wrap: pretty;
}
.pe__msg-text code { font-size: var(--text-xs); color: var(--fg); }
.pe__msg.is-waiting .pe__msg-lead { font-weight: 560; color: var(--ripe-waiting-fg); }
.pe__msg.is-danger .pe__msg-text.selectable { color: var(--ripe-error-fg); }
.pe__msg-error { display: block; margin-top: var(--space-1); font-size: var(--text-xs); color: var(--ripe-error-fg); }
/* The conflict's comparison: names only, never values. */
.pe__diff { display: grid; gap: 2px; margin-top: var(--space-2); font-size: var(--text-xs); color: var(--fg-subtle); }
.pe__diff-row { display: flex; gap: var(--space-3); min-width: 0; }
.pe__diff-label { flex: none; width: 9.5em; color: var(--fg-subtle); }
.pe__diff-row code { min-width: 0; overflow-wrap: anywhere; }

.pe__msg-actions { display: flex; flex-wrap: wrap; gap: var(--space-1); margin-left: auto; }

/* Raw while the values are hidden: a calm gate where the text would be. */
.pe__gate {
  align-items: center;
  align-content: center;
  /* As tall as the text it stands in for, so showing it doesn't move what is below. */
  min-height: calc(var(--rows, 8) * 1.6 * var(--text-xs) + var(--space-2) * 2 + 2px);
  padding-block: var(--space-3);
  background: var(--bg-inset);
}
.pe__gate .pe__msg-icon { margin-top: 0; }
.pe__gate .pe__msg-text { padding: 0; }

.pe__raw {
  display: block;
  width: 100%;
  /* Sized by `rows` (the text's lines, 8 to 28), not by the window. */
  padding: var(--space-2) var(--space-3);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.6;
  tab-size: 4;
  color: var(--fg);
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  resize: none;
  overflow: auto;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.pe__raw::placeholder { color: var(--fg-faint); }
.pe__raw:focus-visible { outline: none; }
.pe__raw:focus { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
</style>
