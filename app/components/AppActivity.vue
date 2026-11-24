<script setup lang="ts">
import { AGENTS, waitingFor, type Thread } from '~/types/chat'
import { useThreads } from '~/stores/threads'
import { useWorkspace } from '~/stores/workspace'
import { useOverlay } from '~/composables/useOverlay'
import { shortAgo, useNow } from '~/utils/time'
import { baseName } from '~/utils/paths'

/*
 * Titlebar widget: how many chats run and how many need you. It opens a list of both, and a click on
 * a row opens that chat.
 */
const { t } = useI18n()
const ws = useWorkspace()
const threads = useThreads()
const now = useNow(30_000)

const MAX_ROWS = 6

/** Chats the widget counts: top-level ones only. Sub-agent chats belong to their parent's run. */
const listed = computed(() => threads.threads.filter(t => !t.archived && !t.parentId))
/** Waiting on the person (an approval or an answer). Finished chats are done, not waiting. */
const needs = computed(() => listed.value.filter(t => t.status === 'waiting'))
/** A run is active right now (queued runs are about to start). */
const running = computed(() => listed.value.filter(t => t.status === 'running' || t.status === 'queued'))

const needsShown = computed(() => needs.value.slice(0, MAX_ROWS))
const runningShown = computed(() => running.value.slice(0, MAX_ROWS))
/** Rows in keyboard order. */
const rows = computed(() => [...needsShown.value, ...runningShown.value])
const visible = computed(() => needs.value.length + running.value.length > 0)

function projectName(t: Thread) {
  return ws.openProjects.find(p => p.path === t.projectPath)?.name ?? baseName(t.projectPath)
}
function subtitle(chat: Thread) {
  const agent = AGENTS[chat.agent].name
  const what = chat.status === 'waiting' ? t(waitingFor(chat) === 'answer' ? 'shell.chat.needsAnswer' : 'shell.chat.needsApproval') : chat.status === 'running' ? t('shell.chat.working') : t('shell.chat.starting')
  const where = chat.projectPath !== ws.activeProjectPath ? projectName(chat) : agent
  return `${what} · ${where}`
}
const ago = (t: Thread) => shortAgo(t.updatedAt, now.value)

/* ---------- popover ---------- */
const open = ref(false)
const btn = ref<HTMLButtonElement | null>(null)
const pop = ref<HTMLElement | null>(null)
const focused = ref(0)
const pos = reactive({ top: 0, right: 0 })
useOverlay(() => open.value)

function place() {
  const r = btn.value?.getBoundingClientRect()
  if (!r) return
  pos.top = r.bottom + 6
  pos.right = Math.max(8, window.innerWidth - r.right)
}
function show() {
  place()
  focused.value = 0
  open.value = true
  nextTick(() => pop.value?.focus())
}
function close(refocus = false) {
  open.value = false
  if (refocus) btn.value?.focus()
}
function toggle() { open.value ? close() : show() }

function openChat(t: Thread) {
  close()
  if (t.projectPath !== ws.activeProjectPath) ws.setActiveProject(t.projectPath)
  threads.show(t.id)
}

function onKey(e: KeyboardEvent) {
  const n = rows.value.length
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true) }
  else if (e.key === 'ArrowDown') { e.preventDefault(); if (n) focused.value = (focused.value + 1) % n }
  else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) focused.value = (focused.value - 1 + n) % n }
  else if (e.key === 'Enter') { e.preventDefault(); const t = rows.value[focused.value]; if (t) openChat(t) }
  else if (e.key === 'Tab') close()
}
function onOutside(e: PointerEvent) {
  const el = e.target as Node
  if (pop.value?.contains(el) || btn.value?.contains(el)) return
  close()
}
watch(open, (v) => {
  if (v) {
    document.addEventListener('pointerdown', onOutside, true)
    window.addEventListener('resize', place)
  } else {
    document.removeEventListener('pointerdown', onOutside, true)
    window.removeEventListener('resize', place)
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onOutside, true)
  window.removeEventListener('resize', place)
})
// Nothing left to show: close the list.
watch(visible, (v) => { if (!v) close() })
watch(() => rows.value.length, (n) => { if (focused.value >= n) focused.value = Math.max(0, n - 1) })

const rowId = (t: Thread) => `act-${t.id}`
const label = computed(() => {
  const parts: string[] = []
  if (running.value.length) parts.push(t('shell.activity.runningCount', running.value.length))
  if (needs.value.length) parts.push(t('shell.activity.needCount', needs.value.length))
  return t('shell.activity.label', { what: parts.join(', ') })
})
</script>

