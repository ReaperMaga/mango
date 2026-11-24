<script setup lang="ts">
import { ArrowUpRight, ChevronRight, CircleDot, GitPullRequest, FileText, FilePen, FilePlus, Search, SquareTerminal, Globe, CircleAlert, Wrench } from 'lucide-vue-next'
import type { Part } from '~/types/chat'
import { openImage } from '~/utils/imageViewer'
import { useThreads } from '~/stores/threads'
import { useLinks } from '~/stores/links'
import { createdBy, linkFromRef, type ItemRef } from '~/utils/githubLinks'
import { itemNoun, itemNumber } from '~/utils/forge'

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

/** A delegated task has a chat of its own: the sub-agent's. */
const threads = useThreads()
const child = computed(() => (props.part.childId ? threads.byId(props.part.childId) : null))

/** A pull request, merge request or issue this call opened: linked to the chat, shown in the Pull requests tool window. */
const created = computed(() => createdBy(props.part))
const links = useLinks()
function showCreated(item: ItemRef) {
  // Chats from before linking existed get the link now. The pane was focused on mousedown.
  const chat = threads.activeThread
  if (chat) threads.link(chat.id, linkFromRef(item, 'agent'))
  links.show(item.key)
}
</script>

<template>
  <div class="tool" :class="[`tool--${part.status}`, { 'is-open': open && expandable, 'has-child': child }]">
    <div class="tool__line">
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
    <button
      v-for="it in created"
      :key="it.key"
      type="button"
      class="tool__open"
      :title="`Show ${itemNoun(it.kind, it.provider)} ${itemNumber(it)} beside the chat`"
      @click="showCreated(it)"
    >
      <GitPullRequest v-if="it.kind === 'pr'" aria-hidden="true" /><CircleDot v-else aria-hidden="true" />
      <span class="tabular">{{ itemNumber(it) }}</span>
    </button>
    <button v-if="child" type="button" class="tool__open" :title="`Open the sub-agent's chat: ${child.title}`" @click="threads.show(child.id)">
      <span>Open</span><ArrowUpRight aria-hidden="true" />
    </button>
    </div>

    <ul v-if="part.images?.length" class="tool__images" aria-label="Images">
      <li v-for="(img, i) in part.images" :key="img.id">
        <button type="button" class="tool__image" :aria-label="`View ${img.name}`" :title="img.name" @click="openImage(part.images!, i)">
          <img v-if="img.thumb" :src="img.thumb" alt="">
        </button>
      </li>
    </ul>

    <UiReveal>
      <div v-if="open && expandable" class="tool__detail selectable">
        <div v-if="part.diff?.length" class="diff" role="table" aria-label="Diff">
          <div v-for="(l, i) in part.diff" :key="i" class="diff__line" :class="`diff__line--${l.kind}`" role="row">
            <span class="diff__sign" aria-hidden="true">{{ l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : l.kind === 'hunk' ? '⋯' : ' ' }}</span>
            <span class="diff__text">{{ l.text || ' ' }}</span>
          </div>
        </div>
        <pre v-else-if="part.output" class="tool__out">{{ part.output }}</pre>
      </div>
    </UiReveal>
  </div>
</template>

<style scoped>
.tool { font-size: var(--text-sm); }
.tool__line { display: flex; align-items: center; gap: var(--space-1); }
.tool__line > .tool__row { flex: 1; min-width: 0; }
.tool__open {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 22px;
  padding: 0 6px 0 8px;
  border-radius: var(--radius-xs);
  font-size: var(--text-xs);
  font-weight: 540;
  color: var(--accent-ink);
  transition: background var(--dur-fast) var(--ease-out);
}
.tool__open:hover { background: var(--bg-hover); }
.tool__open:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.tool__open svg { width: 13px; height: 13px; stroke-width: 1.85; }
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

.tool__images {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: 2px 0 6px 24px;
  padding: 0;
  list-style: none;
}
.tool__image {
  display: block;
  height: 72px;
  max-width: 160px;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
  cursor: zoom-in;
  transition: border-color var(--dur-fast) var(--ease-out);
}
.tool__image:hover { border-color: var(--line-strong); }
.tool__image:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.tool__image img { display: block; height: 100%; width: auto; max-width: 160px; object-fit: cover; }

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
