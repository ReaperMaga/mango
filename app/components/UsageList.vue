<script setup lang="ts">
import { CircleAlert, RotateCcw } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'
import { useUsage } from '~/stores/usage'
import { AGENTS, type AgentId } from '~/types/chat'
import { formatLocale } from '~/i18n'
import { useNow } from '~/utils/time'
import { limitLabel } from '~/utils/usageSummary'

/**
 * Each agent's plan limits (the 5-hour and weekly windows, any per-model limit) and when each
 * starts over, as the CLI reports them. Shown in the Usage dialog and in Settings > Agents > Usage.
 * Whoever shows it asks the store to read (`useUsage().refreshReadable()`).
 */
const emit = defineEmits<{ 'sign-in': [] }>()

const { t } = useI18n()
const ws = useWorkspace()
const usage = useUsage()
const now = useNow(15_000)

const ids = Object.keys(AGENTS) as AgentId[]
/** Unknown until detection ran: then try anyway, the CLI's own error says what is wrong. */
const installed = (id: AgentId) => ws.agents.find(a => a.id === id)?.installed ?? true

type Level = 'ok' | 'high' | 'full'
const level = (percent: number): Level => (percent >= 100 ? 'full' : percent >= 80 ? 'high' : 'ok')

const clock = (at: number) => new Date(at).toLocaleTimeString(formatLocale(), { hour: '2-digit', minute: '2-digit' })

/** "Resets in 2 h 36 min", "Resets Wed 21:00", "Resets 16 Dec". */
function resetText(at: number | null, nowMs: number): string {
  if (at === null) return ''
  const mins = Math.ceil((at - nowMs) / 60_000)
  if (mins <= 0) return t('shell.usage.resetting')
  if (mins < 60) return t('shell.usage.resetsMin', { n: mins })
  if (mins < 24 * 60) return t('shell.usage.resetsHours', { h: Math.floor(mins / 60), m: mins % 60 })
  if (mins < 6 * 24 * 60) return t('shell.usage.resetsAt', { when: `${new Date(at).toLocaleDateString(formatLocale(), { weekday: 'short' })} ${clock(at)}` })
  return t('shell.usage.resetsAt', { when: new Date(at).toLocaleDateString(formatLocale(), { day: 'numeric', month: 'short' }) })
}
const resetTitle = (at: number | null) => (at === null ? undefined : new Date(at).toLocaleString(formatLocale(), { dateStyle: 'full', timeStyle: 'short' }))

/** "today 14:32", or "Wed 14:32" for an older one. */
function whenText(at: number): string {
  const d = new Date(at)
  const today = d.toDateString() === new Date(now.value).toDateString()
  return today ? t('shell.usage.today', { time: clock(at) }) : `${d.toLocaleDateString(formatLocale(), { weekday: 'short' })} ${clock(at)}`
}

const needsSignIn = (error: string | null) => !!error && /sign(ed)? in|log ?in|auth/i.test(error)
</script>

<template>
    <section v-for="id in ids" :key="id" class="use__agent" :aria-busy="usage.entries[id].loading || undefined">
      <header class="use__head">
        <h3 class="use__name">{{ AGENTS[id].name }}</h3>
        <span v-if="usage.entries[id].usage?.plan && !usage.entries[id].error" class="use__plan">{{ t('shell.usage.plan', { plan: usage.entries[id].usage!.plan! }) }}</span>
        <span v-if="usage.entries[id].simulated" class="use__sim" :title="t('shell.usage.simulatedTitle')">{{ t('shell.usage.simulated') }}</span>
        <span v-if="usage.entries[id].loading && usage.entries[id].usage" class="use__ring" role="status" :aria-label="t('shell.usage.reading')" />
      </header>

      <div v-if="usage.entries[id].resets.length" class="use__reset-note" role="status">
        <RotateCcw class="use__reset-icon" aria-hidden="true" />
        <ul class="use__reset-list">
          <li v-for="r in usage.entries[id].resets" :key="`${r.windowId}-${r.at}`">
            <i18n-t keypath="shell.usage.resetEarly" scope="global">
              <template #window><strong>{{ limitLabel({ id: r.windowId, label: r.label }) }}</strong></template>
              <template #from>{{ r.from }}</template>
              <template #to>{{ r.to }}</template>
            </i18n-t>
            {{ ' ' }}
            <span class="use__reset-when">{{ t('shell.usage.noticed', { when: whenText(r.at) }) }}</span>
          </li>
        </ul>
        <UiButton variant="ghost" size="sm" @click="usage.dismissResets(id)">{{ t('shell.usage.dismiss') }}</UiButton>
      </div>

      <div v-if="!installed(id)" class="use__msg">
        <span>{{ t('shell.usage.notInstalled') }}</span>
        <UiButton variant="ghost" size="sm" @click="ws.openSetup()">{{ t('shell.usage.getStarted') }}</UiButton>
      </div>

      <div v-else-if="usage.entries[id].error && !usage.entries[id].loading" class="use__msg use__msg--error" role="alert">
        <CircleAlert class="use__err-icon" aria-hidden="true" />
        <span>{{ usage.entries[id].error }}</span>
        <UiButton v-if="needsSignIn(usage.entries[id].error)" variant="ghost" size="sm" @click="emit('sign-in')">{{ t('common.actions.signIn') }}</UiButton>
      </div>

      <ul v-else-if="!usage.entries[id].usage" class="use__rows" aria-hidden="true">
        <li v-for="n in 2" :key="n" class="use__row is-skeleton">
          <span class="use__label"><span class="use__ghost" /></span>
          <span class="use__track" />
          <span class="use__pct" />
          <span class="use__reset"><span class="use__ghost use__ghost--short" /></span>
        </li>
      </ul>

      <template v-else>
        <ul v-if="usage.entries[id].usage!.windows.length" class="use__rows">
          <li v-for="w in usage.entries[id].usage!.windows" :key="w.id" class="use__row" :class="`is-${level(w.percent)}`">
            <span class="use__label">{{ limitLabel(w) }}</span>
            <span
              class="use__track"
              role="meter"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="Math.round(w.percent)"
              :aria-label="t('shell.usage.meter', { agent: AGENTS[id].name, window: limitLabel(w) })"
            >
              <span class="use__fill" :style="{ '--rest': `${100 - w.percent}%` }" />
            </span>
            <span class="use__pct tabular">{{ Math.round(w.percent) }}%</span>
            <span class="use__reset tabular" :title="resetTitle(w.resetsAt)">{{ resetText(w.resetsAt, now) }}</span>
          </li>
        </ul>
        <p v-if="usage.entries[id].usage!.note" class="use__note">{{ usage.entries[id].usage!.note }}</p>
      </template>
    </section>
