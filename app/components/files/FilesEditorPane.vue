<script setup lang="ts">
import type * as Monaco from 'monaco-editor'
import { CircleAlert, Code, Eye, FileWarning, FolderTree, Save, ShieldQuestion, X } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { closeFileTab, useFiles } from '~/stores/files'
import { parseFileTab } from '~/utils/fileTabs'
import { editorModel, type EditorModel } from '~/utils/editorModels'
import { cssVar } from '~/utils/cssColor'
import { MONACO_THEME, languageFor, loadMonaco, type MonacoApi } from '~/composables/monaco'
import { pluginLanguage } from '~/plugin-host/fileHooks'
import { imageKind, svgSize, svgUrl } from '~/utils/imageFiles'
import { changeMarkers, type ChangeMarkers } from '~/composables/changeMarkers'
import { useGit } from '~/stores/git'
import { call } from '~/composables/useBackend'
import { documentFor, needsNewModel, takePosition } from '~/composables/editorDocuments'
import { COMPLETION_OPTIONS, caretGlide, quickSuggestions, widgetsOverBrowsers } from '~/composables/editorFeel'
import { languageService } from '~/lsp/service'
import { lspLanguage } from '~/lsp/languages'
import { useLanguageServers } from '~/lsp/store'
import { isEnvPath } from '~/utils/envPath'
import FilesLanguageStatus from './FilesLanguageStatus.vue'

/**
 * A project file open in the main pane, edited with Monaco. Pictures open in
 * the image viewer instead; an SVG shows as a picture with its source (in
 * Monaco) one switch away, and the picture follows unsaved edits. Each tab keeps
 * its own model (edits, undo, scroll) while it is open; the store holds what
 * is on disk and decides when a save would overwrite someone else's change.
 */
const props = defineProps<{ tabId: string; paneId: string; split: boolean; active: boolean }>()

const ws = useWorkspace()
const threads = useThreads()
const files = useFiles()
const git = useGit()
const servers = useLanguageServers()

const tab = computed(() => parseFileTab(props.tabId))
const file = computed(() => files.file(props.tabId))
/** The file can be shown as text. */
const editable = computed(() => !!file.value && !file.value.error && !file.value.binary && !file.value.tooLarge && file.value.disk !== null)
const kind = computed(() => (tab.value ? imageKind(tab.value.file) : null))
/** An SVG showing as a picture rather than as code. */
const svgPreview = computed(() => kind.value === 'svg' && editable.value && file.value?.view !== 'code')

/** The SVG as the editor has it (unsaved edits included), for the picture. */
const svgText = ref('')
let svgTimer: ReturnType<typeof setTimeout> | undefined
function readSvg() {
  clearTimeout(svgTimer)
  if (kind.value !== 'svg') return
  const entry = editorModel(props.tabId)
  svgText.value = entry && !entry.model.isDisposed() ? entry.model.getValue() : file.value?.disk ?? ''
}
watch(() => [props.tabId, file.value?.version, file.value?.view] as const, readSvg, { immediate: true })
onBeforeUnmount(() => clearTimeout(svgTimer))

/** What the image viewer shows, if anything. */
const picture = computed(() => {
  const f = file.value
  if (!f || f.error) return null
  if (kind.value === 'raster' && f.image) return { src: f.image, vector: false, intrinsic: null }
  if (svgPreview.value) return { src: svgUrl(svgText.value), vector: true, intrinsic: svgSize(svgText.value) }
  return null
})

const host = ref<HTMLElement | null>(null)
let monaco: MonacoApi | null = null
let editor: Monaco.editor.IStandaloneCodeEditor | null = null
let fontObserver: MutationObserver | null = null
let shownTab: string | null = null
/** The model entry behind `shownTab`; held itself, as a rename gives it another tab id. */
let shownEntry: EditorModel | null = null
let contentSub: Monaco.IDisposable | null = null
let markers: ChangeMarkers | null = null
let caret: ReturnType<typeof caretGlide> | null = null
let widgets: ReturnType<typeof widgetsOverBrowsers> | null = null
const failed = ref<string | null>(null)

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
/** Mango's Animations setting, as resolved on the root (`ws.applyTheme`): "Full" is full whatever the OS says. */
const motion = ref(true)
const readMotion = () => { motion.value = document.documentElement.dataset.motion !== 'reduced' }
readMotion()
const glides = computed(() => ws.editorSmoothCaret && motion.value)
/** The fade is motion too. */
const blinking = () => (motion.value ? 'smooth' : 'blink')
watch(motion, () => editor?.updateOptions({ cursorBlinking: blinking() }))

