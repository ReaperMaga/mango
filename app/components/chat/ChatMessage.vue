<script setup lang="ts">
import { Check, CircleAlert, Copy, FileText, GitBranch, Pencil, Pin, RefreshCw } from 'lucide-vue-next'
import type { Message, Part, Thread } from '~/types/chat'
import { formatDuration } from '~/utils/time'
import { noticeText } from '~/utils/chatTexts'
import { formatLocale } from '~/i18n'
import { formatCost, formatTokens } from '~/agents/context'
import { copyText } from '~/utils/clipboard'
import { formatSize } from '~/utils/attachments'
import { openImage } from '~/utils/imageViewer'
import { AGENTS } from '~/types/chat'
import { useThreads } from '~/stores/threads'
import { createdBy } from '~/utils/githubLinks'
import { useWorkspace } from '~/stores/workspace'
import { guarded, reg as pluginReg, shown } from '~/plugin-host/registry'
import PluginIcon from '~/plugin-host/ui/PluginIcon.vue'
import type { MessageActionContext } from '~/plugin-host/types'

const props = defineProps<{ message: Message; thread: Thread; last: boolean }>()
const { t } = useI18n()
const threads = useThreads()
const ws = useWorkspace()

/** Still being written. Not while the run only waits on background tasks: this answer is complete. */
const live = computed(() => props.last && ['running', 'queued', 'waiting'].includes(props.thread.status) && !threads.live[props.thread.id]?.idle)
function viewAttachment(id: string) {
  const images = (props.message.attachments ?? []).filter(a => a.thumb)
  openImage(images, images.findIndex(a => a.id === id))
}

type Step = Extract<Part, { type: 'thinking' } | { type: 'tool' }>
type Segment =
  | { kind: 'part'; key: string; part: Part; i: number }
  | { kind: 'steps'; key: string; steps: Step[]; end: number }

/**
 * A delegated task stays on its own row, so its link to the sub-agent's chat is never folded away;
 * so does a call that opened a pull request or issue, with its link to the Pull requests tool window.
 */
const isStep = (p: Part): p is Step =>
  p.type === 'thinking' || (p.type === 'tool' && !p.childId && !createdBy(p).length)

/** Runs of two or more thinking/tool rows fold into one ChatSteps; everything else renders on its own. */
const segments = computed<Segment[]>(() => {
  const parts = props.message.parts
  // Which rows Settings > Behaviour shows. Approvals, questions and errors always show.
  const mode = ws.toolCalls
  const lastText = parts.map(p => p.type).lastIndexOf('text')
  const shown = parts.map((p, i) => i).filter((i) => {
    const p = parts[i]!
    if (mode === 'zen') return p.type === 'approval' || p.type === 'question' || p.type === 'notice' || i === lastText
    if (p.type === 'tool' && !p.childId && !createdBy(p).length) {
      if (mode === 'hide') return false
      if (mode === 'hide-ok') return p.status !== 'ok'
    }
    return true
  })
  const out: Segment[] = []
  for (let n = 0; n < shown.length;) {
    let last = n
    while (isStep(parts[shown[n]!]!) && last + 1 < shown.length && isStep(parts[shown[last + 1]!]!)) last++
    const i = shown[n]!
    if (last > n) {
      const steps = shown.slice(n, last + 1).map(k => parts[k]) as Step[]
      out.push({ kind: 'steps', key: `s:${steps[0]!.id ?? i}`, steps, end: shown[last]! })
    } else {
      const part = parts[i]!
      out.push({ kind: 'part', key: `p:${('id' in part && part.id) || i}`, part, i })
    }
    n = last + 1
  }
  return out
})

const clock = computed(() => new Date(props.message.createdAt).toLocaleTimeString(formatLocale(), { hour: '2-digit', minute: '2-digit' }))
const sentAt = computed(() => new Date(props.message.createdAt).toLocaleString(formatLocale()))
const plainText = computed(() => props.message.parts.flatMap(p => (p.type === 'text' ? [p.text] : [])).join('\n\n'))

/** Plugins' hover actions for this message (`chat.messageActions`). */
const actionCtx = computed<MessageActionContext>(() => ({
  threadId: props.thread.id,
  messageId: props.message.id,
  role: props.message.role === 'user' ? 'user' : 'assistant',
  text: plainText.value,
}))
const pluginActions = computed(() => pluginReg.messageActions.filter(a => shown(a, actionCtx.value)))
function runAction(a: (typeof pluginActions.value)[number]) {
  const ctx = { ...actionCtx.value }
  void guarded(a.pluginId, `message action ${a.id}`, () => a.run(ctx))
}