</template>

<style scoped>
.use__agent {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4) 0;
  border-bottom: 1px solid var(--line);
}
.use__agent:last-child { border-bottom: 0; padding-bottom: 0; }

.use__head { display: flex; align-items: baseline; gap: var(--space-2); min-height: 20px; }
.use__name { margin: 0; font-size: var(--text-md); font-weight: 600; }
.use__plan { font-size: var(--text-xs); color: var(--fg-subtle); }
.use__sim {
  font-size: var(--text-2xs);
  color: var(--fg-faint);
  padding: 1px var(--space-1);
  border: 1px solid var(--line);
  border-radius: var(--radius-xs);
}
.use__ring {
  align-self: center;
  width: 11px;
  height: 11px;
  margin-left: auto;
  border-radius: 50%;
  border: 1.75px solid var(--fg-subtle);
  border-right-color: transparent;
  animation: use-turn 0.7s linear infinite;
}
@keyframes use-turn { to { transform: rotate(360deg); } }

.use__rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-1); }
.use__row {
  display: grid;
  grid-template-columns: 116px minmax(80px, 1fr) 40px 136px;
  align-items: center;
  gap: var(--space-3);
  min-height: 26px;
  font-size: var(--text-sm);
}
.use__label { color: var(--fg-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.use__track {
  position: relative;
  height: 6px;
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: var(--bg-active);
}
.use__fill {
  position: absolute;
  inset: 0;
  background: var(--accent);
  /* Revealed by clipping, not by width: no layout work while it moves. */
  clip-path: inset(0 var(--rest, 100%) 0 0 round var(--radius-pill));
  transition: clip-path var(--dur-med) var(--ease-out);
}
.use__pct { text-align: right; font-weight: 560; color: var(--fg); }
.use__reset { color: var(--fg-subtle); font-size: var(--text-xs); white-space: nowrap; }

.use__row.is-high .use__fill { background: var(--ripe-waiting); }
.use__row.is-high .use__pct { color: var(--ripe-waiting-fg); }
.use__row.is-full .use__fill { background: var(--ripe-error); }
.use__row.is-full .use__pct { color: var(--ripe-error-fg); }

/* Loading: the rows' shape, quietly breathing, until the first answer. */
.use__row.is-skeleton .use__track,
.use__ghost { animation: use-breathe 1.4s var(--ease-in-out) infinite alternate; }
.use__ghost {
  display: block;
  width: 64px;
  height: 8px;
  border-radius: var(--radius-pill);
  background: var(--bg-active);
}
.use__ghost--short { width: 88px; }
@keyframes use-breathe { from { opacity: 1; } to { opacity: 0.45; } }

.use__reset-note {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  font-size: var(--text-sm);
  color: var(--fg-muted);
  background: var(--bg-inset);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
}
.use__reset-icon { flex: none; width: 14px; height: 14px; margin-top: 3px; stroke-width: 1.85; color: var(--ripe-queued); }
.use__reset-list { flex: 1; min-width: 0; margin: 0; padding: 0; list-style: none; display: grid; gap: 2px; padding-top: 1px; }
.use__reset-list strong { font-weight: 560; color: var(--fg); }
.use__reset-when { margin-left: var(--space-1); font-size: var(--text-xs); color: var(--fg-subtle); }
.use__reset-note :deep(.btn) { flex: none; }
.use__msg {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--fg-muted);
}
.use__msg :deep(.btn) { margin-left: auto; }
.use__err-icon { width: 14px; height: 14px; flex: none; color: var(--ripe-error-fg); stroke-width: 1.85; }
.use__note { margin: 0; font-size: var(--text-xs); color: var(--fg-subtle); max-width: 62ch; }

@media (prefers-reduced-motion: reduce) {
  .use__ring, .use__row.is-skeleton .use__track, .use__ghost { animation: none; }
}
</style>
