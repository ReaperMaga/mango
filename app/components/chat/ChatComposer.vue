<script setup lang="ts">
import { ArrowUp, ChevronDown, FileText, Mic, Paperclip, Square, ShieldCheck, X, Zap, Map as MapIcon, FilePen } from 'lucide-vue-next'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { useWorkspace } from '~/stores/workspace'
import { useVoice } from '~/stores/voice'
import { useModels } from '~/stores/models'
import { useDictation } from '~/composables/useDictation'
import { isMod, modLabel } from '~/composables/useShortcuts'
import { AGENTS, effortLabel, type AgentId, type Attachment, type Thread } from '~/types/chat'
import { call, isTauri, pickFiles } from '~/composables/useBackend'
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, blobToBase64, formatSize, makeThumb, pastedName } from '~/utils/attachments'
import { baseName } from '~/utils/paths'
import { openImage } from '~/utils/imageViewer'
import type { MenuItem } from '~/types/ui'

/**
 * Message composer. With a thread it sends to that thread; without one
 * (empty pane) it emits `start` so the parent can create the thread first.
 */
const props = withDefaults(defineProps<{
  agent: AgentId
  model: string
  mode: Thread['mode']
  /** null: the CLI's default effort */
  effort?: string | null
  busy?: boolean
  autofocus?: boolean
  placeholder?: string
  large?: boolean
}>(), { effort: null, busy: false, autofocus: false, large: false })

const emit = defineEmits<{
  send: [text: string, attachments: Attachment[]]
  stop: []
  'update:agent': [agent: AgentId]
  'update:model': [model: string]
  'update:effort': [effort: string | null]
  'update:mode': [mode: Thread['mode']]
}>()

const ws = useWorkspace()
const text = defineModel<string>('text', { default: '' })
const ta = ref<HTMLTextAreaElement | null>(null)

