<script setup lang="ts">
import { Ban, Check, MessageCircleQuestion } from 'lucide-vue-next'
import type { AgentQuestion, Part, QuestionAnswers } from '~/types/chat'
import { askTitle } from '~/utils/chatTexts'

/**
 * Questions for the user, from the agent (Claude Code's AskUserQuestion, Codex's
 * request_user_input) or from an MCP server through it (an elicitation form). While pending: each
 * question with its options (one, or several when it allows) and, where an answer may be typed,
 * an "Other" field (or only a field, when there are no options); then Answer or Dismiss.
 * Settled: what was answered, in one quiet block.
 */
type QuestionPart = Extract<Part, { type: 'question' }>
const props = defineProps<{ part: QuestionPart; agentName: string }>()
const emit = defineEmits<{ answer: [answers: QuestionAnswers | null] }>()

const { t } = useI18n()
const uid = useId()
const typed = (q: AgentQuestion) => q.freeText === true || !q.options.length
const isOption = (q: AgentQuestion, v: string) => q.options.some(o => o.label === v)

/** Picked option labels per question, and the typed text (counted while `other` is on, or always without options). */
const picked = reactive(props.part.questions.map((q) => {
  const preset = q.preset ?? []
  const labels = preset.filter(v => isOption(q, v))
  const text = preset.find(v => !isOption(q, v)) ?? ''
  return { labels, other: !!text && q.options.length > 0, text }
}))

function toggle(qi: number, label: string) {
  const q = props.part.questions[qi]!
  const p = picked[qi]!
  if (q.multiSelect) p.labels = p.labels.includes(label) ? p.labels.filter(l => l !== label) : [...p.labels, label]
  else { p.labels = [label]; p.other = false }
}
function pickOther(qi: number, on = true) {
  const p = picked[qi]!
  p.other = on
  if (on && !props.part.questions[qi]!.multiSelect) p.labels = []
}
function typeOther(qi: number, text: string) {
  picked[qi]!.text = text
  if (text.trim() && props.part.questions[qi]!.options.length) pickOther(qi)
}

const answerOf = (qi: number): string[] => {
  const q = props.part.questions[qi]!
  const p = picked[qi]!
  const own = (p.other || !q.options.length) ? p.text.trim() : ''
  return [...p.labels, ...(own ? [own] : [])]
}
/** Why a question's answer can't be sent yet; empty when it can. */
const problemOf = (qi: number): string => {
  const q = props.part.questions[qi]!
  const a = answerOf(qi)
  if (!a.length) return q.optional ? '' : 'needed'
  const own = (picked[qi]!.other || !q.options.length) ? picked[qi]!.text.trim() : ''
  if (own && q.format) {
    const n = Number(own)
    if (!Number.isFinite(n)) return t('chat.question.number')
    if (q.format === 'integer' && !Number.isInteger(n)) return t('chat.question.integer')
  }
  return ''
}
const ready = computed(() => props.part.questions.every((_, i) => !problemOf(i)))

function submit() {
  if (!ready.value) return
  emit('answer', props.part.questions.map((_, i) => answerOf(i)))
}

const title = computed(() => {
  if (props.part.title) return askTitle(props.part.title)
  return t('chat.question.has', { agent: props.agentName }, props.part.questions.length)
})
const shown = (qi: number) => {
  const a = props.part.answers?.[qi] ?? []
  return a.length ? a.join(', ') : t('chat.question.noAnswer')
}
</script>

