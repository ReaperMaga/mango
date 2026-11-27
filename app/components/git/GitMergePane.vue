<script setup lang="ts">
import type * as Monaco from 'monaco-editor'
import { Bot, Check, ChevronDown, ChevronUp, CircleAlert, FileWarning, RefreshCw, X } from 'lucide-vue-next'
import type { GitConflict, GitOperation } from '~/types/ipc'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { useGit } from '~/stores/git'
import { useFiles } from '~/stores/files'
import { call } from '~/composables/useBackend'
import { MONACO_THEME, languageFor, loadMonaco, type MonacoApi } from '~/composables/monaco'
import { documentFor, documentUri } from '~/composables/editorDocuments'
import { editorModel, type EditorModel } from '~/utils/editorModels'
import { cssVar } from '~/utils/cssColor'
import { failureText } from '~/utils/autoSave'
import { mergeResultTab, parseMergeTab } from '~/utils/mergeTabs'
import { blockAtOrAfter, hasConflictMarkers, locateInSide, parseConflicts, resolutionEdit, splitLines, type ConflictBlock, type ConflictChoice, type ParsedConflicts } from '~/utils/conflicts'
import { chatForConflicts, solveConflicts } from '~/composables/solveConflicts'
import { openMergeEditor } from '~/composables/mergeEditor'

/**
 * The merge editor: a conflicted file as a tab beside the chats. The two sides sit on top, read only
 * (yours and theirs; for a rebase, the branch being rebased onto and the commit being applied), the
 * Result below, which is the working-tree file itself, conflict markers and all, edited and saved like
 * any open file (autosave, change on disk, undo). Each conflict block can be taken from one side or
 * both; F7 and Shift+F7 walk the blocks. Mark resolved stages the file. A binary file, one too large,
 * or one a side deleted is taken whole instead.
 */
const props = defineProps<{ tabId: string; paneId: string; split: boolean; active: boolean }>()

const { t } = useI18n()
const ws = useWorkspace()
const threads = useThreads()
const git = useGit()
const files = useFiles()

const tab = computed(() => parseMergeTab(props.tabId))
const folder = computed(() => tab.value?.projectPath ?? '')
const resultId = computed(() => mergeResultTab(props.tabId))
const status = computed(() => git.status(folder.value))
const op = computed<GitOperation | null>(() => status.value?.operation ?? null)
const lore = computed(() => status.value?.vcs === 'lore')
const row = computed(() => status.value?.files.find(f => f.path === tab.value?.file) ?? null)
/** Still in conflict: the backend has not been told it is resolved. */
const inConflict = computed(() => !!row.value?.conflicted)
const otherConflicts = computed(() => (status.value?.files ?? []).filter(f => f.conflicted && f.path !== tab.value?.file))
const dir = computed(() => {
  const f = tab.value?.file ?? ''
  const i = f.lastIndexOf('/')
  return i > 0 ? f.slice(0, i) : ''
})

/* ---------- what each side has ---------- */

const sides = ref<GitConflict | null>(null)
const sidesError = ref<string | null>(null)
const reason = (e: unknown) => (typeof e === 'string' ? e : e instanceof Error ? e.message : String(e)).trim()
async function loadSides() {
  const at = tab.value
  if (!at) return
  try {
    sides.value = await call('git_conflict', { path: at.projectPath, file: at.file })
    sidesError.value = null
  } catch (e) {
    // Resolved meanwhile: what was read last stays on show.
    if (!sides.value) sidesError.value = reason(e)
  }
}
watch(() => props.tabId, () => { sides.value = null; sidesError.value = null; void loadSides() }, { immediate: true })
// Back in conflict (merged again after an abort): the sides may be others now.
watch(inConflict, (now, was) => { if (now && !was) void loadSides() })

/** The labels of the two sides: a rebase applies a commit onto another branch, so its "ours" is that branch. */
const sideNames = computed(() => {
  const o = op.value
  if (o?.kind === 'rebase') {
    return {
      ours: { title: t('git.merge.side.onto'), name: o.incoming ?? '' },
      theirs: { title: t('git.merge.side.applied'), name: [o.commit, o.subject].filter(Boolean).join(' ') },
    }
  }
  if (o?.kind === 'cherry-pick' || o?.kind === 'revert') {
    return {
      ours: { title: t('git.merge.side.yours'), name: o.branch ?? '' },
      theirs: { title: t(o.kind === 'revert' ? 'git.merge.side.reverted' : 'git.merge.side.picked'), name: [o.commit, o.subject].filter(Boolean).join(' ') },
    }
  }
  return {
    ours: { title: t('git.merge.side.yours'), name: o?.branch ?? '' },
    theirs: { title: t('git.merge.side.theirs'), name: o?.incoming ?? '' },
  }
})
const acceptWords = computed(() => (op.value?.kind === 'rebase'
  ? { ours: t('git.merge.accept.onto'), theirs: t('git.merge.accept.applied'), both: t('git.merge.accept.both'), useOurs: t('git.merge.use.onto'), useTheirs: t('git.merge.use.applied'), oursShort: t('git.merge.short.onto'), theirsShort: t('git.merge.short.applied'), bothShort: t('git.merge.short.both') }
  : { ours: t('git.merge.accept.ours'), theirs: t('git.merge.accept.theirs'), both: t('git.merge.accept.both'), useOurs: t('git.merge.use.ours'), useTheirs: t('git.merge.use.theirs'), oursShort: t('git.merge.short.ours'), theirsShort: t('git.merge.short.theirs'), bothShort: t('git.merge.short.both') }))