function autosize() {
  const el = ta.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 280)}px`
}
watch(text, () => nextTick(autosize))

const canSend = computed(() => !!(text.value.trim() || attachments.value.length) && !pending.value.length)

function submit() {
  if (props.busy || !canSend.value) return
  emit('send', text.value, attachments.value)
  text.value = ''
  attachments.value = []
}

function onKey(e: KeyboardEvent) {
  if (e.code === 'Space' && e.shiftKey && isMod(e)) {
    e.preventDefault()
    toggleDictation()
    return
  }
  if (e.key === 'Escape' && listening.value) {
    // Discard the recording; the pane's Escape (stop the agent) waits for the next press.
    e.preventDefault()
    e.stopPropagation()
    dictation.cancel()
    return
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    submit()
  }
}

/* ---------- attachments: paste, pick or drop; stored on disk by the backend ---------- */

const attachments = defineModel<Attachment[]>('attachments', { default: () => [] })
/** Files on their way into the store, shown as placeholders. */
const pending = ref<{ key: number; name: string }[]>([])
let pendingKey = 0
const attachError = ref<string | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const formEl = ref<HTMLFormElement | null>(null)
const dropping = ref(false)

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function attach(jobs: { name: string; store: () => Promise<Attachment> }[]) {
  if (!jobs.length) return
  attachError.value = null
  const room = Math.max(0, MAX_ATTACHMENTS - attachments.value.length - pending.value.length)
  if (jobs.length > room) attachError.value = `A message can carry up to ${MAX_ATTACHMENTS} attachments.`
  await Promise.all(jobs.slice(0, room).map(async (job) => {
    const key = ++pendingKey
    pending.value = [...pending.value, { key, name: job.name }]
    try {
      const a = await job.store()
      attachments.value = [...attachments.value, a]
    } catch (e) {
      attachError.value = `Could not attach ${job.name}. ${errText(e)}`
    } finally {
      pending.value = pending.value.filter(p => p.key !== key)
    }
  }))
  ta.value?.focus()
}

/** Bytes from the clipboard or the browser's file input. */
const fromFile = (file: File, index: number) => {
  const name = pastedName(file, index)
  return {
    name,
    store: async (): Promise<Attachment> => {
      if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`It is ${formatSize(file.size)}; the limit is ${formatSize(MAX_ATTACHMENT_BYTES)}.`)
      const data = await blobToBase64(file)
      const info = await call('attachment_save', { name, data })
      return { ...info, thumb: await makeThumb(info.mime, data) }
    },
  }
}

/** A file on disk, picked natively or dropped on the window. */
const fromPath = (path: string) => ({
  name: baseName(path),
  store: async (): Promise<Attachment> => {
    const info = await call('attachment_import', { path })
    const thumb = info.mime.startsWith('image/') ? await makeThumb(info.mime, await call('attachment_read', { path: info.path })) : undefined
    return { ...info, thumb }
  },
})

/** Opens the composer's images in the viewer, at `id`. */
function viewAttachment(id: string) {
  const images = attachments.value.filter(a => a.thumb)
  openImage(images, images.findIndex(a => a.id === id))
}

function removeAttachment(id: string) {
  attachments.value = attachments.value.filter(a => a.id !== id)
  ta.value?.focus()
}

/** Pasting files (a screenshot, files copied in the file manager) attaches them; pasted text stays text. */
function onPaste(e: ClipboardEvent) {
  const data = e.clipboardData
  const files = [...(data?.files ?? [])]
  if (!files.length || data?.getData('text/plain')) return
  e.preventDefault()
  void attach(files.map(fromFile))
}

async function pick() {
  if (!isTauri()) {
    fileInput.value?.click()
    return
  }
  try {
    void attach((await pickFiles()).map(fromPath))
  } catch (e) {
    attachError.value = errText(e)
  }
}

function onFileInput(e: Event) {
  const input = e.target as HTMLInputElement
  void attach([...(input.files ?? [])].map(fromFile))
  input.value = ''
}

/*
 * Dropping files from the OS. The desktop webview takes HTML5 drag and drop over (AGENTS.md),
 * so this listens to the window's own drop events and checks whether they land on this
 * composer's pane (the nearest [data-drop-zone], else the composer itself).
 */
let unlistenDrop: UnlistenFn | undefined
let unmounted = false
function overZone(pos: { x: number; y: number }) {
  const zone = (formEl.value?.closest('[data-drop-zone]') ?? formEl.value) as HTMLElement | null
  if (!zone) return false
  const r = zone.getBoundingClientRect()
  const x = pos.x / window.devicePixelRatio
  const y = pos.y / window.devicePixelRatio
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
}
onMounted(async () => {
  if (!isTauri()) return
  const { getCurrentWebview } = await import('@tauri-apps/api/webview')
  const off = await getCurrentWebview().onDragDropEvent(({ payload: p }) => {
    if (p.type === 'leave') dropping.value = false
    else if (p.type === 'enter' || p.type === 'over') dropping.value = overZone(p.position)
    else if (p.type === 'drop') {
      const hit = overZone(p.position)
      dropping.value = false
      if (hit) void attach(p.paths.map(fromPath))
    }
  })
  if (unmounted) off()
  else unlistenDrop = off
})
onBeforeUnmount(() => {
  unmounted = true
  unlistenDrop?.()
})

let attachErrorTimer: ReturnType<typeof setTimeout> | undefined
watch(attachError, (msg) => {
  clearTimeout(attachErrorTimer)
  if (msg) attachErrorTimer = setTimeout(() => (attachError.value = null), 8000)
})
onBeforeUnmount(() => clearTimeout(attachErrorTimer))

/* ---------- voice input ---------- */

const voice = useVoice()

/** Puts dictated text where the caret is, with a space on either side where needed. */
function insertText(words: string) {
  const el = ta.value
  const value = text.value
  const from = el?.selectionStart ?? value.length
  const to = el?.selectionEnd ?? value.length
  const before = value.slice(0, from)
  const after = value.slice(to)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = after && !/^\s/.test(after) ? ' ' : ''
  text.value = before + lead + words + trail + after
  const caret = (before + lead + words + trail).length
  nextTick(() => {
    el?.focus()
    el?.setSelectionRange(caret, caret)
    if (voice.sendAfter) submit()
  })
}

const dictation = useDictation(insertText)
const { phase: dictationPhase, error: dictationError } = dictation
const listening = computed(() => dictationPhase.value === 'recording' || dictationPhase.value === 'starting')
const dictationShortcut = computed(() => `${modLabel()}+Shift+Space`)
const micLabel = computed(() => {
  if (listening.value) return 'Stop and transcribe'
  if (dictationPhase.value === 'transcribing') return 'Transcribing…'
  return voice.ready ? 'Dictate' : 'Set up voice input'
})
const elapsed = computed(() => {
  const s = dictation.seconds.value
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
})
/** Five bars, each lit once the level passes its step. */
const bars = computed(() => [0.08, 0.2, 0.35, 0.55, 0.75].map(t => dictation.level.value > t))

async function toggleDictation() {
  if (dictationPhase.value === 'idle') {
    await voice.ensureLoaded()
    if (!voice.ready) {
      ws.openSettings('voice')
      return
    }
  }
  dictation.toggle()
  ta.value?.focus()
}

let errorTimer: ReturnType<typeof setTimeout> | undefined
watch(dictationError, (msg) => {
  clearTimeout(errorTimer)
  if (msg) errorTimer = setTimeout(() => (dictationError.value = null), 8000)
})
onBeforeUnmount(() => clearTimeout(errorTimer))

onMounted(() => {
  void voice.ensureLoaded()
  autosize()
  if (props.autofocus) ta.value?.focus()
})
defineExpose({ focus: () => ta.value?.focus() })

const agentInfo = (id: AgentId) => ws.agents.find(a => a.id === id)

const agentItems = computed<MenuItem[]>(() => (Object.keys(AGENTS) as AgentId[]).map(id => {
  const info = agentInfo(id)
  return {
    label: AGENTS[id].name,
    hint: info && !info.installed ? 'Not installed. See Settings > Agents.' : undefined,
    checked: props.agent === id,
    onSelect: () => emit('update:agent', id),
  }
}))

/* ---------- model and effort: the lists come from the CLI itself (stores/models.ts) ---------- */

const models = useModels()
const refreshModels = () => void models.refresh(props.agent, ws.activeProjectPath)
watch(() => props.agent, refreshModels, { immediate: true })

const modelItems = computed<MenuItem[]>(() => {
  const list = models.list(props.agent)
  // Claude Code lists its aliases first, then pinned versions: set those apart.
  const firstPinned = list.findIndex(m => m.id.startsWith('claude-'))
  return list.map((m, i) => ({
    label: m.label,
    hint: m.hint,
    checked: props.model === m.id,
    divider: i > 0 && i === firstPinned,
    onSelect: () => {
      emit('update:model', m.id)
      if (props.effort && !(m.efforts ?? []).includes(props.effort)) emit('update:effort', null)
    },
  }))
})

const efforts = computed(() => models.efforts(props.agent, props.model))
/** The level the CLI picks when none is chosen, when it says (both report it with their model lists). */
const fallbackEffort = computed(() => models.find(props.agent, props.model)?.defaultEffort)
/** How full the meter is: the chosen level, else the CLI's default (shown muted), else empty. */
const effortMeter = computed(() => {
  const level = props.effort ?? fallbackEffort.value
  return { value: level ? efforts.value.indexOf(level) + 1 : 0, max: efforts.value.length, muted: !props.effort }
})
/**
 * The level the chat runs at: the chosen one, else the CLI's default.
 * Until the CLI has answered (or for a model it gives no default for) that reads "Default".
 */
const effortText = computed(() => {
  const level = props.effort ?? fallbackEffort.value
  return level ? effortLabel(level) : 'Default'
})
const effortTitle = computed(() => {
  if (props.effort) return `Effort: ${effortText.value}`
  const usual = `${AGENTS[props.agent].name}'s default`
  return fallbackEffort.value ? `Effort: ${effortText.value} (${usual})` : `Effort: ${usual}`
})

