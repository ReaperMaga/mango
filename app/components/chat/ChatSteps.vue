<script setup lang="ts">
import { ChevronRight } from 'lucide-vue-next'
import type { Part, ToolKind } from '~/types/chat'
import { formatDuration } from '~/utils/time'

type Step = Extract<Part, { type: 'thinking' } | { type: 'tool' }>

/**
 * A run of consecutive thinking and tool rows, folded under one summary line
 * ("Ran 3 commands, read 2 files, thought for 7s"). While the run is the live
 * end of a turn, the newest step stays visible under the summary.
 */
const props = defineProps<{ steps: Step[]; live?: boolean }>()
const open = ref(false)

const nouns: Record<ToolKind, [verb: string, one: string, many: string]> = {
  bash: ['ran', 'command', 'commands'],
  read: ['read', 'file', 'files'],
  edit: ['edited', 'file', 'files'],
  write: ['created', 'file', 'files'],
  search: ['ran', 'search', 'searches'],
  web: ['fetched', 'page', 'pages'],
  other: ['used', 'tool', 'tools'],
}

const summary = computed(() => {
  // Phrases in order of first appearance; each tool kind counted on its own.
  const counts = new Map<ToolKind | 'thinking' | 'browser', number>()
  let seconds = 0
  for (const s of props.steps) {
    // Steps in Mango's browser (labelled so by the adapters) are counted as browser use, not page fetches.
    const key = s.type === 'thinking' ? 'thinking' : s.label === 'Browser' ? 'browser' : s.tool
    counts.set(key, (counts.get(key) ?? 0) + 1)
    if (s.type === 'thinking') seconds += s.seconds
  }
  const bits = [...counts].map(([key, n]) => {
    if (key === 'thinking') return seconds > 0 ? `thought for ${formatDuration(seconds * 1000)}` : 'thought'
    if (key === 'browser') return n === 1 ? 'used the browser' : `used the browser ${n} times`
    const [verb, one, many] = nouns[key]
    return `${verb} ${n} ${n === 1 ? one : many}`
  })
  const text = bits.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
})

const failed = computed(() => props.steps.filter(s => s.type === 'tool' && s.status === 'error').length)
const latest = computed(() => props.steps[props.steps.length - 1]!)
const visible = computed<Step[]>(() => (open.value ? props.steps : props.live ? [latest.value] : []))
</script>

<template>
  <div class="steps" :class="{ 'is-open': open }">
    <button type="button" class="steps__head" :aria-expanded="open" @click="open = !open">
      <ChevronRight class="steps__caret" aria-hidden="true" />
      <span class="steps__sum">{{ summary }}</span>
      <span v-if="failed" class="steps__failed">· {{ failed }} failed</span>
    </button>
    <div v-if="visible.length" class="steps__body">
      <template v-for="(s, i) in visible" :key="s.id ?? i">
        <ChatThinking
          v-if="s.type === 'thinking'"
          :text="s.text"
          :seconds="s.seconds"
          :live="live && s === latest && s.seconds === 0"
        />
        <ChatTool v-else :part="s" />
      </template>
    </div>
  </div>
</template>

<style scoped>
.steps { font-size: var(--text-sm); }
.steps__head {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  min-height: 28px;
  color: var(--fg-subtle);
  border-radius: var(--radius-xs);
  text-align: left;
}
.steps__head:hover { color: var(--fg-muted); }
.steps__caret { width: 13px; height: 13px; flex: none; transition: transform var(--dur-fast) var(--ease-out); }
.steps.is-open .steps__caret { transform: rotate(90deg); }
.steps__sum { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.steps__failed { flex: none; color: var(--ripe-error-fg); }
.steps__body {
  margin: 2px 0 4px 6px;
  padding-left: var(--space-3);
  border-left: 1px solid var(--line);
}
</style>