/* ---------- the Result: the working-tree file, open without a tab of its own ---------- */

watch(() => [tab.value?.projectPath, tab.value?.inFolder] as const, ([project, file]) => {
  if (project && file) files.openUntabbed(project, file)
}, { immediate: true })
const result = computed(() => files.file(resultId.value))
/** Lines can be merged here: every side is text and the Result is open as text. */
const textual = computed(() => !!sides.value && !sides.value.binary && !sides.value.tooLarge)
const editable = computed(() => textual.value && !!result.value && !result.value.error && !result.value.binary && !result.value.tooLarge && result.value.disk !== null)
/** Why the file is taken whole rather than merged line by line. */
const wholeOnly = computed(() => {
  const s = sides.value
  if (!s) return null
  if (s.binary) return t('git.merge.whole.binary')
  if (s.tooLarge || result.value?.tooLarge) return t('git.merge.whole.tooLarge')
  if (!s.ours.present) return t('git.merge.whole.oursDeleted', { name: sideNames.value.ours.name || t('git.merge.side.yours') })
  if (!s.theirs.present) return t('git.merge.whole.theirsDeleted', { name: sideNames.value.theirs.name || t('git.merge.side.theirs') })
  if (!tab.value?.inFolder) return t('git.merge.whole.outside')
  if (result.value?.error) return result.value.error
  return null
})

/* ---------- conflict blocks, as the Result has them now ---------- */

const parsed = shallowRef<ParsedConflicts | null>(null)
const blocks = computed<ConflictBlock[]>(() => parsed.value?.blocks ?? [])
const current = ref(0)
const markersLeft = computed(() => (editable.value ? !!parsed.value && (blocks.value.length > 0 || hasConflictMarkers(resultModel()?.getValue() ?? '')) : false))

/* ---------- editors ---------- */

const oursHost = ref<HTMLElement | null>(null)
const theirsHost = ref<HTMLElement | null>(null)
const resultHost = ref<HTMLElement | null>(null)
let monaco: MonacoApi | null = null
let oursEd: Monaco.editor.IStandaloneCodeEditor | null = null
let theirsEd: Monaco.editor.IStandaloneCodeEditor | null = null
let resultEd: Monaco.editor.IStandaloneCodeEditor | null = null
let oursModel: Monaco.editor.ITextModel | null = null
let theirsModel: Monaco.editor.ITextModel | null = null
let shownEntry: EditorModel | null = null
const disposers: Monaco.IDisposable[] = []
const failed = ref<string | null>(null)

const resultModel = () => (resultEd?.getModel() ?? null)
const fontFamily = () => cssVar('--font-mono') || 'ui-monospace, monospace'

function baseOptions(readOnly: boolean, label: string): Monaco.editor.IStandaloneEditorConstructionOptions {
  return {
    model: null,
    ariaLabel: label,
    theme: MONACO_THEME,
    automaticLayout: true,
    readOnly,
    domReadOnly: readOnly,
    fontFamily: fontFamily(),
    fontSize: 12.5,
    lineHeight: 19,
    fontLigatures: false,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderLineHighlight: readOnly ? 'none' : 'line',
    bracketPairColorization: { enabled: false },
    ...{ 'bracketPairColorization.enabled': false },
    guides: { indentation: !readOnly, bracketPairs: false },
    padding: { top: 6, bottom: 6 },
    smoothScrolling: !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    fixedOverflowWidgets: true,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    folding: false,
    lineDecorationsWidth: 10,
    lineNumbersMinChars: 3,
    stickyScroll: { enabled: false },
    contextmenu: !readOnly,
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
  }
}

function sideModel(text: string | null, which: 'ours' | 'theirs') {
  if (!monaco || !tab.value) return null
  // A model of its own, never a file's: a URI no other model had, outside the `file` scheme.
  return monaco.editor.createModel(text ?? '', languageFor(monaco, tab.value.file), documentUri(monaco, tab.value.projectPath, `${which}/${tab.value.file}`, 'mango-merge'))
}