const modes = {
  plan: { label: 'Plan', hint: 'Read-only: explores and proposes a plan', icon: MapIcon },
  ask: { label: 'Ask first', hint: 'Asks before edits and commands', icon: ShieldCheck },
  edits: { label: 'Accept edits', hint: 'Edits files freely, asks before commands', icon: FilePen },
  auto: { label: 'Full auto', hint: 'Never asks. Use with care.', icon: Zap },
} as const
const modeItems = computed<MenuItem[]>(() => (Object.keys(modes) as Thread['mode'][]).map(k => ({
  label: modes[k].label,
  hint: modes[k].hint,
  icon: modes[k].icon,
  checked: props.mode === k,
  onSelect: () => emit('update:mode', k),
})))

const ph = computed(() => props.placeholder ?? `Ask ${AGENTS[props.agent].name} to build, fix or explain…`)
</script>

<template>
  <form
    ref="formEl"
    class="cp"
    :class="{ 'cp--large': large, 'is-busy': busy, 'is-dropping': dropping }"
    @submit.prevent="submit"
    @click.self="ta?.focus()"
  >
    <ul v-if="attachments.length || pending.length" class="cp__files" aria-label="Attachments">
      <li
        v-for="a in attachments"
        :key="a.id"
        class="cp__file"
        :class="{ 'cp__file--image': a.thumb }"
        :title="`${a.name} · ${formatSize(a.size)}`"
      >
        <button v-if="a.thumb" type="button" class="cp__thumb-btn" :aria-label="`View ${a.name}`" @click="viewAttachment(a.id)">
          <img class="cp__thumb" :src="a.thumb" alt="">
        </button>
        <template v-else>
          <FileText class="cp__file-icon" aria-hidden="true" />
          <span class="cp__file-meta">
            <span class="cp__file-name">{{ a.name }}</span>
            <span class="cp__file-size tabular">{{ formatSize(a.size) }}</span>
          </span>
        </template>
        <button type="button" class="cp__file-x" :aria-label="`Remove ${a.name}`" @click="removeAttachment(a.id)">
          <X />
        </button>
      </li>
      <li v-for="p in pending" :key="p.key" class="cp__file is-pending" :title="`Attaching ${p.name}…`">
        <span class="cp__spin" aria-hidden="true" />
        <span class="cp__file-meta">
          <span class="cp__file-name">{{ p.name }}</span>
          <span class="cp__file-size">Attaching…</span>
        </span>
      </li>
    </ul>
    <p v-if="dropping" class="cp__drop" aria-hidden="true">Drop files to attach</p>
    <input ref="fileInput" type="file" multiple hidden @change="onFileInput">
    <textarea
      ref="ta"
      v-model="text"
      class="cp__input"
      rows="1"
      :placeholder="ph"
      :aria-label="ph"
      @keydown="onKey"
      @paste="onPaste"
    />
    <div class="cp__bar">
      <UiMenu :items="agentItems" placement="top-start" :width="280" label="Agent">
        <template #default="{ toggle, open }">
          <button type="button" class="cp__chip cp__chip--agent" :class="{ 'is-open': open }" @click="toggle">
            <span class="cp__agent-dot" :class="`cp__agent-dot--${agent}`" aria-hidden="true" />
            <span class="cp__chip-text">{{ AGENTS[agent].name }}</span>
            <ChevronDown />
          </button>
        </template>
      </UiMenu>
      <UiMenu :items="modelItems" placement="top-start" :width="270" label="Model">
        <template #default="{ toggle, open }">
          <button type="button" class="cp__chip" :class="{ 'is-open': open }" @click="() => { toggle(); refreshModels() }">
            <span class="cp__chip-text">{{ models.label(agent, model) }}</span>
            <ChevronDown />
          </button>
        </template>
      </UiMenu>
      <ChatEffort
        v-if="efforts.length"
        :efforts="efforts"
        :model-value="effort"
        :fallback="fallbackEffort"
        :agent-name="AGENTS[agent].name"
        @update:model-value="e => emit('update:effort', e)"
      >
        <template #default="{ toggle, open }">
          <button
            type="button"
            class="cp__chip"
            :class="{ 'is-open': open, 'is-default': !effort }"
            :title="effortTitle"
            @click="toggle"
          >
            <UiLevel class="cp__effort" size="sm" :value="effortMeter.value" :max="effortMeter.max" :muted="effortMeter.muted" />
            <span class="cp__chip-text cp__mode-text">{{ effortText }}</span>
            <ChevronDown />
          </button>
        </template>
      </ChatEffort>
      <UiMenu :items="modeItems" placement="top-start" :width="290" label="Permissions">
        <template #default="{ toggle, open }">
          <button type="button" class="cp__chip" :class="[{ 'is-open': open }, `cp__chip--mode-${mode}`]" :title="`Permissions: ${modes[mode].label}`" @click="toggle">
            <component :is="modes[mode].icon" />
            <span class="cp__chip-text cp__mode-text">{{ modes[mode].label }}</span>
            <ChevronDown />
          </button>
        </template>
      </UiMenu>

      <span class="cp__spacer" />
      <div class="cp__voice" role="status" aria-live="polite">
        <template v-if="listening">
          <span class="cp__rec" aria-hidden="true" />
          <span class="cp__time tabular" aria-label="Recording">{{ elapsed }}</span>
          <span class="cp__meter" aria-hidden="true">
            <span v-for="(on, i) in bars" :key="i" class="cp__level" :class="{ 'is-on': on }" />
          </span>
        </template>
        <span v-else-if="dictationPhase === 'transcribing'" class="cp__voice-text">
          <span class="cp__spin" aria-hidden="true" />Transcribing…
        </span>
        <span v-else-if="dictationError" class="cp__voice-text cp__voice-text--error" :title="dictationError">
          {{ dictationError }}
        </span>
        <span v-else-if="attachError" class="cp__voice-text cp__voice-text--error" :title="attachError">
          {{ attachError }}
        </span>
      </div>
      <UiIconButton
        v-if="listening"
        class="cp__keep"
        size="sm"
        label="Discard recording"
        shortcut="Esc"
        @click="dictation.cancel()"
      >
        <X />
      </UiIconButton>
      <UiIconButton v-else size="sm" label="Attach files or paste an image" @click="pick"><Paperclip /></UiIconButton>
      <button
        type="button"
        class="cp__mic"
        :class="{ 'is-on': listening }"
        :aria-label="micLabel"
        :aria-pressed="listening"
        :title="`${micLabel} (${dictationShortcut})`"
        :disabled="dictationPhase === 'transcribing'"
        @click="toggleDictation"
      >
        <Square v-if="listening" class="cp__mic-stop" />
        <Mic v-else />
      </button>
      <button
        v-if="busy"
        type="button"
        class="cp__send cp__send--stop"
        aria-label="Stop"
        title="Stop (Esc)"
        @click="emit('stop')"
      >
        <Square />
      </button>
      <button
        v-else
        type="submit"
        class="cp__send"
        :disabled="!canSend"
        aria-label="Send"
        title="Send (Enter)"
      >
        <ArrowUp />
      </button>
    </div>
  </form>
