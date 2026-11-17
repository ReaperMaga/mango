<script setup lang="ts">
import { Lock, Minus, Plus, Undo2, X } from 'lucide-vue-next'
import type { GitFile, VcsLock } from '~/types/ipc'
import type { MenuItem } from '~/types/ui'
import type { GitDiffEntry } from '~/stores/git'
import { lockHolder, lockSummary } from '~/utils/vcs'

const props = defineProps<{
  file: GitFile
  /** Which list the row is in: the staged side or the working-tree side of the file. */
  staged: boolean
  expanded: boolean
  diff: GitDiffEntry | null
  /** The row is asking "Discard?" */
  confirming: boolean
  /** An action is running: row actions wait. */
  disabled: boolean
  /** Unity VCS: the lock on this file, if any. */
  lock?: VcsLock | null
  /** Items of the row's context menu (right-click, or the context-menu key); none: no menu. */
  menu?: MenuItem[] | null
}>()

const emit = defineEmits<{
  toggle: []
  stage: []
  unstage: []
  /** First step of discarding: ask. */
  ask: []
  cancel: []
  /** Second step: do it. */
  discard: []
}>()

type Kind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict'

const state = computed<{ kind: Kind; letter: string; word: string }>(() => {
  const f = props.file
  if (f.conflicted) return { kind: 'conflict', letter: 'U', word: 'Merge conflict' }
  const code = props.staged ? f.index : f.worktree
  switch (code) {
    case '?': return { kind: 'untracked', letter: '?', word: 'New file, not tracked yet' }
    case 'A': return { kind: 'added', letter: 'A', word: 'Added' }
    case 'D': return { kind: 'deleted', letter: 'D', word: 'Deleted' }
    case 'R': return { kind: 'renamed', letter: 'R', word: f.origPath ? `Renamed from ${f.origPath}` : 'Renamed' }
    case 'C': return { kind: 'renamed', letter: 'C', word: f.origPath ? `Copied from ${f.origPath}` : 'Copied' }
    default: return { kind: 'modified', letter: code ?? 'M', word: 'Modified' }
  }
})

const parts = computed(() => {
  const path = props.file.path.replace(/\/+$/, '')
  const cut = path.lastIndexOf('/')
  return { name: path.slice(cut + 1), dir: cut > 0 ? path.slice(0, cut) : '' }
})

const removes = computed(() => state.value.kind === 'untracked')

/** Someone else holds the file: checking in this change will be refused until they let go. */
const blocked = computed(() => !!props.lock && !props.lock.mine)
const lockText = computed(() => (props.lock ? lockSummary(props.lock) : ''))

const menuRef = ref<{ showAt: (x: number, y: number) => void } | null>(null)
function openMenu(e: MouseEvent) {
  if (!props.menu?.length) return
  e.preventDefault()
  menuRef.value?.showAt(e.clientX, e.clientY)
}
/** The context-menu key or Shift+F10 on the focused row opens the menu under it. */
function onMainKey(e: KeyboardEvent) {
  if (!props.menu?.length || !(e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) return
  e.preventDefault()
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  menuRef.value?.showAt(r.left + 24, r.bottom)
}
const diffId = useId()

/* Leaving the question unanswered withdraws it: a click elsewhere, Tab away, or Escape. */
const confirmBox = ref<HTMLElement | null>(null)
const confirmBtn = ref<HTMLButtonElement | null>(null)
function onOutsidePress(e: MouseEvent) {
  if (!confirmBox.value?.contains(e.target as Node)) emit('cancel')
}
function onConfirmBlur(e: FocusEvent) {
  // No related target means the press landed on something unfocusable (or, in
  // WebKit, on one of our own buttons): the press handler decides that case.
  const next = e.relatedTarget as Node | null
  if (next && !confirmBox.value?.contains(next)) emit('cancel')
}
watch(() => props.confirming, async (on) => {
  document.removeEventListener('mousedown', onOutsidePress, true)
  if (!on) return
  document.addEventListener('mousedown', onOutsidePress, true)
  await nextTick()
  confirmBtn.value?.focus()
})
onBeforeUnmount(() => document.removeEventListener('mousedown', onOutsidePress, true))
</script>

<template>
  <li class="gf" :class="[`gf--${state.kind}`, { 'is-open': expanded, 'is-confirming': confirming }]">
    <div class="gf__row" @contextmenu="openMenu">
      <button
        type="button"
        class="gf__main"
        :aria-current="expanded ? 'true' : undefined"
        :aria-haspopup="menu?.length ? 'menu' : undefined"
        :title="`${file.path} · ${state.word}${lock ? `\n${lockText}` : ''}\nOpens the diff`"
        @click="emit('toggle')"
        @keydown="onMainKey"
      >
        <span class="gf__chip" aria-hidden="true">{{ state.letter }}</span>
        <span class="gf__name">{{ parts.name }}</span>
        <span v-if="parts.dir" class="gf__dir"><bdi>{{ parts.dir }}</bdi></span>
        <span v-if="lock" class="gf__lock" :class="{ 'is-mine': lock.mine, 'is-blocked': blocked }" aria-hidden="true">
          <Lock /><span v-if="blocked" class="gf__holder">{{ lockHolder(lock) }}</span>
        </span>
        <span class="sr-only">{{ state.word }}<template v-if="lock">. {{ lockText }}</template></span>
      </button>

      <div v-if="confirming" ref="confirmBox" class="gf__confirm" @focusout="onConfirmBlur" @keydown.esc.stop.prevent="emit('cancel')">
        <span class="gf__ask">{{ removes ? 'Delete?' : 'Discard?' }}</span>
        <button ref="confirmBtn" type="button" class="gf__yes" :disabled="disabled" @click="emit('discard')">
          {{ removes ? 'Delete file' : 'Discard' }}
        </button>
        <UiIconButton size="sm" label="Keep changes" @click="emit('cancel')"><X /></UiIconButton>
      </div>
      <div v-else class="gf__actions">
        <template v-if="staged">
          <UiIconButton size="sm" :label="`Unstage ${parts.name}`" :disabled="disabled" @click="emit('unstage')"><Minus /></UiIconButton>
        </template>
        <template v-else>
          <UiIconButton
            v-if="!file.conflicted"
            size="sm"
            :label="removes ? `Delete ${parts.name}` : `Discard changes to ${parts.name}`"
            :disabled="disabled"
            @click="emit('ask')"
          >
            <Undo2 />
          </UiIconButton>
          <UiIconButton
            size="sm"
            :label="file.conflicted ? `Mark ${parts.name} as resolved and stage it` : `Stage ${parts.name}`"
            :disabled="disabled"
            @click="emit('stage')"
          >
            <Plus />
          </UiIconButton>
        </template>
      </div>
    </div>
    <UiMenu v-if="menu?.length" ref="menuRef" :items="menu" :width="232" :label="`${parts.name} actions`" />
  </li>
</template>

<style scoped>
/* A grid, so the context menu's empty anchor adds no line box under the row. */
/* The row's height is a variable so the Changes list can fold a row to nothing and back (GitPanel). */
.gf { --gf-row-h: 28px; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); }
.gf__row {
  display: flex;
  align-items: center;
  gap: 2px;
  height: var(--gf-row-h);
  padding-right: 3px;
  border-radius: var(--radius-sm);
  transition: background var(--dur-fast) var(--ease-out);
}
/* Keyboard focus counts as hover; a mouse click leaving focus behind does not. */
.gf__row:hover, .gf__row:has(:focus-visible) { background: var(--bg-hover); }
.gf.is-open > .gf__row, .gf.is-confirming > .gf__row { background: var(--bg-active); }