/** Put the sides' texts in their editors. */
function showSides() {
  if (!monaco || !oursEd || !theirsEd) return
  const s = sides.value
  oursModel?.dispose()
  theirsModel?.dispose()
  oursModel = s?.ours.text != null ? sideModel(s.ours.text, 'ours') : null
  theirsModel = s?.theirs.text != null ? sideModel(s.theirs.text, 'theirs') : null
  oursEd.setModel(oursModel)
  theirsEd.setModel(theirsModel)
  decorate()
}

/** Put the Result's model (the open file's) in its editor, filled with what is on disk. */
function showResult() {
  if (!monaco || !resultEd) return
  const f = result.value
  const id = resultId.value
  if (!editable.value || !f || !id) {
    if (resultEd.getModel()) resultEd.setModel(null)
    shownEntry = null
    parsed.value = null
    return
  }
  const before = resultEd.getModel()
  if (shownEntry && before && shownEntry.model === before) shownEntry.viewState = resultEd.saveViewState()
  const doc = documentFor(monaco, id, f)
  if (!doc) return
  if (before !== doc.entry.model) {
    resultEd.setModel(doc.entry.model)
    if (doc.entry.viewState) resultEd.restoreViewState(doc.entry.viewState)
    resultEd.layout()
  }
  doc.replaced?.dispose()
  shownEntry = doc.entry
  reparse()
  syncDirty()
  if (before !== doc.entry.model && blocks.value.length) go(0, false)
}

function syncDirty() {
  const id = resultId.value
  const entry = id ? editorModel(id) : null
  if (!entry || !id || entry.loadedVersion !== files.file(id)?.version) return
  files.setDirty(id, entry.model.getAlternativeVersionId() !== entry.savedVersion)
}

let parseTimer: ReturnType<typeof setTimeout> | undefined
function reparse() {
  clearTimeout(parseTimer)
  const model = resultModel()
  parsed.value = model ? parseConflicts(model.getValue()) : null
  if (current.value >= blocks.value.length) current.value = Math.max(0, blocks.value.length - 1)
  decorate()
  zones()
  // The markers are no errors to show while the conflicts are there: the diagnostics come back once they are gone.
  resultEd?.updateOptions({ renderValidationDecorations: blocks.value.length ? 'off' : 'on' })
}

async function setUp() {
  if (resultEd || !resultHost.value || !oursHost.value || !theirsHost.value) return
  try {
    monaco = await loadMonaco()
    await document.fonts?.load(`12.5px ${fontFamily()}`).catch(() => {})
    if (resultEd || !resultHost.value || !oursHost.value || !theirsHost.value) return
    const sideLabel = (x: { title: string; name: string }) => t('git.merge.sideLabel', { side: [x.title, x.name].filter(Boolean).join(' ') })
    oursEd = monaco.editor.create(oursHost.value, baseOptions(true, sideLabel(sideNames.value.ours)))
    theirsEd = monaco.editor.create(theirsHost.value, baseOptions(true, sideLabel(sideNames.value.theirs)))
    resultEd = monaco.editor.create(resultHost.value, baseOptions(false, t('git.merge.resultLabel', { file: tab.value?.file ?? '' })))
    disposers.push(resultEd.onDidChangeModelContent(() => {
      syncDirty()
      clearTimeout(parseTimer)
      parseTimer = setTimeout(reparse, 60)
    }))
    disposers.push(resultEd.onDidChangeCursorPosition((e) => {
      const at = blockAtOrAfter(blocks.value, e.position.lineNumber)
      // Inside a block (or on its markers): that one is current.
      if (at >= 0 && blocks.value[at]!.start + 1 <= e.position.lineNumber && current.value !== at) {
        current.value = at
        decorate()
      }
    }))
    for (const ed of [oursEd, theirsEd, resultEd]) disposers.push(ed.onDidFocusEditorText(() => threads.focusPane(props.paneId)))
    const K = monaco.KeyCode
    const M = monaco.KeyMod
    for (const ed of [oursEd, theirsEd, resultEd]) {
      ed.addCommand(K.F7, () => step(1))
      ed.addCommand(M.Shift | K.F7, () => step(-1))
    }
    // Alt+1, 2, 3: the current conflict from yours, theirs, or both (the order of the buttons).
    resultEd.addCommand(M.Alt | K.Digit1, () => accept('ours'))
    resultEd.addCommand(M.Alt | K.Digit2, () => accept('theirs'))
    resultEd.addCommand(M.Alt | K.Digit3, () => accept('both'))
    resultEd.addCommand(M.CtrlCmd | K.KeyS, () => void save())
    showSides()
    showResult()
  } catch (e) {
    failed.value = e instanceof Error ? e.message : String(e)
  }
}
onMounted(() => void setUp())