</template>

<style scoped>
.cp {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3) var(--space-2) var(--space-2) var(--space-3);
  background: var(--bg-panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-soft);
  cursor: text;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.cp:focus-within { border-color: var(--line-strong); box-shadow: var(--shadow-soft), 0 0 0 3px var(--accent-soft); }
.cp.is-dropping { border-color: var(--accent-line); box-shadow: var(--shadow-soft), 0 0 0 3px var(--accent-soft); }
.cp { position: relative; }
.cp__drop {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: grid;
  place-items: center;
  margin: 0;
  border-radius: inherit;
  background: color-mix(in oklab, var(--bg-panel) 88%, transparent);
  font-size: var(--text-sm);
  font-weight: 540;
  color: var(--accent-ink);
  pointer-events: none;
}

.cp__files {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: 0 0 var(--space-2);
  padding: 0;
  list-style: none;
  cursor: default;
}
.cp__file {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 48px;
  max-width: 220px;
  padding: 0 var(--space-3) 0 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
}
.cp__file--image { width: 48px; padding: 0; overflow: hidden; background: var(--bg-inset); }
.cp__thumb-btn { display: block; width: 100%; height: 100%; padding: 0; cursor: zoom-in; }
.cp__thumb-btn:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; border-radius: var(--radius-md); }
.cp__thumb { width: 100%; height: 100%; object-fit: cover; display: block; }
.cp__file-icon { flex: none; width: 18px; height: 18px; stroke-width: 1.75; color: var(--fg-subtle); }
.cp__file-meta { display: flex; flex-direction: column; min-width: 0; line-height: var(--leading-tight); }
.cp__file-name { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: var(--text-xs); font-weight: 540; color: var(--fg); }
.cp__file-size { font-size: var(--text-2xs); color: var(--fg-subtle); }
.cp__file.is-pending { color: var(--fg-subtle); }
.cp__file.is-pending .cp__file-name { color: var(--fg-muted); }
.cp__file-x {
  position: absolute;
  top: 3px;
  right: 3px;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: var(--radius-pill);
  background: var(--bg-canvas);
  border: 1px solid var(--line);
  color: var(--fg-muted);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.cp__file-x svg { width: 11px; height: 11px; stroke-width: 2.25; }
.cp__file:hover .cp__file-x, .cp__file-x:focus-visible { opacity: 1; }
.cp__file-x:hover { color: var(--fg); }
.cp__file-x:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }

.cp__input {
  width: 100%;
  min-height: 22px;
  max-height: 280px;
  padding: 0 var(--space-1);
  resize: none;
  border: 0;
  background: transparent;
  font-size: var(--text-md);
  line-height: 1.55;
  color: var(--fg);
}
.cp--large .cp__input { min-height: 48px; }
.cp__input:focus-visible { outline: none; }
.cp__input::placeholder { color: var(--fg-faint); }
.cp__bar { display: flex; align-items: center; gap: 2px; cursor: default; }
.cp__spacer { flex: 1; }

.cp__chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 6px 0 8px;
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  font-weight: 540;
  color: var(--fg-subtle);
  white-space: nowrap;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.cp__chip-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.cp__bar :deep(.menu), .cp__bar :deep(.ef-anchor) { flex: 0 1 auto; }
.cp__bar :deep(.menu:first-child) { flex-shrink: 0; }
.cp__chip { min-width: 0; max-width: 100%; }
.cp__chip svg { flex: none; }
/* Narrow panes (split view at small window sizes): keep agent and model, drop the rest to icons. */
@container (max-width: 400px) {
  .cp__mode-text { display: none; }
  .cp__bar :deep(.icon-btn:not(.cp__keep)) { display: none; }
  .cp__voice-text--error { display: none; }
}
.cp__chip:hover, .cp__chip.is-open { background: var(--bg-hover); color: var(--fg); }
.cp__chip svg { width: 12px; height: 12px; stroke-width: 2; opacity: 0.7; }
.cp__chip--agent { color: var(--fg-muted); }
.cp__effort { margin-right: 1px; }
.cp__chip--mode-auto svg:first-child { color: var(--accent-ink); opacity: 1; }
.cp__agent-dot { width: 8px; height: 8px; border-radius: 2px; }
.cp__agent-dot--claude { background: var(--accent); }
.cp__agent-dot--codex { background: var(--fg-muted); border-radius: 50%; }