function fontFamily() {
  return cssVar('--font-mono') || 'ui-monospace, monospace'
}

/** The shown model's Monaco language. */
const language = ref<string | null>(null)
function applyLanguage(model: Monaco.editor.ITextModel) {
  language.value = model.getLanguageId()
  editor?.updateOptions({ quickSuggestions: quickSuggestions(language.value) })
}

/** A clean file renamed to another kind of script waits for a model with the new name. */
const modelDue = computed(() => {
  const f = file.value
  const entry = f && !f.dirty && !f.saving ? editorModel(props.tabId) : null
  return !!entry && needsNewModel(entry, f!.file)
})

/* A plugin gave this kind of file a language (or took it back): plugins start after the tabs are back. */
watch(() => (tab.value ? pluginLanguage(tab.value.file) : null), () => {
  const model = editorModel(props.tabId)?.model
  if (!monaco || !tab.value || !model || model.isDisposed()) return
  monaco.editor.setModelLanguage(model, languageFor(monaco, tab.value.file))
  if (editor?.getModel() === model) applyLanguage(model)
})

function syncDirty() {
  const entry = shownTab ? editorModel(shownTab) : null
  if (!entry || !shownTab) return
  // Still being brought up to date with the disk (`reloadDocument`): that is no edit.
  if (entry.loadedVersion !== files.file(shownTab)?.version) return
  files.setDirty(shownTab, entry.model.getAlternativeVersionId() !== entry.savedVersion)
}

/**
 * A field has the keyboard (a name in the Files tree, the commit message). An editor can arrive seconds
 * after it was asked for: what is being typed would end up in its file.
 */
function typingElsewhere() {
  const el = document.activeElement
  return !!el?.matches('input, textarea, [contenteditable="true"]') && !el.closest('.monaco-editor')
}

/**
 * Put the current tab's model in the editor, keeping the previous one's scroll and cursor. Also after
 * a reload from disk: then scroll, cursor and keyboard focus stay as they are.
 */
function show() {
  if (!editor || !monaco) return
  const before = editor.getModel()
  if (shownEntry && before && shownEntry.model === before) shownEntry.viewState = editor.saveViewState()
  caret?.still()
  const doc = editable.value && file.value ? documentFor(monaco, props.tabId, file.value) : null
  const model = doc?.entry.model ?? null
  const switched = before !== model || shownTab !== props.tabId
  if (before !== model) editor.setModel(model)
  // It may have been hidden until just now: measure it, or a line is revealed in a viewport of nothing.
  if (switched && model) editor.layout()
  shownTab = model ? props.tabId : null
  shownEntry = doc?.entry ?? null
  doc?.replaced?.dispose()
  if (!model) return
  languageService()?.track()
  applyLanguage(model)
  if (switched && doc!.entry.viewState) editor.restoreViewState(doc!.entry.viewState)
  syncDirty()
  readSvg()
  void loadBase()
  revealAsked()
  // A hidden editor must not take the keyboard: typing would change a file nobody is looking at.
  if (switched && props.active && !svgPreview.value && !files.deleting.length && !typingElsewhere()) editor.focus()
}