watch(sides, () => { showSides(); showResult() })
watch(() => [props.tabId, editable.value, result.value?.version] as const, async () => {
  if (!resultEd) return setUp()
  await nextTick()
  showResult()
})
watch(() => props.active, (on) => { if (on && resultEd?.getModel()) resultEd.focus() })

onBeforeUnmount(() => {
  clearTimeout(parseTimer)
  if (resultEd && shownEntry && !shownEntry.model.isDisposed()) shownEntry.viewState = resultEd.saveViewState()
  clearZones()
  for (const d of disposers) d.dispose()
  // The Result's model stays with the open file; only these views of it go.
  resultEd?.setModel(null)
  for (const ed of [oursEd, theirsEd, resultEd]) ed?.dispose()
  oursModel?.dispose()
  theirsModel?.dispose()
  oursEd = theirsEd = resultEd = null
})

/* ---------- where the blocks are: decorations in all three, buttons above each in the Result ---------- */

let resultDecos: Monaco.editor.IEditorDecorationsCollection | null = null
let oursDecos: Monaco.editor.IEditorDecorationsCollection | null = null
let theirsDecos: Monaco.editor.IEditorDecorationsCollection | null = null

/** A block's place in one side's own file (1-based line and line count), when it can be found. */
function placeIn(model: Monaco.editor.ITextModel | null, b: ConflictBlock, which: 'ours' | 'theirs') {
  if (!model || !parsed.value) return null
  const before = b.start > 0 ? parsed.value.lines[b.start - 1]! : null
  return locateInSide(splitLines(model.getValue()), b[which], before, b.start)
}

function decorate() {
  if (!monaco) return
  const range = (from: number, to: number) => new monaco!.Range(from, 1, to, 1)
  const whole = (from: number, to: number, cls: string) => ({ range: range(from, to), options: { isWholeLine: true, className: cls } })
  const r: Monaco.editor.IModelDeltaDecoration[] = []
  const o: Monaco.editor.IModelDeltaDecoration[] = []
  const th: Monaco.editor.IModelDeltaDecoration[] = []
  blocks.value.forEach((b, i) => {
    const cur = i === current.value ? ' is-current' : ''
    const line = (n: number) => n + 1
    r.push(whole(line(b.start), line(b.start), `mp-marker${cur}`))
    if (b.ours.length) r.push(whole(line(b.start + 1), line(b.start + b.ours.length), `mp-ours${cur}`))
    if (b.baseAt !== null) {
      r.push(whole(line(b.baseAt), line(b.baseAt), `mp-marker${cur}`))
      if (b.base?.length) r.push(whole(line(b.baseAt + 1), line(b.splitAt - 1), `mp-base${cur}`))
    }
    r.push(whole(line(b.splitAt), line(b.splitAt), `mp-marker${cur}`))
    if (b.theirs.length) r.push(whole(line(b.splitAt + 1), line(b.end - 1), `mp-theirs${cur}`))
    r.push(whole(line(b.end), line(b.end), `mp-marker${cur}`))
    for (const [model, list, which] of [[oursModel, o, 'ours'], [theirsModel, th, 'theirs']] as const) {
      const at = placeIn(model, b, which)
      if (!at) continue
      if (at.count) list.push(whole(at.line, at.line + at.count - 1, `mp-${which}${cur}`))
      // Nothing from this side here: a hairline where the block would be.
      else list.push({ range: range(Math.max(1, at.line - 1), Math.max(1, at.line - 1)), options: { isWholeLine: true, className: `mp-gap${cur}` } })
    }
  })
  const model = resultModel()
  if (resultEd && model) (resultDecos ??= resultEd.createDecorationsCollection()).set(r)
  if (oursEd && oursModel) (oursDecos ??= oursEd.createDecorationsCollection()).set(o)
  else oursDecos?.clear()
  if (theirsEd && theirsModel) (theirsDecos ??= theirsEd.createDecorationsCollection()).set(th)
  else theirsDecos?.clear()
}

/** Each block's own buttons, in a line above its first marker. */
let zoneIds: string[] = []
function clearZones() {
  if (!resultEd || !zoneIds.length) return
  resultEd.changeViewZones((acc) => { for (const id of zoneIds) acc.removeZone(id) })
  zoneIds = []
}
function zones() {
  if (!resultEd) return
  const words = acceptWords.value
  resultEd.changeViewZones((acc) => {
    for (const id of zoneIds) acc.removeZone(id)
    zoneIds = blocks.value.map((b, i) => {
      const node = document.createElement('div')
      node.className = 'mp-zone'
      const add = (label: string, choice: ConflictChoice) => {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'mp-zone__btn'
        btn.textContent = label
        btn.setAttribute('aria-label', t('git.merge.zoneLabel', { action: label, n: i + 1, m: blocks.value.length }))
        btn.addEventListener('mousedown', e => e.preventDefault())
        btn.addEventListener('click', (e) => { e.preventDefault(); accept(choice, i) })
        node.appendChild(btn)
      }
      add(words.ours, 'ours')
      add(words.theirs, 'theirs')
      add(words.both, 'both')
      return acc.addZone({ afterLineNumber: b.start, heightInPx: 26, domNode: node })
    })
  })
}
watch(acceptWords, () => zones())