<template>
  <button
    v-if="visible"
    ref="btn"
    type="button"
    class="act"
    :class="{ 'is-open': open }"
    :title="open ? undefined : label"
    :aria-label="label"
    aria-haspopup="dialog"
    :aria-expanded="open"
    @click="toggle"
  >
    <span v-if="running.length" class="act__seg">
      <UiRipenessDot status="working" :size="11" />
      <b class="tabular">{{ running.length }}</b>
      <span class="act__lbl">{{ t('shell.activity.running') }}</span>
    </span>
    <span v-if="needs.length" class="act__seg act__seg--need">
      <UiRipenessDot status="waiting" :size="11" />
      <b class="tabular">{{ needs.length }}</b>
      <span class="act__lbl">{{ t('shell.activity.need') }}</span>
    </span>
  </button>

  <Teleport to="body">
    <div
      v-if="open"
      ref="pop"
      class="actpop"
      role="dialog"
      :aria-label="t('shell.activity.title')"
      tabindex="-1"
      :aria-activedescendant="rows[focused] ? rowId(rows[focused]!) : undefined"
      :style="{ top: `${pos.top}px`, right: `${pos.right}px` }"
      @keydown="onKey"
    >
      <template v-if="needs.length">
        <h3 class="actpop__h"><UiRipenessDot status="waiting" :size="11" />{{ t('shell.activity.needsHead', { n: needs.length }) }}</h3>
        <button
          v-for="(chat, i) in needsShown"
          :id="rowId(chat)"
          :key="chat.id"
          type="button"
          class="actpop__row"
          :class="{ 'is-focus': focused === i }"
          tabindex="-1"
          @mousemove="focused = i"
          @click="openChat(chat)"
        >
          <UiRipenessDot :status="chat.status === 'waiting' ? 'waiting' : 'done'" :size="11" />
          <span class="actpop__tx"><b>{{ chatTitle(chat.title) }}</b><span>{{ subtitle(chat) }}</span></span>
          <em class="tabular">{{ ago(chat) }}</em>
        </button>
        <p v-if="needs.length > MAX_ROWS" class="actpop__more">{{ t('shell.activity.more', { n: needs.length - MAX_ROWS }) }}</p>
      </template>
      <template v-if="running.length">
        <h3 class="actpop__h" :class="{ 'actpop__h--gap': needs.length }"><UiRipenessDot status="working" :size="11" />{{ t('shell.activity.runningHead', { n: running.length }) }}</h3>
        <button
          v-for="(chat, i) in runningShown"
          :id="rowId(chat)"
          :key="chat.id"
          type="button"
          class="actpop__row"
          :class="{ 'is-focus': focused === needsShown.length + i }"
          tabindex="-1"
          @mousemove="focused = needsShown.length + i"
          @click="openChat(chat)"
        >
          <UiRipenessDot status="working" :size="11" />
          <span class="actpop__tx"><b>{{ chatTitle(chat.title) }}</b><span>{{ subtitle(chat) }}</span></span>
          <em class="tabular">{{ ago(chat) }}</em>
        </button>
        <p v-if="running.length > MAX_ROWS" class="actpop__more">{{ t('shell.activity.more', { n: running.length - MAX_ROWS }) }}</p>
      </template>
      <div class="actpop__ft">
        <span><kbd>↑</kbd> <kbd>↓</kbd> {{ t('shell.activity.move') }}</span>
        <span><kbd>Enter</kbd> {{ t('shell.activity.open') }}</span>
        <span><kbd>Esc</kbd> {{ t('shell.activity.close') }}</span>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.act {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  height: 28px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-md);
  font-size: var(--text-xs);
  color: var(--fg-muted);
  white-space: nowrap;
  transition: background var(--dur-fast) var(--ease-out);
}
.act:hover, .act.is-open { background: var(--bg-hover); }
.act__seg { display: inline-flex; align-items: center; gap: 6px; }
.act__seg b { font-weight: 600; color: var(--fg); }
.act__seg--need b { color: var(--ripe-waiting-fg); }
@media (max-width: 1179px) { .act__lbl { display: none; } }

.actpop {
  position: fixed;
  z-index: 60;
  width: 332px;
  max-width: calc(100vw - 16px);
  padding: var(--space-2);
  background: var(--bg-raised);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-pop);
  outline: none;
}
.actpop__h {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: var(--space-2) var(--space-2) var(--space-1);
  font-size: var(--text-xs);
  font-weight: 500;
  color: var(--fg-subtle);
}
.actpop__h--gap { margin-top: var(--space-1); }
.actpop__row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  height: 44px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-md);
  text-align: left;
}
.actpop__row:hover, .actpop__row.is-focus { background: var(--bg-hover); }
.actpop__tx { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.3; }
.actpop__tx b { font-weight: 500; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.actpop__tx span { font-size: var(--text-xs); color: var(--fg-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.actpop__row em { font-style: normal; font-size: var(--text-2xs); color: var(--fg-subtle); flex: none; }
.actpop__more { margin: 0; padding: var(--space-1) var(--space-2); font-size: var(--text-xs); color: var(--fg-subtle); }
.actpop__ft {
  display: flex;
  gap: var(--space-4);
  margin: var(--space-2) calc(var(--space-2) * -1) 0;
  padding: var(--space-2) var(--space-4) 0;
  border-top: 1px solid var(--line);
  font-size: var(--text-xs);
  color: var(--fg-subtle);
}
</style>
