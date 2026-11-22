<script setup lang="ts">
import { Cloud, GitBranch, GitCommitHorizontal, Tag } from 'lucide-vue-next'
import type { GitRef } from '~/types/ipc'
import { sortGitRefs } from '~/utils/gitLog'

/** The branches, remote branches and tags on a commit, as chips. `max`: the rest become "+2". */
const props = defineProps<{ refs: GitRef[]; max?: number; wrap?: boolean }>()

const ICONS = { head: GitCommitHorizontal, branch: GitBranch, remote: Cloud, tag: Tag }

const sorted = computed(() => sortGitRefs(props.refs))
const chips = computed(() => (props.max ? sorted.value.slice(0, props.max) : sorted.value))
const rest = computed(() => sorted.value.slice(chips.value.length))

function title(r: GitRef) {
  if (r.kind === 'head') return 'Detached HEAD'
  if (r.kind === 'tag') return `Tag ${r.name}`
  if (r.kind === 'remote') return `Remote branch ${r.name}`
  return r.current ? `${r.name}, the checked-out branch` : `Branch ${r.name}`
}
</script>

<template>
  <span class="refs" :class="{ 'is-wrap': wrap }">
    <span v-for="r in chips" :key="`${r.kind}:${r.name}`" class="refs__chip" :class="[`is-${r.kind}`, { 'is-current': r.current }]" :title="title(r)">
      <component :is="ICONS[r.kind]" class="refs__icon" aria-hidden="true" />
      <span class="refs__name">{{ r.name }}</span>
    </span>
    <span v-if="rest.length" class="refs__chip is-more" :title="rest.map(r => r.name).join(', ')">+{{ rest.length }}</span>
  </span>
</template>

<style scoped>
.refs {
  flex: 0 10 auto;
  /* A long subject gives way before the first chip (the checked-out branch) becomes a sliver. */
  min-width: min(40%, 60px);
  display: inline-flex;
  align-items: center;
  gap: 3px;
  overflow: hidden;
}
.refs.is-wrap { flex-wrap: wrap; gap: var(--space-1); overflow: visible; }
.refs:not(.is-wrap) .refs__chip:first-child { flex-shrink: 1; }
.refs__chip {
  flex: 0 5 auto;
  min-width: 0;
  max-width: 160px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 18px;
  padding: 0 5px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-xs);
  background: var(--bg-hover);
  color: var(--fg-muted);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  line-height: 1;
}
.refs__icon { flex: none; width: 11px; height: 11px; stroke-width: 1.75; color: var(--fg-subtle); }
.refs__name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.refs__chip.is-remote { background: none; color: var(--fg-subtle); }
.refs__chip.is-current, .refs__chip.is-head { border-color: var(--accent-line); color: var(--accent-ink); }
.refs__chip.is-current .refs__icon, .refs__chip.is-head .refs__icon { color: var(--accent-ink); }
.refs__chip.is-more { flex: none; font-family: var(--font-ui); background: none; color: var(--fg-subtle); }
</style>