/* ---------- moving and taking ---------- */

/** Make block `i` current and bring it into view in all three editors. */
function go(i: number, focus = true) {
  const b = blocks.value[i]
  if (!b || !resultEd) return
  current.value = i
  decorate()
  resultEd.revealLinesInCenterIfOutsideViewport(b.start + 1, b.end + 1)
  resultEd.setPosition({ lineNumber: b.start + 2, column: 1 })
  for (const [ed, model, which] of [[oursEd, oursModel, 'ours'], [theirsEd, theirsModel, 'theirs']] as const) {
    const at = placeIn(model, b, which)
    if (ed && at) ed.revealLinesInCenterIfOutsideViewport(at.line, Math.max(at.line, at.line + at.count - 1))
  }
  if (focus) resultEd.focus()
}
function step(by: 1 | -1) {
  const n = blocks.value.length
  if (!n) return
  // From the cursor: the next block after it, or the one before it.
  const line = resultEd?.getPosition()?.lineNumber ?? 1
  const at = blockAtOrAfter(blocks.value, line)
  const inside = at >= 0 && blocks.value[at]!.start + 1 <= line
  let next: number
  if (by > 0) next = at < 0 ? 0 : inside ? (at + 1) % n : at
  else next = at < 0 ? n - 1 : (at - 1 + n) % n
  go(next)
}

function accept(choice: ConflictChoice, index = current.value) {
  const model = resultModel()
  const p = parsed.value
  const b = p?.blocks[index]
  if (!resultEd || !model || !p || !b || !monaco) return
  const e = resolutionEdit(p, b, choice)
  resultEd.pushUndoStop()
  resultEd.executeEdits('merge-editor', [{ range: new monaco.Range(e.startLine, e.startColumn, e.endLine, e.endColumn), text: e.text, forceMoveMarkers: true }])
  resultEd.pushUndoStop()
  reparse()
  // On to the next one (the same index now that this one is gone).
  if (blocks.value.length) go(Math.min(index, blocks.value.length - 1))
  else resultEd.focus()
}

/** F7 / Shift+F7 anywhere in the pane, not only in the Result. */
function onKey(e: KeyboardEvent) {
  if (e.key !== 'F7' || e.ctrlKey || e.metaKey || e.altKey) return
  if ((e.target as HTMLElement | null)?.closest('.monaco-editor')) return
  e.preventDefault()
  step(e.shiftKey ? -1 : 1)
}

/* ---------- the whole file ---------- */

const busy = computed(() => !!git.busy)
async function save() {
  const id = resultId.value
  if (id && files.file(id)?.dirty) await files.save(id)
}
/** A side taken whole in this tab: until then a whole-file conflict is not ready to mark resolved. */
const taken = ref(false)
async function take(side: 'ours' | 'theirs') {
  if (tab.value && await git.takeSide(folder.value, tab.value.file, side)) taken.value = true
}
/** Marking resolved would keep what the conflict left: markers, or no side picked for a whole file. */
const unready = computed(() => markersLeft.value || (!!wholeOnly.value && !taken.value))

/** Marking resolved with markers left asks first (git takes it as it is; Lore refuses). */
const insisting = ref(false)
const resolveError = ref<string | null>(null)
async function markResolved(anyway = false) {
  const at = tab.value
  if (!at) return
  if (unready.value && !anyway) {
    insisting.value = true
    return
  }
  insisting.value = false
  resolveError.value = null
  const ok = await git.stage(folder.value, [at.file])
  if (!ok) resolveError.value = git.lastError
  else {
    // The button pressed is gone: the keyboard goes on to the next file, else back to the Result.
    await nextTick()
    if (nextBtn.value) nextBtn.value.$el?.focus()
    else resultEd?.focus()
  }
}
const nextBtn = ref<{ $el: HTMLElement } | null>(null)
const keepBtn = ref<{ $el: HTMLElement } | null>(null)
watch(insisting, async (on) => {
  if (!on) return
  await nextTick()
  keepBtn.value?.$el?.focus()
})
watch(() => props.tabId, () => { insisting.value = false; resolveError.value = null; taken.value = false })

function nextFile() {
  const next = otherConflicts.value[0]
  if (next) openMergeEditor(folder.value, next.path)
}

/* ---------- the agent ---------- */

const target = computed(() => chatForConflicts(folder.value))
const solveTitle = computed(() => (target.value
  ? t('git.merge.solveFileTitle', { chat: target.value.title })
  : t('git.merge.solveFileNewTitle')))