.gf__main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 100%;
  padding: 0 var(--space-1);
  border-radius: var(--radius-sm);
  text-align: left;
  font-size: var(--text-sm);
}
.gf__main:focus-visible { outline-offset: -2px; border-radius: var(--radius-sm); }

.gf__chip {
  flex: none;
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-xs);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: 650;
  line-height: 1;
  color: var(--chip);
  background: color-mix(in oklch, var(--chip) 14%, transparent);
}
.gf--modified, .gf--renamed { --chip: var(--accent-ink); }
.gf--added { --chip: var(--diff-add-fg); }
.gf--deleted { --chip: var(--diff-del-fg); }
.gf--untracked { --chip: var(--ripe-queued-fg); }
.gf--conflict { --chip: var(--ripe-error-fg); }

.gf__name {
  flex: 0 1 auto;
  min-width: 0;
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gf--deleted .gf__name { color: var(--fg-subtle); text-decoration: line-through; text-decoration-color: var(--fg-faint); }
/* Truncates from the left so the nearest folder stays readable. */
.gf__dir {
  flex: 1 1 0;
  min-width: 0;
  direction: rtl;
  text-align: left;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--fg-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Lock mark: mine in mango ink; someone else's in blush (it needs a word with them), with who holds it. */
.gf__lock {
  flex: 0 1 auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  max-width: 45%;
  min-width: 0;
  color: var(--fg-subtle);
}
.gf__lock svg { width: 12px; height: 12px; flex: none; stroke-width: 1.85; }
.gf__lock.is-mine { color: var(--accent-ink); }
.gf__lock.is-blocked { color: var(--ripe-waiting-fg); }
.gf__holder {
  min-width: 0;
  font-size: var(--text-2xs);
  font-weight: 560;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* The row's actions need the room while they show; the tooltip still names the holder. */
.gf__row:hover .gf__holder, .gf__row:has(:focus-visible) .gf__holder { display: none; }

.gf__actions { flex: none; display: none; align-items: center; gap: 1px; }
.gf__row:hover .gf__actions, .gf__row:has(:focus-visible) .gf__actions { display: flex; }

.gf__confirm { flex: none; display: flex; align-items: center; gap: var(--space-1); }
.gf__ask { padding: 0 2px 0 var(--space-1); font-size: var(--text-xs); font-weight: 560; color: var(--fg-muted); white-space: nowrap; }
.gf__yes {
  height: 22px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-xs);
  border: 1px solid color-mix(in oklch, var(--ripe-error) 45%, transparent);
  font-size: var(--text-xs);
  font-weight: 560;
  color: var(--ripe-error-fg);
  white-space: nowrap;
  transition: background var(--dur-fast) var(--ease-out);
}
.gf__yes:hover:not(:disabled) { background: color-mix(in oklch, var(--ripe-error) 14%, transparent); }
.gf__yes:disabled { opacity: 0.55; }
</style>