/** A line someone asked to see (`files.revealLine`, a plugin's `openFile`): scroll there and put the cursor on it. */
function revealAsked() {
  const line = files.lines[props.tabId]
  const model = editor?.getModel()
  if (!editor || !line || !model || shownTab !== props.tabId) return
  delete files.lines[props.tabId]
  // A jump to a definition knows the column too.
  const exact = takePosition(props.tabId, line)
  const at = model.validatePosition(exact ?? { lineNumber: line, column: 1 })
  editor.setPosition(at)
  if (exact) editor.revealPositionInCenterIfOutsideViewport(at)
  else editor.revealPositionInCenter(at)
}
watch(() => files.lines[props.tabId], revealAsked)

async function setUp() {
  if (editor || !host.value) return
  try {
    monaco = await loadMonaco()
    // Measure glyphs with the real font, not a fallback that is about to be swapped.
    await document.fonts?.load(`12.5px ${fontFamily()}`).catch(() => {})
    if (!host.value || editor) return
    editor = monaco.editor.create(host.value, {
      model: null,
      theme: MONACO_THEME,
      automaticLayout: true,
      fontFamily: fontFamily(),
      fontSize: 12.5,
      lineHeight: 19,
      fontLigatures: false,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      bracketPairColorization: { enabled: false },
      guides: { indentation: true, bracketPairs: false },
      padding: { top: 10, bottom: 10 },
      smoothScrolling: !reducedMotion(),
      // Mango's own glide (`caretGlide`): Monaco's is too short to see, and runs while the page moves.
      cursorSmoothCaretAnimation: 'off',
      cursorBlinking: blinking(),
      ...COMPLETION_OPTIONS,
      fixedOverflowWidgets: true,
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      stickyScroll: { enabled: true },
      lineDecorationsWidth: 14,
    })
    markers = changeMarkers(monaco, editor)
    caret = caretGlide(monaco, editor, () => glides.value)
    widgets = widgetsOverBrowsers(editor)
    monaco.editor.remeasureFonts()
    contentSub = editor.onDidChangeModelContent(() => {
      syncDirty()
      if (kind.value === 'svg') { clearTimeout(svgTimer); svgTimer = setTimeout(readSvg, 120) }
    })
    editor.onDidFocusEditorText(() => threads.focusPane(props.paneId))
    // A new code font (Settings > Appearance) reaches the open editor too.
    fontObserver = new MutationObserver(async () => {
      caret?.still()
      await document.fonts?.load(`12.5px ${fontFamily()}`).catch(() => {})
      editor?.updateOptions({ fontFamily: fontFamily() })
    })
    fontObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-font-mono'] })
    show()
  } catch (e) {
    failed.value = e instanceof Error ? e.message : String(e)
  }
}

const motionObserver = new MutationObserver(readMotion)
onMounted(() => {
  motionObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] })
  if (editable.value) void setUp()
})

// Opened before the read finished, switched to another file tab in this pane, or reloaded from disk.
watch(() => [props.tabId, editable.value, file.value?.version, modelDue.value] as const, async () => {
  if (!editable.value) {
    if (editor) { editor.setModel(null); shownTab = null; shownEntry = null }
    return
  }
  if (!editor) return setUp()
  // Once `v-show` has shown it: the editor of a file that was still loading cannot take the keyboard before.
  await nextTick()
  if (editable.value) show()
})

// Not for a pane that comes forward because a file was deleted: the next Delete would edit this one.
watch(() => props.active, (active) => { if (active && editor && shownTab && !svgPreview.value && !files.deleting.length) editor.focus() })

/* ---------- change markers ---------- */

/**
 * The committed version each tab was compared with, and the commit it was read at: read again
 * once HEAD moves (a commit, a checkout), as far as the Changes view has seen.
 */
const bases = new Map<string, { head: string; text: string | null }>()
const head = computed(() => (tab.value ? git.status(tab.value.projectPath)?.head ?? '' : ''))

async function loadBase() {
  const id = props.tabId
  const t = tab.value
  if (!markers || !t || shownTab !== id) return
  const at = head.value
  let entry = bases.get(id)
  if (!entry || entry.head !== at) {
    // No committed version, or none readable: no markers.
    const text = await call('git_base', { path: t.projectPath, file: t.file }).catch(() => null)
    entry = { head: at, text }
    bases.set(id, entry)
  }
  if (markers && shownTab === id) markers.setBase(entry.text)
}
watch(head, () => void loadBase())