function solve() {
  if (tab.value) void solveConflicts(folder.value, [tab.value.file], props.tabId)
}

/** The header's word for where the file stands. */
const stateWord = computed(() => {
  if (!inConflict.value) return t('git.merge.state.resolved')
  if (!editable.value) return t('git.state.conflict')
  const n = blocks.value.length
  return n ? t('git.merge.state.left', n) : t('git.merge.state.noMarkers')
})
const counter = computed(() => (blocks.value.length ? t('git.merge.counter', { n: current.value + 1, m: blocks.value.length }) : t('git.merge.noBlocks')))
const saveState = computed(() => {
  const f = result.value
  if (!f) return ''
  if (f.saving && !ws.editorAutoSave) return t('files.editor.saving')
  if (resultId.value && files.showsUnsaved(resultId.value)) return t('files.editor.modified')
  return ''
})
async function reloadFromDisk() {
  if (resultId.value) await files.revert(resultId.value)
}
async function overwrite() {
  if (resultId.value) await files.save(resultId.value, true)
}
</script>

<template>
  <section
    class="mp"
    :class="{ 'is-active': active, 'is-split': split }"
    :aria-label="tab ? t('git.merge.editorFor', { file: tab.file }) : t('git.merge.editor')"
    @keydown="onKey"
  >
    <header v-if="tab" class="mp__head">
      <h2 class="mp__name" :title="tab.file">{{ tab.name }}</h2>
      <span v-if="dir" class="mp__dir"><bdi>{{ dir }}</bdi></span>
      <span class="mp__state" :class="{ 'is-open': inConflict, 'is-done': !inConflict }">{{ stateWord }}</span>
      <span v-if="saveState" class="mp__save">{{ saveState }}</span>
      <span class="mp__spacer" />
      <UiButton v-if="inConflict && textual" size="sm" class="mp__solve" :disabled="busy" :title="solveTitle" :aria-label="t('git.merge.solveFile')" @click="solve"><Bot /><span class="mp__wide">{{ t('git.merge.solveFile') }}</span></UiButton>
      <UiButton v-if="inConflict" size="sm" :variant="unready ? 'secondary' : 'primary'" :loading="git.isBusy(folder, 'stage')" :disabled="busy" :title="t(lore ? 'git.merge.markResolvedLoreTitle' : 'git.merge.markResolvedTitle')" @click="markResolved()">
        <Check />{{ t('git.merge.markResolved') }}
      </UiButton>
      <UiButton v-else-if="otherConflicts.length" ref="nextBtn" size="sm" variant="primary" @click="nextFile">{{ t('git.merge.nextFile', otherConflicts.length) }}</UiButton>
      <UiIconButton size="sm" :label="t('git.merge.reload')" @click="loadSides(); git.refresh(folder)"><RefreshCw /></UiIconButton>
      <UiIconButton v-if="split" size="sm" :label="t('git.closePane')" @click.stop="threads.closePane(paneId)"><X /></UiIconButton>
    </header>

    <div v-if="insisting" class="mp__bar" role="alertdialog" :aria-label="t('git.merge.markersLeftLabel')" @keydown.esc.stop.prevent="insisting = false">
      <FileWarning class="mp__bar-icon is-waiting" aria-hidden="true" />
      <span class="mp__bar-text">{{ wholeOnly ? t('git.merge.noSideYet') : lore ? t('git.merge.markersLeftLore', Math.max(1, blocks.length)) : t('git.merge.markersLeft', Math.max(1, blocks.length)) }}</span>
      <UiButton ref="keepBtn" size="sm" variant="ghost" @click="insisting = false">{{ t('git.merge.keepResolving') }}</UiButton>
      <UiButton v-if="!lore || wholeOnly" size="sm" variant="danger" @click="markResolved(true)">{{ t('git.merge.markAnyway') }}</UiButton>
    </div>
    <div v-else-if="resolveError" class="mp__bar" role="alert">
      <CircleAlert class="mp__bar-icon is-error" aria-hidden="true" />
      <span class="mp__bar-text is-error selectable">{{ resolveError }}</span>
      <UiIconButton size="sm" :label="t('git.panel.dismiss')" @click="resolveError = null"><X /></UiIconButton>
    </div>
    <div v-else-if="result?.conflict" class="mp__bar" role="alert">
      <FileWarning class="mp__bar-icon is-waiting" aria-hidden="true" />
      <span class="mp__bar-text">{{ t('files.editor.changedOnDisk', { name: tab?.name }) }}</span>
      <UiButton size="sm" variant="danger" @click="reloadFromDisk">{{ t('files.editor.discardEdits') }}</UiButton>
      <UiButton size="sm" variant="danger" :loading="result.saving" @click="overwrite">{{ t('files.editor.overwrite') }}</UiButton>
    </div>
    <div v-else-if="result?.saveError" class="mp__bar" role="alert">
      <CircleAlert class="mp__bar-icon is-error" aria-hidden="true" />
      <span class="mp__bar-text is-error selectable">{{ failureText(result.saveError) }}</span>
      <UiButton size="sm" :loading="result.saving" @click="save">{{ t('common.actions.retry') }}</UiButton>
    </div>

    <p v-if="sidesError || failed" class="mp__error selectable" role="alert">{{ sidesError ?? failed }}</p>

    <!-- Taken whole: a binary file, one too large, one a side deleted, one outside the folder. -->
    <div v-if="wholeOnly && sides" class="mp__whole">
      <FileWarning class="mp__whole-icon" aria-hidden="true" />
      <p class="mp__whole-text">{{ wholeOnly }}</p>
      <p class="mp__whole-hint">{{ inConflict ? (lore ? t('git.merge.whole.hintLore') : t('git.merge.whole.hint')) : t('git.merge.whole.done') }}</p>
      <div v-if="inConflict" class="mp__whole-btns">
        <UiButton size="sm" :loading="git.isBusy(folder, 'take')" :disabled="busy" @click="take('ours')">
          {{ sides.ours.present ? acceptWords.useOurs : t('git.merge.use.deleteLike', { name: sideNames.ours.name || sideNames.ours.title }) }}
        </UiButton>
        <UiButton size="sm" :disabled="busy" @click="take('theirs')">
          {{ sides.theirs.present ? acceptWords.useTheirs : t('git.merge.use.deleteLike', { name: sideNames.theirs.name || sideNames.theirs.title }) }}
        </UiButton>
      </div>
    </div>

    <div v-show="!wholeOnly" class="mp__body">
      <div class="mp__sides">
        <div class="mp__side">
          <div class="mp__side-head">
            <span class="mp__side-title">{{ sideNames.ours.title }}</span>
            <span v-if="sideNames.ours.name" class="mp__side-name" :title="sideNames.ours.name">{{ sideNames.ours.name }}</span>
            <span class="mp__spacer" />
            <UiButton v-if="inConflict" size="sm" variant="ghost" class="mp__use" :disabled="busy" :title="t('git.merge.useTitle')" @click="take('ours')">{{ acceptWords.useOurs }}</UiButton>
          </div>
          <div ref="oursHost" class="mp__ed" />
        </div>
        <div class="mp__side">
          <div class="mp__side-head">
            <span class="mp__side-title">{{ sideNames.theirs.title }}</span>
            <span v-if="sideNames.theirs.name" class="mp__side-name" :title="sideNames.theirs.name">{{ sideNames.theirs.name }}</span>
            <span class="mp__spacer" />
            <UiButton v-if="inConflict" size="sm" variant="ghost" class="mp__use" :disabled="busy" :title="t('git.merge.useTitle')" @click="take('theirs')">{{ acceptWords.useTheirs }}</UiButton>
          </div>
          <div ref="theirsHost" class="mp__ed" />
        </div>
      </div>

      <div class="mp__bar mp__nav" role="toolbar" :aria-label="t('git.merge.blocks')">
        <span class="mp__side-title mp__wide">{{ t('git.merge.result') }}</span>
        <span class="mp__counter tabular" aria-live="polite"><span class="mp__wide">{{ counter }}</span><span class="mp__narrow" aria-hidden="true">{{ blocks.length ? `${current + 1}/${blocks.length}` : '0' }}</span></span>
        <UiIconButton size="sm" :label="`${t('git.merge.prev')} (Shift+F7)`" :disabled="!blocks.length" @click="step(-1)"><ChevronUp /></UiIconButton>
        <UiIconButton size="sm" :label="`${t('git.merge.next')} (F7)`" :disabled="!blocks.length" @click="step(1)"><ChevronDown /></UiIconButton>
        <span class="mp__spacer" />
        <template v-if="blocks.length">
          <UiButton size="sm" variant="ghost" :aria-label="acceptWords.ours" :title="`${acceptWords.ours} (Alt+1)`" @click="accept('ours')"><span class="mp__wide">{{ acceptWords.ours }}</span><span class="mp__narrow">{{ acceptWords.oursShort }}</span></UiButton>
          <UiButton size="sm" variant="ghost" :aria-label="acceptWords.theirs" :title="`${acceptWords.theirs} (Alt+2)`" @click="accept('theirs')"><span class="mp__wide">{{ acceptWords.theirs }}</span><span class="mp__narrow">{{ acceptWords.theirsShort }}</span></UiButton>
          <UiButton size="sm" variant="ghost" :aria-label="acceptWords.both" :title="`${acceptWords.both} (Alt+3)`" @click="accept('both')"><span class="mp__wide">{{ acceptWords.both }}</span><span class="mp__narrow">{{ acceptWords.bothShort }}</span></UiButton>
        </template>
      </div>
      <div ref="resultHost" class="mp__ed mp__result" />
    </div>
  </section>