<template>
  <form
    v-if="part.state === 'pending'"
    class="qa qa--pending"
    :aria-label="title"
    @submit.prevent="submit"
    @keydown.enter.ctrl.exact.prevent="submit"
    @keydown.enter.meta.exact.prevent="submit"
  >
    <div class="qa__head">
      <MessageCircleQuestion class="qa__icon" aria-hidden="true" />
      <span>{{ title }}</span>
    </div>
    <p v-if="part.message" class="qa__message selectable">{{ part.message }}</p>
    <fieldset v-for="(q, qi) in part.questions" :key="qi" class="qa__q">
      <legend class="qa__legend">
        <span v-if="q.header" class="qa__tag">{{ q.header }}</span>
        <span class="qa__text selectable">{{ q.question }}</span>
        <span v-if="q.multiSelect" class="qa__hint">{{ t('chat.question.pickAny') }}</span>
        <span v-else-if="q.optional" class="qa__hint">{{ t('chat.question.optional') }}</span>
      </legend>
      <p v-if="q.detail" class="qa__detail selectable">{{ q.detail }}</p>
      <div class="qa__options">
        <label
          v-for="(o, oi) in q.options"
          :key="oi"
          class="qa__opt"
          :class="{ 'is-on': picked[qi]!.labels.includes(o.label) }"
        >
          <input
            :type="q.multiSelect ? 'checkbox' : 'radio'"
            class="qa__input"
            :name="`${uid}-${qi}`"
            :checked="picked[qi]!.labels.includes(o.label)"
            @change="toggle(qi, o.label)"
          >
          <span class="qa__mark" :class="q.multiSelect ? 'is-box' : 'is-dot'" aria-hidden="true"><Check v-if="q.multiSelect" /></span>
          <span class="qa__copy">
            <span class="qa__label">{{ o.label }}</span>
            <span v-if="o.description" class="qa__desc">{{ o.description }}</span>
          </span>
        </label>
        <label v-if="typed(q) && q.options.length" class="qa__opt qa__opt--other" :class="{ 'is-on': picked[qi]!.other }">
          <input
            :type="q.multiSelect ? 'checkbox' : 'radio'"
            class="qa__input"
            :name="`${uid}-${qi}`"
            :checked="picked[qi]!.other"
            @change="pickOther(qi, q.multiSelect ? !picked[qi]!.other : true)"
          >
          <span class="qa__mark" :class="q.multiSelect ? 'is-box' : 'is-dot'" aria-hidden="true"><Check v-if="q.multiSelect" /></span>
          <input
            class="qa__field"
            :type="q.secret ? 'password' : 'text'"
            :value="picked[qi]!.text"
            :placeholder="q.placeholder ?? t('chat.question.other')"
            :aria-label="t('chat.question.ownAnswer', { question: q.question })"
            autocomplete="off"
            @input="typeOther(qi, ($event.target as HTMLInputElement).value)"
            @focus="picked[qi]!.text.trim() && pickOther(qi)"
            @keydown.enter.exact.prevent="submit"
          >
        </label>
        <input
          v-else-if="typed(q)"
          class="qa__text-field"
          :type="q.secret ? 'password' : 'text'"
          :inputmode="q.format ? 'decimal' : undefined"
          :value="picked[qi]!.text"
          :placeholder="q.placeholder ?? (q.format ? t('chat.question.aNumber') : t('chat.question.yourAnswer'))"
          :aria-label="q.question"
          :aria-invalid="!!picked[qi]!.text.trim() && !!problemOf(qi) || undefined"
          autocomplete="off"
          @input="typeOther(qi, ($event.target as HTMLInputElement).value)"
          @keydown.enter.exact.prevent="submit"
        >
      </div>
      <p v-if="picked[qi]!.text.trim() && problemOf(qi) && problemOf(qi) !== 'needed'" class="qa__problem" role="alert">{{ problemOf(qi) }}</p>
      <p v-if="q.secret" class="qa__note">{{ t('chat.question.secret') }}</p>
    </fieldset>
    <div class="qa__actions">
      <UiButton variant="primary" size="sm" type="submit" :disabled="!ready || undefined">{{ t('chat.question.answer') }}</UiButton>
      <UiButton variant="ghost" size="sm" @click="emit('answer', null)">{{ t('chat.question.dismiss') }}</UiButton>
    </div>
  </form>

  <div v-else-if="part.state === 'answered' && part.answers" class="qa-done" role="group" :aria-label="t('chat.question.answers')">
    <p class="qa-done__head"><Check aria-hidden="true" /><span>{{ part.title ? t('chat.question.answeredWho', { name: part.title.replace(/ asks$/, '') }) : t('chat.question.answered') }}</span></p>
    <dl class="qa-done__list selectable">
      <template v-for="(q, qi) in part.questions" :key="qi">
        <dt>{{ q.header || q.question }}</dt>
        <dd>{{ shown(qi) }}</dd>
      </template>
    </dl>
  </div>
  <p v-else class="qa-done qa-done--quiet">
    <Ban aria-hidden="true" />
    <span>{{ part.state === 'dismissed' ? t('chat.question.dismissed') : t('chat.notAnswered') }}</span>
  </p>
</template>

