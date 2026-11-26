<script setup lang="ts">
import type * as Monaco from 'monaco-editor'
import { FileCode, X } from 'lucide-vue-next'
import { useThreads } from '~/stores/threads'
import { cssVar } from '~/utils/cssColor'
import { parseDecompiledTab, shortSymbol } from '~/utils/decompiledTabs'
import { MONACO_THEME, loadMonaco, type MonacoApi } from '~/composables/monaco'
import { widgetsOverBrowsers } from '~/composables/editorFeel'
import { decompiledReveals, decompiledSource } from '~/lsp/decompiled'

/**
 * A library's source as its language server decompiled it, opened by going to a definition in a
 * compiled assembly (UnityEngine, a NuGet package). Read-only: there is no file behind it. It lives
 * while the window does; the tab is not restored after a restart.
 */
const props = defineProps<{ tabId: string; paneId: string; split: boolean; active: boolean }>()

const { t, locale } = useI18n()
const threads = useThreads()

const tab = computed(() => parseDecompiledTab(props.tabId))
const source = computed(() => decompiledSource(props.tabId))
const name = computed(() => (source.value ? shortSymbol(source.value.symbol) : tab.value?.name ?? ''))

const host = ref<HTMLElement | null>(null)
let monaco: MonacoApi | null = null
let editor: Monaco.editor.IStandaloneCodeEditor | null = null
let widgets: ReturnType<typeof widgetsOverBrowsers> | null = null
let fontObserver: MutationObserver | null = null
const failed = ref<string | null>(null)
/** Each source's caret and scroll while another one is shown in this pane. */
const views = new Map<Monaco.editor.ITextModel, Monaco.editor.ICodeEditorViewState | null>()

const fontFamily = () => cssVar('--font-mono') || 'ui-monospace, monospace'
const readOnlyMessage = () => ({ value: t('files.decompiled.readOnlyHint') })
watch(locale, () => editor?.updateOptions({ readOnlyMessage: readOnlyMessage() }))
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

function show() {
  if (!editor) return
  const before = editor.getModel()
  const model = source.value?.model ?? null
  if (before === model) return reveal()
  if (before && !before.isDisposed()) views.set(before, editor.saveViewState())
  editor.setModel(model)
  if (!model) return
  editor.layout()
  const view = views.get(model)
  if (view) editor.restoreViewState(view)
  reveal()
  if (props.active) editor.focus()
}

/** Where a jump asked this source to show. */
function reveal() {
  const at = decompiledReveals[props.tabId]
  const model = editor?.getModel()
  if (!editor || !at || !model || model !== source.value?.model) return
  delete decompiledReveals[props.tabId]
  const pos = model.validatePosition(at)
  editor.setPosition(pos)
  editor.revealPositionInCenterIfOutsideViewport(pos)
  if (props.active) editor.focus()
}

async function setUp() {
  if (editor || !host.value) return
  try {
    monaco = await loadMonaco()
    await document.fonts?.load(`12.5px ${fontFamily()}`).catch(() => {})
    if (!host.value || editor) return
    editor = monaco.editor.create(host.value, {
      model: null,
      readOnly: true,
      readOnlyMessage: readOnlyMessage(),
      theme: MONACO_THEME,
      automaticLayout: true,
      fontFamily: fontFamily(),
      fontSize: 12.5,
      lineHeight: 19,
      fontLigatures: false,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      guides: { indentation: true, bracketPairs: false },
      padding: { top: 10, bottom: 10 },
      smoothScrolling: !reducedMotion(),
      fixedOverflowWidgets: true,
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      stickyScroll: { enabled: true },
      lineDecorationsWidth: 14,
    })
    widgets = widgetsOverBrowsers(editor)
    monaco.editor.remeasureFonts()
    editor.onDidFocusEditorText(() => threads.focusPane(props.paneId))
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

onMounted(() => { if (source.value) void setUp() })
watch(source, async (now) => {
  if (!now) return editor?.setModel(null)
  if (!editor) return setUp()
  await nextTick()
  show()
})
watch(() => decompiledReveals[props.tabId], () => reveal())
watch(() => props.active, (active) => { if (active && editor?.getModel()) editor.focus() })

onBeforeUnmount(() => {
  widgets?.dispose()
  widgets = null
  fontObserver?.disconnect()
  // The model stays: the tab, a peek or the next jump may show it again.
  editor?.setModel(null)
  editor?.dispose()
  editor = null
})
</script>

<template>
  <section class="dcp" :class="{ 'is-active': active, 'is-split': split }" :aria-label="name ? t('files.decompiled.named', { name }) : t('files.decompiled.source')">
    <header class="dcp__head">
      <h2 class="dcp__name" :title="source?.symbol ?? name">{{ name }}</h2>
      <i18n-t v-if="source?.assembly" keypath="files.decompiled.from" tag="span" scope="global" class="dcp__from" :title="t('files.decompiled.fromTitle', { assembly: source.assembly })"><template #assembly><bdi class="dcp__asm">{{ source.assembly }}</bdi></template></i18n-t>
      <span v-else-if="source" class="dcp__from">{{ t('files.decompiled.plain') }}</span>
      <span class="dcp__spacer" />
      <span v-if="source" class="dcp__note">{{ t('files.decompiled.readOnly') }}</span>
      <UiIconButton v-if="split" size="sm" :label="t('files.editor.closePane')" @click.stop="threads.closePane(paneId)"><X /></UiIconButton>
    </header>

    <div class="dcp__body">
      <div v-show="source && !failed" ref="host" class="dcp__editor" />
      <div v-if="!source" class="dcp__empty">
        <FileCode aria-hidden="true" />
        <p>{{ t('files.decompiled.gone') }}</p>
        <UiButton size="sm" @click="threads.closeTab(tabId)">{{ t('files.decompiled.closeTab') }}</UiButton>
      </div>
      <div v-else-if="failed" class="dcp__empty" role="alert">
        <p>{{ t('files.decompiled.failed', { error: failed }) }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.dcp {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-canvas);
}
.dcp__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 40px;
  padding: 0 var(--space-3) 0 var(--space-4);
  border-bottom: 1px solid var(--line-soft);
}
.dcp.is-split:not(.is-active) .dcp__head { opacity: 0.72; }
.dcp__name {
  margin: 0;
  flex: none;
  max-width: 40%;
  font-size: var(--text-md);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dcp__from {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  color: var(--fg-subtle);
}
.dcp__asm { font-family: var(--font-mono); font-size: var(--text-2xs); color: var(--fg-muted); }
.dcp__spacer { flex: 1; }
.dcp__note { flex: none; font-size: var(--text-xs); color: var(--fg-subtle); }
.dcp__body { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dcp__editor { flex: 1; min-height: 0; }
.dcp__empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-6);
  color: var(--fg-subtle);
  font-size: var(--text-sm);
  text-align: center;
}
.dcp__empty > svg { width: 22px; height: 22px; }
.dcp__empty p { margin: 0; max-width: 46ch; }
.dcp.is-split .dcp__from { display: none; }
</style>