</template>

<style scoped>
.mp {
  container-type: inline-size;
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-canvas);
}
.mp__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 40px;
  padding: 0 var(--space-3) 0 var(--space-4);
  border-bottom: 1px solid var(--line-soft);
}
.mp.is-split:not(.is-active) .mp__head { opacity: 0.72; }
.mp__name {
  margin: 0;
  flex: none;
  max-width: 30%;
  font-size: var(--text-md);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mp__dir {
  min-width: 0;
  flex: 0 1 auto;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}
.mp__state { flex: none; font-size: var(--text-xs); font-weight: 560; white-space: nowrap; }
.mp__state.is-open { color: var(--ripe-waiting-fg); }
.mp__state.is-done { color: var(--ripe-done-fg); }
.mp__save { flex: none; font-size: var(--text-xs); color: var(--fg-subtle); white-space: nowrap; }
.mp__spacer { flex: 1; }
.mp.is-split .mp__dir { display: none; }

.mp__bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 36px;
  padding: 4px var(--space-3) 4px var(--space-4);
  border-bottom: 1px solid var(--line-soft);
  background: var(--bg-panel);
}
.mp__bar-icon { flex: none; width: 15px; height: 15px; }
.mp__bar-icon.is-waiting { color: var(--ripe-waiting); }
.mp__bar-icon.is-error { color: var(--ripe-error); }
.mp__bar-text { flex: 1; min-width: 0; font-size: var(--text-sm); color: var(--fg-muted); }
.mp__bar-text.is-error { color: var(--ripe-error-fg); }
.mp__error { margin: var(--space-3) var(--space-4); font-size: var(--text-sm); color: var(--ripe-error-fg); }

