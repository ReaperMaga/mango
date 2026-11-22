<script setup lang="ts">
import type * as Monaco from 'monaco-editor'
import { CircleAlert, Code, Eye, FileWarning, FolderTree, Save, X } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { closeFileTab, useFiles } from '~/stores/files'
import { parseFileTab } from '~/utils/fileTabs'
import { editorModel, setEditorModel, type EditorModel } from '~/utils/editorModels'
import { cssVar } from '~/utils/cssColor'
import { MONACO_THEME, languageFor, loadMonaco, type MonacoApi } from '~/composables/monaco'
import { imageKind, svgSize, svgUrl } from '~/utils/imageFiles'
import { changeMarkers, type ChangeMarkers } from '~/composables/changeMarkers'
import { useGit } from '~/stores/git'
import { call } from '~/composables/useBackend'

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
const failed = ref<string | null>(null)

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

function fontFamily() {
  return cssVar('--font-mono') || 'ui-monospace, monospace'
}

/** The model for this tab, created (or refilled after a reload from disk) as needed. */
function modelFor(tabId: string): Monaco.editor.ITextModel | null {
  const f = files.file(tabId)
  if (!monaco || !f || f.disk === null) return null
  let entry = editorModel(tabId)
  if (!entry || entry.model.isDisposed()) {
    const model = monaco.editor.createModel(f.disk, languageFor(monaco, f.file))
    entry = { model, savedVersion: model.getAlternativeVersionId(), loadedVersion: f.version, viewState: null }
    setEditorModel(tabId, entry)
  } else if (entry.loadedVersion !== f.version) {
    // Read again from disk (opened again, reverted, or changed by an agent while clean).
    entry.model.setValue(f.disk)
    entry.savedVersion = entry.model.getAlternativeVersionId()
    entry.loadedVersion = f.version
  }
  // A renamed file may be in another language now.
  const language = languageFor(monaco, f.file)
  if (entry.model.getLanguageId() !== language) monaco.editor.setModelLanguage(entry.model, language)
  return entry.model
}

function syncDirty() {
  const entry = shownTab ? editorModel(shownTab) : null
  if (!entry || !shownTab) return
  files.setDirty(shownTab, entry.model.getAlternativeVersionId() !== entry.savedVersion)
}

/** Put the current tab's model in the editor, keeping the previous one's scroll and cursor. */
function show() {
  if (!editor || !monaco) return
  if (shownTab && shownTab !== props.tabId) {
    if (shownEntry && !shownEntry.model.isDisposed()) shownEntry.viewState = editor.saveViewState()
  }
  const model = editable.value ? modelFor(props.tabId) : null
  if (editor.getModel() !== model) editor.setModel(model)
  shownTab = model ? props.tabId : null
  shownEntry = model ? editorModel(props.tabId) : null
  if (model) {
    const entry = editorModel(props.tabId)
    if (entry?.viewState) editor.restoreViewState(entry.viewState)
    syncDirty()
    readSvg()
    void loadBase()
    revealAsked()
    // A hidden editor must not take the keyboard: typing would change a file nobody is looking at.
    if (props.active && !svgPreview.value) editor.focus()
  }
}

/** A line someone asked to see (`files.revealLine`, a plugin's `openFile`): scroll there and put the cursor on it. */
function revealAsked() {
  const line = files.lines[props.tabId]
  const model = editor?.getModel()
  if (!editor || !line || !model || shownTab !== props.tabId) return
  delete files.lines[props.tabId]
  const at = Math.min(line, model.getLineCount())
  editor.setPosition({ lineNumber: at, column: 1 })
  editor.revealLineInCenter(at)
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
      cursorSmoothCaretAnimation: reducedMotion() ? 'off' : 'on',
      cursorBlinking: 'smooth',
      fixedOverflowWidgets: true,
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      stickyScroll: { enabled: true },
      lineDecorationsWidth: 14,
    })
    markers = changeMarkers(monaco, editor)
    monaco.editor.remeasureFonts()
    contentSub = editor.onDidChangeModelContent(() => {
      syncDirty()
      if (kind.value === 'svg') { clearTimeout(svgTimer); svgTimer = setTimeout(readSvg, 120) }
    })
    editor.onDidFocusEditorText(() => threads.focusPane(props.paneId))
    // A new code font (Settings > Appearance) reaches the open editor too.
    fontObserver = new MutationObserver(async () => {
      await document.fonts?.load(`12.5px ${fontFamily()}`).catch(() => {})
      editor?.updateOptions({ fontFamily: fontFamily() })
    })
    fontObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-font-mono'] })
    show()
  } catch (e) {
    failed.value = e instanceof Error ? e.message : String(e)
  }
}