function setView(view: 'preview' | 'code') {
  files.setView(props.tabId, view)
  if (view === 'code') nextTick(() => editor?.focus())
}

onBeforeUnmount(() => {
  if (editor && shownEntry && !shownEntry.model.isDisposed()) shownEntry.viewState = editor.saveViewState()
  contentSub?.dispose()
  markers?.dispose()
  markers = null
  caret?.dispose()
  caret = null
  widgets?.dispose()
  widgets = null
  motionObserver.disconnect()
  // The model stays (the tab is still open); only this view of it goes.
  editor?.setModel(null)
  fontObserver?.disconnect()
  editor?.dispose()
  editor = null
})

/* ---------- actions ---------- */

/* "Save before closing?" takes the keyboard: focus goes to Save, Escape cancels. */
const closeSave = ref<{ $el: HTMLElement } | null>(null)
watch(() => file.value?.closing, async (closing) => {
  if (!closing) return
  await nextTick()
  closeSave.value?.$el?.focus()
})

const f = file
async function save() {
  if (f.value?.dirty) await files.save(props.tabId)
}
async function saveAndClose() {
  // Text typed while it saved is not saved: then it stays open.
  if (await files.save(props.tabId) && !files.isDirty(props.tabId)) closeFileTab(props.tabId)
}
function discardAndClose() {
  closeFileTab(props.tabId)
}
async function overwrite() {
  await files.save(props.tabId, true)
}
async function reload() {
  await files.revert(props.tabId)
  // The bar that had the keyboard is gone.
  await nextTick()
  if (props.active && !typingElsewhere()) editor?.focus()
}
function revealInTree() {
  if (!tab.value) return
  ws.openTool('files')
  void files.reveal(tab.value.projectPath, tab.value.file)
}

