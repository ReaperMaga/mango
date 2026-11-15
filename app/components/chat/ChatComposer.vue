<script setup lang="ts">
import { ArrowUp, ChevronDown, Mic, Paperclip, Square, ShieldCheck, X, Zap, Map as MapIcon, FilePen } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'
import { useVoice } from '~/stores/voice'
import { useDictation } from '~/composables/useDictation'
import { isMod, modLabel } from '~/composables/useShortcuts'
import { AGENTS, modelLabel, type AgentId, type Thread } from '~/types/chat'
import type { MenuItem } from '~/types/ui'

/**
 * Message composer. With a thread it sends to that thread; without one
 * (empty pane) it emits `start` so the parent can create the thread first.
 */
const props = withDefaults(defineProps<{
  agent: AgentId
  model: string
  mode: Thread['mode']
  busy?: boolean
  autofocus?: boolean
  placeholder?: string
  large?: boolean
}>(), { busy: false, autofocus: false, large: false })

const emit = defineEmits<{
  send: [text: string]
  stop: []
  'update:agent': [agent: AgentId]
  'update:model': [model: string]
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

function submit() {
  if (props.busy || !text.value.trim()) return
  emit('send', text.value)
  text.value = ''
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

const modelItems = computed<MenuItem[]>(() => AGENTS[props.agent].models.map(m => ({
  label: m.label,
  hint: m.hint,
  checked: props.model === m.id,
  onSelect: () => emit('update:model', m.id),
})))

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
  <form class="cp" :class="{ 'cp--large': large, 'is-busy': busy }" @submit.prevent="submit" @click.self="ta?.focus()">
    <textarea
      ref="ta"
      v-model="text"
      class="cp__input"
      rows="1"
      :placeholder="ph"
      :aria-label="ph"
      @keydown="onKey"
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
          <button type="button" class="cp__chip" :class="{ 'is-open': open }" @click="toggle">
            <span class="cp__chip-text">{{ modelLabel(agent, model) }}</span>
            <ChevronDown />
          </button>
        </template>
      </UiMenu>
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
      <UiIconButton v-else size="sm" label="Attach files (coming soon)" disabled><Paperclip /></UiIconButton>
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
        :disabled="!text.trim()"
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
.cp__bar :deep(.menu) { flex: 0 1 auto; }
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
