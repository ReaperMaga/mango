<script setup lang="ts">
import { ArrowUp, ChevronDown, Paperclip, Square, ShieldCheck, Zap, Map as MapIcon, FilePen } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'
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
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    submit()
  }
}

onMounted(() => {
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
      <UiIconButton size="sm" label="Attach files (coming soon)" disabled><Paperclip /></UiIconButton>
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
  .cp__bar :deep(.icon-btn) { display: none; }
}
.cp__chip:hover, .cp__chip.is-open { background: var(--bg-hover); color: var(--fg); }
.cp__chip svg { width: 12px; height: 12px; stroke-width: 2; opacity: 0.7; }
.cp__chip--agent { color: var(--fg-muted); }
.cp__chip--mode-auto svg:first-child { color: var(--accent-ink); opacity: 1; }
.cp__agent-dot { width: 8px; height: 8px; border-radius: 2px; }
.cp__agent-dot--claude { background: var(--accent); }
.cp__agent-dot--codex { background: var(--fg-muted); border-radius: 50%; }

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