onMounted(() => {
  if (editable.value) void setUp()
})

// Opened before the read finished, switched to another file tab in this pane, or reloaded from disk.
watch(() => [props.tabId, editable.value, file.value?.version] as const, () => {
  if (!editable.value) {
    if (editor) { editor.setModel(null); shownTab = null; shownEntry = null }
    return
  }
  if (!editor) void setUp()
  else show()
})

watch(() => props.active, (active) => { if (active && editor && shownTab && !svgPreview.value) editor.focus() })

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
  if (await files.save(props.tabId)) closeFileTab(props.tabId)
}
function discardAndClose() {
  closeFileTab(props.tabId)
}
async function overwrite() {
  await files.save(props.tabId, true)
}
function reload() {
  void files.revert(props.tabId)
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

const state = computed(() => {
  const x = f.value
  if (!x || x.loading && x.disk === null) return ''
  if (x.saving) return 'Saving…'
  if (x.dirty) return 'Modified'
  return ''
})
</script>

<template>
  <section class="fe" :class="{ 'is-active': active, 'is-split': split }" :aria-label="tab ? `Editing ${tab.file}` : 'Editor'">
    <header v-if="tab" class="fe__head">
      <h2 class="fe__name" :title="tab.file">{{ tab.name }}</h2>
      <span v-if="tab.dir" class="fe__dir selectable"><bdi>{{ tab.dir }}</bdi></span>
      <span v-if="state" class="fe__state" :class="{ 'is-dirty': f?.dirty && !f?.saving }">{{ state }}</span>
      <span class="fe__spacer" />
      <div v-if="kind === 'svg' && editable" class="fe__view" role="radiogroup" aria-label="Show the SVG as">
        <button type="button" role="radio" :aria-checked="svgPreview" :class="{ 'is-on': svgPreview }" @click="setView('preview')">
          <Eye />Preview
        </button>
        <button type="button" role="radio" :aria-checked="!svgPreview" :class="{ 'is-on': !svgPreview }" @click="setView('code')">
          <Code />Code
        </button>
      </div>
      <UiButton v-if="kind !== 'raster'" size="sm" :disabled="!f?.dirty || f?.saving" :title="ws.withKey('Save', 'save-file')" @click="save"><Save />Save</UiButton>
      <UiIconButton size="sm" label="Show in Files" @click="revealInTree"><FolderTree /></UiIconButton>
      <UiIconButton v-if="split" size="sm" label="Close pane" @click.stop="threads.closePane(paneId)"><X /></UiIconButton>
    </header>

    <div v-if="f?.closing" class="fe__bar" role="alertdialog" :aria-label="`Unsaved changes in ${tab?.name}`" @keydown.esc.stop.prevent="files.cancelClose(tabId)">
      <FileWarning class="fe__bar-icon is-waiting" aria-hidden="true" />
      <span class="fe__bar-text">Save the changes to <strong>{{ tab?.name }}</strong> before closing?</span>
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
      <UiButton size="sm" variant="ghost" @click="f.saveError = null">Dismiss</UiButton>
    </div>

    <div class="fe__body">
      <div v-show="editable && !failed && !svgPreview" ref="host" class="fe__editor" />
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
.fe__bar-text { flex: 1; min-width: 0; color: var(--fg-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fe__bar-text strong { color: var(--fg); font-weight: 600; }
.fe__bar-text.is-error { color: var(--ripe-error-fg); white-space: normal; }

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
</style>