.mp__body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.mp__sides {
  flex: 0 0 40%;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  border-bottom: 1px solid var(--line-soft);
}
.mp__side { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.mp__side + .mp__side { border-left: 1px solid var(--line-soft); }
.mp__side-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 30px;
  padding: 0 var(--space-2) 0 var(--space-4);
  min-width: 0;
}
.mp__side-title { flex: none; font-size: var(--text-xs); font-weight: 600; color: var(--fg-muted); white-space: nowrap; }
.mp__side-name {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--fg-subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mp__use { flex: none; }
.mp__ed { flex: 1; min-height: 0; min-width: 0; background: var(--bg-inset); }
.mp__nav { background: var(--bg-canvas); padding-left: var(--space-4); }
.mp__counter { flex: none; font-size: var(--text-xs); color: var(--fg-subtle); white-space: nowrap; }
.mp__result { flex: 1; }

.mp__narrow { display: none; }
/* A narrow pane (a split, or the tool window open at the smallest window): shorter words, the same actions. */
@container (max-width: 620px) {
  .mp__wide { display: none; }
  .mp__narrow { display: inline; }
  .mp__dir, .mp__save { display: none; }
  .mp__head { padding-left: var(--space-3); }
  .mp__use { padding: 0 6px; }
}

.mp__whole {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-6);
  text-align: center;
}
.mp__whole-icon { width: 20px; height: 20px; color: var(--fg-subtle); }
.mp__whole-text { margin: 0; max-width: 52ch; font-size: var(--text-md); color: var(--fg); }
.mp__whole-hint { margin: 0; max-width: 52ch; font-size: var(--text-sm); color: var(--fg-subtle); }
.mp__whole-btns { display: flex; flex-wrap: wrap; justify-content: center; gap: var(--space-2); margin-top: var(--space-2); }
</style>

<style>
/* Monaco's decorations and view zones live outside the component's scope. */
.mp .mp-ours { background: var(--merge-ours-bg); }
.mp .mp-theirs { background: var(--merge-theirs-bg); }
.mp .mp-base { background: var(--bg-hover); }
.mp .mp-marker { background: var(--bg-active); }
.mp .mp-gap { border-bottom: 1px dashed var(--line-strong); }
.mp .mp-ours.is-current { background: var(--merge-ours-current); }
.mp .mp-theirs.is-current { background: var(--merge-theirs-current); }
.mp .mp-gap.is-current { border-bottom-color: var(--fg-subtle); }
.mp .mp-zone {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 26px;
  padding-left: 2px;
  font-family: var(--font-ui);
}
.mp .mp-zone__btn {
  height: 22px;
  padding: 0 var(--space-2);
  border: 0;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--fg-muted);
  font: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.mp .mp-zone__btn:hover { background: var(--bg-hover); color: var(--fg); }
.mp .mp-zone__btn:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -1px; }
</style>