.cp__voice {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  /* Gives way before the agent, model and permission chips do. */
  flex-shrink: 100;
  margin-right: var(--space-1);
  font-size: var(--text-xs);
  color: var(--fg-subtle);
}
.cp__voice:empty { display: none; }
.cp__voice-text {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.cp__voice-text--error { display: block; max-width: 36ch; color: var(--ripe-error-fg); }
.cp__rec {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ripe-error);
  animation: cp-rec 1.4s var(--ease-in-out) infinite;
}
@keyframes cp-rec { 50% { opacity: 0.35; } }
.cp__time { color: var(--fg-muted); }
.cp__meter { display: inline-flex; align-items: center; gap: 2px; height: 12px; }
.cp__level {
  width: 2px;
  border-radius: var(--radius-pill);
  background: var(--line-strong);
  transition: background var(--dur-fast) var(--ease-out);
}
.cp__level:nth-child(1) { height: 4px; }
.cp__level:nth-child(2) { height: 6px; }
.cp__level:nth-child(3) { height: 8px; }
.cp__level:nth-child(4) { height: 10px; }
.cp__level:nth-child(5) { height: 12px; }
.cp__level.is-on { background: var(--fg-muted); }
.cp__spin {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  animation: cp-spin 0.7s linear infinite;
}
@keyframes cp-spin { to { transform: rotate(360deg); } }

.cp__mic {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  margin-left: 2px;
  border-radius: var(--radius-sm);
  color: var(--fg-subtle);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.cp__mic svg { width: 16px; height: 16px; stroke-width: 1.85; }
.cp__mic:hover:not(:disabled) { background: var(--bg-hover); color: var(--fg); }
.cp__mic.is-on { background: var(--bg-active); color: var(--fg); }
.cp__mic .cp__mic-stop { width: 10px; height: 10px; fill: currentColor; }
.cp__mic:disabled { opacity: 0.5; }

@media (prefers-reduced-motion: reduce) {
  .cp__rec, .cp__spin { animation: none; }
  .cp__file-x { transition: none; }
}

.cp__send {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  margin-left: var(--space-1);
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: var(--accent-fg);
  transition: background var(--dur-fast) var(--ease-out), opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.cp__send svg { width: 16px; height: 16px; stroke-width: 2.25; }
.cp__send:hover:not(:disabled) { background: var(--accent-strong); }
.cp__send:active:not(:disabled) { transform: scale(0.94); }
.cp__send:disabled { background: var(--bg-active); color: var(--fg-faint); }
.cp__send--stop { background: var(--fg); color: var(--bg-canvas); }
.cp__send--stop svg { width: 11px; height: 11px; fill: currentColor; }
.cp__send--stop:hover { background: var(--fg-muted); }
</style>