function formatSize(n: number) {
  if (n < 1024) return `${n} bytes`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/* ---------- saving, as the header tells it */

/** With autosave only a save slow enough to wonder about gets a word. */
const SLOW_SAVE_MS = 1500
const savingSlowly = ref(false)
let slowTimer: ReturnType<typeof setTimeout> | undefined
watch(() => [props.tabId, !!file.value?.saving] as const, ([, saving]) => {
  clearTimeout(slowTimer)
  savingSlowly.value = false
  if (saving) slowTimer = setTimeout(() => (savingSlowly.value = true), SLOW_SAVE_MS)
}, { immediate: true })
onBeforeUnmount(() => clearTimeout(slowTimer))

const state = computed(() => {
  const x = f.value
  if (!x || x.loading && x.disk === null) return ''
  if (x.saving && (!ws.editorAutoSave || savingSlowly.value)) return 'Saving…'
  if (files.showsUnsaved(props.tabId)) return 'Modified'
  return ''
})

/* ---------- the language server */

const server = computed(() => {
  const t = tab.value
  if (!t || !editable.value || !language.value || isEnvPath(t.projectPath) || !ws.editorLanguageServers) return null
  return servers.serverFor(lspLanguage(t.file, language.value))
})
/** An installed server fits this file and the project has not answered yet. */
const asksConsent = computed(() =>
  !!server.value && !!tab.value && !svgPreview.value && !failed.value && servers.consentOf(tab.value.projectPath) === null)

function answerConsent(on: boolean) {
  if (tab.value) servers.setConsent(tab.value.projectPath, on)
  nextTick(() => editor?.focus())
}
</script>

<template>
  <section class="fe" :class="{ 'is-active': active, 'is-split': split }" :aria-label="tab ? `Editing ${tab.file}` : 'Editor'">
    <header v-if="tab" class="fe__head">
      <h2 class="fe__name" :title="tab.file">{{ tab.name }}</h2>
      <span v-if="tab.dir" class="fe__dir selectable"><bdi>{{ tab.dir }}</bdi></span>
      <span v-if="state" class="fe__state" :class="{ 'is-dirty': f?.dirty && !f?.saving }">{{ state }}</span>
      <span class="fe__spacer" />
      <FilesLanguageStatus v-if="server" :key="server.id" :server="server" :root="tab.projectPath" />
      <div v-if="kind === 'svg' && editable" class="fe__view" role="radiogroup" aria-label="Show the SVG as">
        <button type="button" role="radio" :aria-checked="svgPreview" :class="{ 'is-on': svgPreview }" @click="setView('preview')">
          <Eye />Preview
        </button>
        <button type="button" role="radio" :aria-checked="!svgPreview" :class="{ 'is-on': !svgPreview }" @click="setView('code')">
          <Code />Code
        </button>
      </div>
      <UiButton v-if="kind !== 'raster' && !ws.editorAutoSave" size="sm" :disabled="!f?.dirty || f?.saving" :title="ws.withKey('Save', 'save-file')" @click="save"><Save />Save</UiButton>
      <UiIconButton size="sm" label="Show in Files" @click="revealInTree"><FolderTree /></UiIconButton>
      <UiIconButton v-if="split" size="sm" label="Close pane" @click.stop="threads.closePane(paneId)"><X /></UiIconButton>
    </header>

    <div v-if="f?.closing" class="fe__bar" role="alertdialog" :aria-label="`Unsaved changes in ${tab?.name}`" @keydown.esc.stop.prevent="files.cancelClose(tabId)">
      <FileWarning class="fe__bar-icon is-waiting" aria-hidden="true" />
      <span v-if="f.saveError" class="fe__bar-text is-error selectable">{{ tab?.name }} could not be saved: {{ f.saveError }}</span>
      <span v-else class="fe__bar-text">Save the changes to <strong>{{ tab?.name }}</strong> before closing?</span>
      <UiButton ref="closeSave" size="sm" variant="primary" :loading="f.saving" @click="saveAndClose">Save</UiButton>
      <UiButton size="sm" variant="danger" @click="discardAndClose">Don't save</UiButton>
      <UiButton size="sm" variant="ghost" @click="files.cancelClose(tabId)">Cancel</UiButton>
    </div>
    <div v-else-if="f?.conflict" class="fe__bar" role="alert">
      <FileWarning class="fe__bar-icon is-waiting" aria-hidden="true" />
      <span class="fe__bar-text">{{ tab?.name }} changed on disk while you were editing it.</span>
      <UiButton size="sm" variant="danger" @click="reload">Discard my edits</UiButton>
      <UiButton size="sm" variant="danger" :loading="f.saving" @click="overwrite">Overwrite the file</UiButton>
    </div>
    <div v-else-if="f?.saveError" class="fe__bar" role="alert">
      <CircleAlert class="fe__bar-icon is-error" aria-hidden="true" />
      <span class="fe__bar-text is-error selectable">{{ f.saveError }}</span>
      <!-- With autosave it stays until the text is saved: nothing else says it is not. -->
      <UiButton v-if="ws.editorAutoSave" size="sm" :loading="f.saving" @click="save">Try again</UiButton>
      <UiButton v-else size="sm" variant="ghost" @click="f.saveError = null">Dismiss</UiButton>
    </div>
    <div v-else-if="asksConsent && server" class="fe__bar is-asking" role="region" :aria-label="`Use ${server.name} in this project`">
      <ShieldQuestion class="fe__bar-icon is-quiet" aria-hidden="true" />
      <span class="fe__bar-text"><strong>{{ server.name }}</strong> adds completion and errors. It can run this project's code.</span>
      <UiButton size="sm" @click="answerConsent(true)">Turn on for this project</UiButton>
      <UiButton size="sm" variant="ghost" @click="answerConsent(false)">Not now</UiButton>
    </div>

    <div class="fe__body">
      <div v-show="editable && !failed && !svgPreview" ref="host" class="fe__editor" :data-motion-full="motion ? '' : null" />
      <FilesImageView
        v-if="picture && tab"
        :src="picture.src"
        :name="tab.name"
        :size="f?.size ?? 0"
        :vector="picture.vector"
        :intrinsic="picture.intrinsic"
      />
      <div v-else-if="failed" class="fe__note" role="alert">
        <p class="fe__note-title">The editor could not start</p>
        <p class="fe__note-sub selectable">{{ failed }}</p>
      </div>
      <template v-else-if="!editable">
        <div v-if="!f || f.loading" class="fe__skeleton" aria-busy="true" aria-label="Opening file">
          <span v-for="w in [62, 44, 71, 38, 55, 66, 30]" :key="w" :style="{ width: `${w}%` }" />
        </div>
        <div v-else-if="f.error" class="fe__note" role="alert">
          <p class="fe__note-title">Could not open {{ tab?.name }}</p>
          <p class="fe__note-sub selectable">{{ f.error }}</p>
          <UiButton size="sm" @click="files.read(tabId)">Try again</UiButton>
        </div>
        <div v-else-if="f.tooLarge" class="fe__note">
          <p class="fe__note-title">{{ tab?.name }} is too large to edit here</p>
          <p class="fe__note-sub">It is {{ formatSize(f.size) }}; the editor opens files up to 5 MB.</p>
        </div>
        <div v-else-if="f.binary" class="fe__note">
          <p class="fe__note-title">{{ tab?.name }} is not a text file</p>
          <p class="fe__note-sub">{{ formatSize(f.size) }} of binary data, or text in an encoding other than UTF-8.</p>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.fe {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-canvas);
}
.fe__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 40px;
  padding: 0 var(--space-3) 0 var(--space-4);
  border-bottom: 1px solid var(--line-soft);
}
.fe.is-split:not(.is-active) .fe__head { opacity: 0.72; }
.fe__name {
  margin: 0;
  flex: none;
  max-width: 40%;
  font-size: var(--text-md);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fe__dir {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  /* Keep the end of a long path visible. */
  direction: rtl;
  text-align: left;
}
.fe__state { flex: none; font-size: var(--text-xs); font-weight: 560; color: var(--fg-subtle); white-space: nowrap; }
.fe__state.is-dirty { color: var(--accent-ink); }
.fe__spacer { flex: 1; }
/* Picture or source, for an SVG: the same switch as the diff layout's. */
.fe__view {
  flex: none;
  display: inline-flex;
  padding: 2px;
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
  box-shadow: inset 0 0 0 1px var(--line-soft);
}
.fe__view button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px 0 6px;
  border-radius: var(--radius-xs);
  font-size: var(--text-xs);
  font-weight: 540;
  color: var(--fg-subtle);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.fe__view button svg { width: 13px; height: 13px; stroke-width: 1.85; }
.fe__view button:hover { color: var(--fg-muted); }
.fe__view button.is-on { background: var(--bg-active); color: var(--fg); }
.fe.is-split .fe__dir { display: none; }

.fe__bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 40px;
  padding: var(--space-1) var(--space-3) var(--space-1) var(--space-4);
  background: var(--bg-panel);
  border-bottom: 1px solid var(--line-soft);
  font-size: var(--text-sm);
}
.fe__bar-icon { flex: none; width: 15px; height: 15px; stroke-width: 1.85; }
.fe__bar-icon.is-waiting { color: var(--ripe-waiting); }
.fe__bar-icon.is-error { color: var(--ripe-error); }
.fe__bar-icon.is-quiet { color: var(--fg-subtle); }
.fe__bar-text { flex: 1; min-width: 0; color: var(--fg-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fe__bar-text strong { color: var(--fg); font-weight: 600; }
.fe__bar-text.is-error { color: var(--ripe-error-fg); white-space: normal; }
/* What it is being allowed is never cut off. */
.fe__bar.is-asking { flex-wrap: wrap; }
.fe__bar.is-asking .fe__bar-text { flex: 1 1 240px; white-space: normal; }

.fe__body { position: relative; flex: 1; min-height: 0; }
.fe__editor { position: absolute; inset: 0; }

.fe__skeleton { display: grid; gap: 9px; padding: 16px 0 0 64px; }
.fe__skeleton span { height: 10px; border-radius: var(--radius-xs); background: var(--bg-hover); }

.fe__note {
  display: grid;
  justify-items: center;
  gap: var(--space-2);
  max-width: 440px;
  margin: 18vh auto 0;
  padding: 0 var(--space-4);
  text-align: center;
}
.fe__note p { margin: 0; }
.fe__note-title { font-size: var(--text-md); font-weight: 600; color: var(--fg); }
.fe__note-sub { font-size: var(--text-sm); color: var(--fg-subtle); overflow-wrap: anywhere; }
.fe__note .btn { margin-top: var(--space-2); }
</style>

<style>
/* Change markers (composables/changeMarkers.ts): Monaco's own DOM, so not scoped. */
.monaco-editor .mango-change { cursor: pointer; }
.monaco-editor .mango-change::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 4px;
  width: 3px;
  background: var(--mark);
  transition: width var(--dur-fast) var(--ease-out);
}
.monaco-editor .mango-change:hover::before { width: 5px; }
.monaco-editor .mango-change--add { --mark: var(--diff-add-fg); }
.monaco-editor .mango-change--mod { --mark: var(--accent-ink); }
/* Removed lines: a wedge on the line they stood before. */
.monaco-editor .mango-change--del::before,
.monaco-editor .mango-change--del:hover::before {
  top: -4px;
  bottom: auto;
  width: 0;
  height: 0;
  border-radius: 0;
  background: none;
  border-style: solid;
  border-width: 4px 0 4px 6px;
  border-color: transparent transparent transparent var(--diff-del-fg);
}
.monaco-editor .mango-change--del.is-end::before { top: auto; bottom: -4px; }
.monaco-editor .mango-change-peek { box-sizing: border-box; padding: 4px 0; z-index: 3; }

/*
 * The caret's glide, on only while `caretGlide` says it was sent somewhere. Long enough to see across
 * one character, quick enough at the start to keep up with key repeat. `!important` outdoes base.css's
 * rule for the OS's reduced motion: the class is never set when Mango's motion is reduced.
 */
.fe__editor.is-caret-gliding .monaco-editor .cursors-layer > .cursor {
  transition-property: top, left;
  transition-duration: var(--dur-fast) !important;
  transition-timing-function: cubic-bezier(0.22, 0.61, 0.36, 1);
}
/* The same rule would freeze the blink when Animations is Full over the OS's setting. */
.fe__editor[data-motion-full] .monaco-editor .cursors-layer.cursor-smooth {
  animation-duration: 0.5s !important;
  animation-iteration-count: 20 !important;
}

/* Monaco's floating widgets, as Mango's floating layers. */
.fe__editor .monaco-editor {
  --vscode-cornerRadius-large: var(--radius-md);
  --vscode-cornerRadius-medium: var(--radius-sm);
  --vscode-cornerRadius-small: var(--radius-xs);
}
.fe__editor .monaco-editor .suggest-widget:not(.message),
.fe__editor .monaco-editor .suggest-widget.message,
.fe__editor .monaco-editor .suggest-details-container .suggest-details,
.fe__editor .monaco-editor .monaco-hover.workbench-hover,
.fe__editor .monaco-editor .monaco-resizable-hover,
.fe__editor .monaco-editor .parameter-hints-widget {
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
}
.fe__editor .monaco-editor .monaco-hover .markdown-hover p,
.fe__editor .monaco-editor .suggest-details .docs,
.fe__editor .monaco-editor .parameter-hints-widget .docs {
  font-family: var(--font-ui);
}
.fe__editor .monaco-editor .monaco-hover .monaco-tokenized-source,
.fe__editor .monaco-editor .monaco-hover code,
.fe__editor .monaco-editor .suggest-details .docs code,
.fe__editor .monaco-editor .suggest-details .docs .monaco-tokenized-source,
.fe__editor .monaco-editor .parameter-hints-widget .docs code,
.fe__editor .monaco-editor .parameter-hints-widget .docs .monaco-tokenized-source {
  font-family: var(--font-mono);
}
</style>
