<script setup lang="ts">
import { ChevronRight, FileText, FilePen, FilePlus, Search, SquareTerminal, Globe, CircleAlert, Wrench } from 'lucide-vue-next'
import type { Part } from '~/types/chat'

type ToolPart = Extract<Part, { type: 'tool' }>
const props = defineProps<{ part: ToolPart }>()

const meta = {
  read: { icon: FileText, done: 'Read', doing: 'Reading' },
  edit: { icon: FilePen, done: 'Edited', doing: 'Editing' },
  write: { icon: FilePlus, done: 'Created', doing: 'Creating' },
  search: { icon: Search, done: 'Searched', doing: 'Searching' },
  bash: { icon: SquareTerminal, done: 'Ran', doing: 'Running' },
  web: { icon: Globe, done: 'Fetched', doing: 'Fetching' },
  other: { icon: Wrench, done: 'Used', doing: 'Using' },
} as const

const m = computed(() => meta[props.part.tool])
const expandable = computed(() => !!(props.part.output || props.part.diff?.length))
const open = ref(props.part.status === 'error')
</script>

<template>
  <div class="tool" :class="[`tool--${part.status}`, { 'is-open': open && expandable }]">
    <component
      :is="expandable ? 'button' : 'div'"
      :type="expandable ? 'button' : undefined"
      class="tool__row"
      :aria-expanded="expandable ? open : undefined"
      @click="expandable && (open = !open)"
    >
      <span class="tool__icon">
        <span v-if="part.status === 'running'" class="tool__spin" aria-hidden="true" />
        <CircleAlert v-else-if="part.status === 'error'" />
        <component :is="m.icon" v-else />
      </span>
      <span class="tool__verb">{{ part.label ?? (part.status === 'running' ? m.doing : m.done) }}</span>
      <code class="tool__target">{{ part.target }}</code>
      <span v-if="part.summary" class="tool__sum tabular">{{ part.summary }}</span>
      <ChevronRight v-if="expandable" class="tool__caret" />
    </component>

    <div v-if="open && expandable" class="tool__detail selectable">
      <div v-if="part.diff?.length" class="diff" role="table" aria-label="Diff">
        <div v-for="(l, i) in part.diff" :key="i" class="diff__line" :class="`diff__line--${l.kind}`" role="row">
          <span class="diff__sign" aria-hidden="true">{{ l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : l.kind === 'hunk' ? '⋯' : ' ' }}</span>
          <span class="diff__text">{{ l.text || ' ' }}</span>
        </div>
      </div>
      <pre v-else-if="part.output" class="tool__out">{{ part.output }}</pre>
    </div>
  </div>
</template>

<style scoped>
.tool { font-size: var(--text-sm); }
.tool__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 28px;
  padding: 0 var(--space-2);
  margin-left: calc(var(--space-2) * -1);
  border-radius: var(--radius-sm);
  color: var(--fg-subtle);
  text-align: left;
}
button.tool__row:hover { background: var(--bg-hover); color: var(--fg-muted); }
.tool__icon { width: 16px; height: 16px; display: grid; place-items: center; flex: none; }
.tool__icon svg { width: 14px; height: 14px; stroke-width: 1.75; }
.tool__verb { flex: none; color: var(--fg-muted); font-weight: 520; }
.tool__target {
  min-width: 0;
  font-size: var(--text-xs);
  color: var(--fg-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool__sum { flex: none; margin-left: auto; font-size: var(--text-xs); color: var(--fg-faint); }
.tool__caret { width: 13px; height: 13px; flex: none; color: var(--fg-faint); transition: transform var(--dur-fast) var(--ease-out); }
.tool.is-open .tool__caret { transform: rotate(90deg); }
.tool__sum + .tool__caret { margin-left: 0; }
.tool__target + .tool__caret { margin-left: auto; }

.tool--running .tool__verb { color: var(--fg); }
.tool--error .tool__icon, .tool--error .tool__verb { color: var(--ripe-error); }
.tool--error .tool__sum { color: var(--ripe-error); opacity: 0.85; }

.tool__spin {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 1.75px solid var(--ripe-running);
  border-right-color: transparent;
  animation: spin 0.75s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.tool__detail {
  margin: 4px 0 6px 24px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
  overflow: hidden;
}
.tool__out {
  margin: 0;
  padding: var(--space-3);
  font-size: var(--text-xs);
  line-height: 1.6;
  color: var(--fg-muted);
  white-space: pre-wrap;
  max-height: 260px;
  overflow: auto;
}
.diff { font-family: var(--font-mono); font-size: var(--text-xs); line-height: 1.7; padding: 6px 0; overflow-x: auto; }
.diff__line { display: flex; padding-right: var(--space-3); white-space: pre; min-width: max-content; }
.diff__sign { width: 24px; flex: none; text-align: center; color: var(--fg-faint); user-select: none; }
.diff__text { color: var(--fg-muted); }
.diff__line--hunk { margin: 4px 0; border-block: 1px solid var(--line-soft); background: var(--bg-hover); }
.diff__line--hunk .diff__text, .diff__line--hunk .diff__sign { color: var(--fg-faint); }
.diff__line--add { background: var(--diff-add-bg); }
.diff__line--add .diff__sign, .diff__line--add .diff__text { color: var(--diff-add-fg); }
.diff__line--del { background: var(--diff-del-bg); }
.diff__line--del .diff__sign, .diff__line--del .diff__text { color: var(--diff-del-fg); }
</style>