<style scoped>
.qa {
  margin: 6px 0;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid color-mix(in oklch, var(--ripe-waiting) 55%, transparent);
  background: color-mix(in oklch, var(--ripe-waiting) 7%, var(--bg-panel));
  box-shadow: var(--shadow-soft);
  font-size: var(--text-sm);
}
.qa__head { display: flex; align-items: center; gap: var(--space-2); font-weight: 580; color: var(--fg); }
.qa__icon { width: 15px; height: 15px; stroke-width: 1.85; color: var(--ripe-waiting); }

.qa__q { margin: var(--space-3) 0 0; padding: 0; border: 0; min-width: 0; }
.qa__legend { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; padding: 0; margin-bottom: var(--space-2); }
.qa__tag {
  flex: none;
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  background: var(--bg-hover);
  border: 1px solid var(--line-soft);
  font-size: var(--text-2xs);
  font-weight: 560;
  color: var(--fg-muted);
}
.qa__text { color: var(--fg); font-weight: 540; line-height: var(--leading-normal); }
.qa__hint { font-size: var(--text-xs); color: var(--fg-faint); }

.qa__options { display: grid; gap: var(--space-1); }
.qa__opt {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-height: 34px;
  padding: 7px 10px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.qa__opt:hover { background: var(--bg-raised); border-color: var(--line-strong); }
.qa__opt.is-on { border-color: var(--accent-line); background: color-mix(in oklch, var(--accent) 9%, var(--bg-panel)); }
.qa__opt:has(.qa__input:focus-visible) { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.qa__input { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; pointer-events: none; }
.qa__mark {
  flex: none;
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  margin-top: 2px;
  border: 1.5px solid var(--line-strong);
  background: var(--bg-inset);
  color: var(--accent-fg);
  transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.qa__mark.is-dot { border-radius: var(--radius-pill); }
.qa__mark.is-box { border-radius: var(--radius-xs); }
.qa__mark svg { width: 10px; height: 10px; stroke-width: 3; opacity: 0; }
.qa__opt.is-on .qa__mark { border-color: var(--accent); background: var(--accent); }
.qa__opt.is-on .qa__mark.is-dot { box-shadow: inset 0 0 0 3px var(--bg-panel); }
.qa__opt.is-on .qa__mark svg { opacity: 1; }
.qa__copy { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.qa__label { color: var(--fg); font-weight: 540; line-height: var(--leading-tight); }
.qa__desc { color: var(--fg-subtle); font-size: var(--text-xs); line-height: var(--leading-normal); }
.qa__opt--other { align-items: center; padding-block: 3px; cursor: text; }
.qa__opt--other .qa__mark { margin-top: 0; cursor: pointer; }
.qa__field {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--fg);
  outline: none;
}
.qa__field::placeholder { color: var(--fg-faint); }

.qa__message { margin: var(--space-2) 0 0; color: var(--fg-muted); line-height: var(--leading-normal); overflow-wrap: anywhere; white-space: pre-wrap; }
.qa__detail { margin: -4px 0 var(--space-2); font-size: var(--text-xs); color: var(--fg-subtle); line-height: var(--leading-normal); }
.qa__text-field {
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
  font: inherit;
  color: var(--fg);
  outline: none;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.qa__text-field::placeholder { color: var(--fg-faint); }
.qa__text-field:focus { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.qa__text-field[aria-invalid='true'] { border-color: color-mix(in oklch, var(--ripe-error) 60%, transparent); }
.qa__problem { margin: 4px 0 0; font-size: var(--text-xs); color: var(--ripe-error-fg); }
.qa__note { margin: 4px 0 0; font-size: var(--text-xs); color: var(--fg-faint); }

.qa__actions { display: flex; gap: var(--space-2); margin-top: var(--space-3); }

.qa-done { margin: 0 0 4px 24px; font-size: var(--text-xs); color: var(--fg-faint); }
.qa-done__head { display: flex; align-items: center; gap: 6px; margin: 0; }
.qa-done svg { width: 12px; height: 12px; stroke-width: 2; }
.qa-done__head svg { color: var(--ripe-queued-fg); }
.qa-done__list { display: grid; grid-template-columns: auto 1fr; gap: 2px var(--space-3); margin: 4px 0 0 18px; }
.qa-done__list dt { color: var(--fg-subtle); }
.qa-done__list dd { margin: 0; color: var(--fg-muted); overflow-wrap: anywhere; }
.qa-done--quiet { display: flex; align-items: center; gap: 6px; }
</style>