const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined
async function copy() {
  if (!(await copyText(plainText.value))) return
  copied.value = true
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => (copied.value = false), 1600)
}
onBeforeUnmount(() => clearTimeout(copiedTimer))

const busy = computed(() => ['running', 'queued', 'waiting'].includes(props.thread.status))
/** A sub-agent's chat is written by its parent's run only: nothing to edit or ask again there. */
const writable = computed(() => !props.thread.parentId && !props.message.fromAgent)
/** Messages (this one included) that editing or asking again here would remove. */
const cuts = computed(() => threads.cutCount(props.thread.id, props.message.id))
const sentTitle = computed(() => (props.message.writtenAt
  ? t('chat.message.written', { written: new Date(props.message.writtenAt).toLocaleTimeString(formatLocale()), sent: new Date(props.message.createdAt).toLocaleTimeString(formatLocale()) })
  : sentAt.value))

/* Editing: the bubble turns into a field; saving cuts the chat back to here and runs it again. */
const editing = ref(false)
const draft = ref('')
const field = ref<HTMLTextAreaElement | null>(null)
async function startEdit() {
  draft.value = plainText.value
  editing.value = true
  await nextTick()
  field.value?.focus()
  field.value?.setSelectionRange(draft.value.length, draft.value.length)
}
function saveEdit() {
  if (!draft.value.trim() && !props.message.attachments?.length) return
  editing.value = false
  void threads.editMessage(props.thread.id, props.message.id, draft.value)
}
function onEditKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); editing.value = false }
  else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); saveEdit() }
}
watch(busy, (b) => { if (b) editing.value = false })

/* Asking again removes what follows: with more than this exchange after it, the button asks twice. */
const confirmAgain = ref(false)
let confirmTimer: ReturnType<typeof setTimeout> | undefined
function again() {
  if (cuts.value > 2 && !confirmAgain.value) {
    confirmAgain.value = true
    clearTimeout(confirmTimer)
    confirmTimer = setTimeout(() => (confirmAgain.value = false), 4000)
    return
  }
  confirmAgain.value = false
  void threads.regenerate(props.thread.id, props.message.id)
}
onBeforeUnmount(() => clearTimeout(confirmTimer))

const usageLine = computed(() => {
  const u = props.message.usage
  if (!u) return ''
  return [t('chat.message.usage', { input: formatTokens(u.input), output: formatTokens(u.output) }), ...(u.costUsd !== undefined ? [formatCost(u.costUsd)] : [])].join(' · ')
})

const lastTextIndex = computed(() => {
  for (let i = props.message.parts.length - 1; i >= 0; i--) if (props.message.parts[i]!.type === 'text') return i
  return -1
})
</script>

<template>
  <article v-if="message.role === 'user'" class="msg msg--user" :data-message-id="message.id">
    <p v-if="message.fromAgent" class="msg__from">{{ t('chat.message.taskFrom', { agent: AGENTS[thread.agent].name }) }}</p>
    <ul v-if="message.attachments?.length" class="msg__files" :aria-label="t('chat.attachments')">
      <li
        v-for="a in message.attachments"
        :key="a.id"
        class="msg__file"
        :class="{ 'msg__file--image': a.thumb }"
        :title="`${a.name} · ${formatSize(a.size)}
${a.path}`"
      >
        <button v-if="a.thumb" type="button" class="msg__thumb-btn" :aria-label="t('chat.view', { name: a.name })" @click="viewAttachment(a.id)">
          <img class="msg__thumb" :src="a.thumb" alt="">
        </button>
        <template v-else>
          <FileText class="msg__file-icon" aria-hidden="true" />
          <span class="msg__file-meta">
            <span class="msg__file-name">{{ a.name }}</span>
            <span class="msg__file-size tabular">{{ formatSize(a.size) }}</span>
          </span>
        </template>
      </li>
    </ul>
    <form v-if="editing" class="msg__edit" @submit.prevent="saveEdit">
      <textarea
        ref="field"
        v-model="draft"
        class="msg__edit-field"
        rows="3"
        :aria-label="t('chat.message.edit')"
        @keydown="onEditKey"
      />
      <p v-if="cuts > 1" class="msg__edit-note">{{ t('chat.message.replaces', { n: cuts - 1 }) }}</p>
      <div class="msg__edit-actions">
        <UiButton size="sm" variant="ghost" type="button" @click="editing = false">{{ t('common.actions.cancel') }}</UiButton>
        <UiButton size="sm" variant="primary" type="submit" :disabled="!draft.trim() && !message.attachments?.length">{{ t('chat.message.sendAgain') }}</UiButton>
      </div>
    </form>
    <div v-else-if="message.parts.length" class="msg__bubble selectable">
      <template v-for="(p, i) in message.parts" :key="i">
        <p v-if="p.type === 'text'" class="msg__user-text">{{ p.text }}</p>
      </template>
    </div>
    <div v-if="message.parts.length && !editing" class="msg__meta msg__meta--user">
      <time class="msg__time tabular" :datetime="new Date(message.createdAt).toISOString()" :title="sentTitle">{{ clock }}</time>
      <UiIconButton v-if="plainText" size="sm" :label="copied ? t('common.actions.copied') : t('chat.message.copy')" @click="copy">
        <Check v-if="copied" /><Copy v-else />
      </UiIconButton>
      <UiIconButton v-if="writable" size="sm" class="msg__pin" :class="{ 'msg__pin--on': message.pinned }" :label="message.pinned ? t('chat.message.unpin') : t('chat.message.pin')" :active="!!message.pinned" @click="threads.togglePin(thread.id, message.id)">
        <Pin />
      </UiIconButton>
      <UiIconButton v-if="writable && !busy" size="sm" :label="t('chat.message.editAgain')" @click="startEdit">
        <Pencil />
      </UiIconButton>
      <UiIconButton v-if="writable" size="sm" :label="t('chat.message.branch')" @click="threads.branchFrom(thread.id, message.id)">
        <GitBranch />
      </UiIconButton>
      <UiIconButton v-for="a in pluginActions" :key="a.fullId" size="sm" :label="a.label" @click="runAction(a)">
        <PluginIcon :icon="a.icon" />
      </UiIconButton>
    </div>
  </article>

  <article v-else class="msg msg--agent" :data-message-id="message.id">
    <template v-for="seg in segments" :key="seg.key">
      <ChatSteps
        v-if="seg.kind === 'steps'"
        :steps="seg.steps"
        :live="live && seg.end === message.parts.length - 1"
      />
      <template v-else>
        <ChatThinking
          v-if="seg.part.type === 'thinking'"
          :text="seg.part.text"
          :seconds="seg.part.seconds"
          :live="live && seg.part.seconds === 0"
        />
        <ChatTool v-else-if="seg.part.type === 'tool'" :part="seg.part" />
        <ChatApproval
          v-else-if="seg.part.type === 'approval'"
          :part="seg.part"
          :agent-name="AGENTS[thread.agent].name"
          @resolve="allow => threads.resolveApproval(thread.id, message.id, seg.i, allow)"
        />
        <ChatQuestion
          v-else-if="seg.part.type === 'question'"
          :part="seg.part"
          :agent-name="AGENTS[thread.agent].name"
          @answer="answers => threads.answerQuestion(thread.id, message.id, seg.i, answers)"
        />
        <p v-else-if="seg.part.type === 'notice'" class="msg__notice" :class="`msg__notice--${seg.part.level}`" :role="seg.part.level === 'error' ? 'alert' : undefined">
          <CircleAlert v-if="seg.part.level === 'error'" />
          <span class="selectable">{{ noticeText(seg.part.text) }}</span>
        </p>
        <ChatMarkdown
          v-else-if="seg.part.type === 'text'"
          class="msg__text"
          :text="seg.part.text"
          :base="thread.projectPath"
          :thread-id="thread.id"
          :streaming="live && seg.i === lastTextIndex && seg.i === message.parts.length - 1"
        />
      </template>
    </template>
    <ChatChanges v-if="!live" :message="message" :thread="thread" />
    <p v-if="message.elapsedMs !== undefined && !live" class="msg__ran tabular">
      {{ t(message.outcome === 'stopped' ? 'chat.message.stoppedAfter' : message.outcome === 'error' ? 'chat.message.failedAfter' : 'chat.message.workedFor', { time: formatDuration(message.elapsedMs) }) }}<template v-if="usageLine"> · {{ usageLine }}</template>
    </p>
    <div v-if="!live" class="msg__meta">
      <time class="msg__time tabular" :datetime="new Date(message.createdAt).toISOString()" :title="sentTitle">{{ clock }}</time>
      <UiIconButton v-if="plainText" size="sm" :label="copied ? t('common.actions.copied') : t('chat.message.copy')" @click="copy">
        <Check v-if="copied" /><Copy v-else />
      </UiIconButton>
      <UiIconButton v-if="writable" size="sm" class="msg__pin" :class="{ 'msg__pin--on': message.pinned }" :label="message.pinned ? t('chat.message.unpin') : t('chat.message.pin')" :active="!!message.pinned" @click="threads.togglePin(thread.id, message.id)">
        <Pin />
      </UiIconButton>
      <UiIconButton v-if="writable && !busy && !message.idle" size="sm" class="msg__again" :class="{ 'msg__again--ask': confirmAgain }" :label="confirmAgain ? t('chat.message.againConfirm', cuts - 1) : t('chat.message.again')" @click="again">
        <RefreshCw />
      </UiIconButton>
      <UiIconButton v-if="writable" size="sm" :label="t('chat.message.branch')" @click="threads.branchFrom(thread.id, message.id)">
        <GitBranch />
      </UiIconButton>
      <UiIconButton v-for="a in pluginActions" :key="a.fullId" size="sm" :label="a.label" @click="runAction(a)">
        <PluginIcon :icon="a.icon" />
      </UiIconButton>
    </div>
  </article>
</template>

<style scoped>
.msg { display: flex; flex-direction: column; gap: 2px; }
.msg--user { align-items: flex-end; }
.msg__bubble {
  max-width: min(88%, 620px);
  padding: 10px 14px;
  border-radius: var(--radius-lg);
  border-bottom-right-radius: var(--radius-xs);
  background: var(--bg-panel);
  border: 1px solid var(--line-soft);
}
.msg__files {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
  max-width: min(88%, 620px);
  margin: 0 0 var(--space-1);
  padding: 0;
  list-style: none;
}
.msg__file {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 44px;
  max-width: 240px;
  padding: 0 var(--space-3) 0 10px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
}
.msg__file--image {
  height: auto;
  max-width: none;
  padding: 0;
  overflow: hidden;
  background: var(--bg-inset);
}
.msg__thumb-btn { display: block; padding: 0; cursor: zoom-in; }
.msg__thumb-btn:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; border-radius: var(--radius-md); }
.msg__thumb { display: block; max-width: 200px; max-height: 140px; object-fit: contain; }
.msg__file-icon { flex: none; width: 18px; height: 18px; stroke-width: 1.75; color: var(--fg-subtle); }
.msg__file-meta { display: flex; flex-direction: column; min-width: 0; line-height: var(--leading-tight); }
.msg__file-name { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: var(--text-xs); font-weight: 540; color: var(--fg); }
.msg__file-size { font-size: var(--text-2xs); color: var(--fg-subtle); }
.msg__from { margin: 0 0 2px; font-size: var(--text-xs); color: var(--fg-faint); }
.msg__user-text { margin: 0; white-space: pre-wrap; line-height: var(--leading-chat); overflow-wrap: anywhere; }
.msg__text { margin: 6px 0 2px; }
.msg__meta {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-top: 2px;
  font-size: var(--text-xs);
  color: var(--fg-faint);
}
.msg__meta--user { justify-content: flex-end; }
.msg__meta :deep(.icon-btn) { opacity: 0; }
.msg:hover .msg__meta :deep(.icon-btn),
.msg:focus-within .msg__meta :deep(.icon-btn),
.msg__meta :deep(.icon-btn:focus-visible),
.msg__meta :deep(.msg__pin--on),
.msg__meta :deep(.msg__again--ask) { opacity: 1; }
.msg__meta :deep(.msg__again--ask) { color: var(--ripe-error-fg); }

/* Editing one of your messages in place. */
.msg__edit {
  width: min(88%, 620px);
  display: grid;
  gap: var(--space-2);
  padding: var(--space-2);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-lg);
  background: var(--bg-panel);
}
.msg__edit-field {
  width: 100%;
  min-height: 72px;
  max-height: 320px;
  padding: var(--space-1) var(--space-2);
  resize: vertical;
  border: 0;
  outline: 0;
  background: none;
  color: var(--fg);
  font: inherit;
  line-height: var(--leading-chat);
}
.msg__edit-note { margin: 0 var(--space-2); font-size: var(--text-xs); color: var(--fg-subtle); }
.msg__edit-actions { display: flex; justify-content: flex-end; gap: var(--space-2); }

/* Where a jump from the message list or a find lands: a brief wash, then gone. */
.msg.is-flash { animation: msg-flash 1400ms var(--ease-out); }
@keyframes msg-flash {
  0%, 40% { background: var(--bg-active); }
  100% { background: transparent; }
}
@media (prefers-reduced-motion: reduce) { .msg.is-flash { animation: none; } }
.msg__ran { margin: var(--space-2) 0 0; font-size: var(--text-xs); color: var(--fg-faint); }
.msg__notice {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 6px 0 0;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--fg-subtle);
}
.msg__notice svg { width: 15px; height: 15px; flex: none; margin-top: 2px; }
.msg__notice--error { color: var(--ripe-error-fg); }
</style>
