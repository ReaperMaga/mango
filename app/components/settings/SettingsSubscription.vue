<script setup lang="ts">
import { ExternalLink, Gauge } from 'lucide-vue-next'
import { AGENTS, type AgentId } from '~/types/chat'
import type { AgentInfo } from '~/types/ipc'
import { openExternal } from '~/composables/useBackend'
import { useWorkspace } from '~/stores/workspace'
import type { AuthEntry } from './SettingsAgentRow.vue'

/**
 * The plan each agent is signed in with. Only what the CLIs report is shown: the plan, the
 * account and how it signs in. Renewal dates and invoices live with the vendor, one click away.
 */
const props = defineProps<{
  ids: AgentId[]
  auth: Record<string, AuthEntry>
  infoOf: (agent: AgentId) => AgentInfo | null
}>()

const { t } = useI18n()
const ws = useWorkspace()

/** Where each vendor manages a plan. */
const MANAGE: Record<string, { site: string; url: string }> = {
  claude: { site: 'claude.ai', url: 'https://claude.ai/settings/billing' },
  codex: { site: 'ChatGPT', url: 'https://chatgpt.com/#settings/Account' },
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

type Kind = 'plan' | 'no-plan' | 'signed-out' | 'missing' | 'checking' | 'error'

const cards = computed(() => props.ids.map((id) => {
  const entry = props.auth[id]
  const status = entry?.status ?? null
  const installed = props.infoOf(id)?.installed ?? status?.installed ?? null

  let kind: Kind
  if (installed === false) kind = 'missing'
  else if (entry?.error && !entry.loading) kind = 'error'
  else if (!status) kind = 'checking'
  else if (!status.loggedIn) kind = 'signed-out'
  else kind = status.plan ? 'plan' : 'no-plan'

  const title = {
    plan: t('agents.subscription.plan', { plan: cap(status?.plan ?? '') }),
    'no-plan': t('agents.subscription.none'),
    'signed-out': t('agents.cli.notSignedIn'),
    missing: t('agents.cli.notInstalled'),
    checking: t('agents.subscription.checking'),
    error: t('agents.subscription.error'),
  }[kind]

  const note = {
    plan: t('agents.subscription.planNote', { name: AGENTS[id].name }),
    'no-plan': status?.method ? t('agents.subscription.noneMethod', { method: status.method }) : t('agents.subscription.noneNote'),
    'signed-out': t('agents.subscription.signedOutNote'),
    missing: t('agents.subscription.missingNote', { name: AGENTS[id].name }),
    checking: '',
    error: entry?.error ?? '',
  }[kind]

  const details = status?.loggedIn
    ? [
        status.account && { label: t('agents.subscription.account'), value: status.account },
        status.organization && { label: t('agents.subscription.organization'), value: status.organization },
        status.method && { label: t('agents.subscription.method'), value: status.method },
      ].filter((d): d is { label: string; value: string } => !!d)
    : []

  return { id, kind, title, note, details, manage: MANAGE[id] ?? null }
}))

function fix(kind: Kind) {
  if (kind === 'missing') ws.openSetup()
  else ws.agentsTab = 'agents'
}
</script>

<template>
  <ul class="subs" :aria-label="t('agents.subscription.label')">
    <li v-for="c in cards" :key="c.id" class="plan" :class="`plan--${c.kind}`">
      <div class="plan__main">
        <UiAgentIcon :agent="c.id" class="plan__mark" aria-hidden="true" />
        <div class="plan__text">
          <p class="plan__agent">{{ AGENTS[c.id].name }}</p>
          <h3 class="plan__title">{{ c.title }}</h3>
          <p v-if="c.note" class="plan__note selectable">{{ c.note }}</p>
        </div>
        <div class="plan__actions">
          <UiButton v-if="c.kind === 'plan' && c.manage" size="sm" @click="openExternal(c.manage.url)">
            <ExternalLink />{{ t('agents.subscription.manage', { site: c.manage.site }) }}
          </UiButton>
          <UiButton v-else-if="c.kind === 'missing' || c.kind === 'signed-out' || c.kind === 'error'" size="sm" @click="fix(c.kind)">
            {{ c.kind === 'missing' ? t('agents.cli.installMore') : c.kind === 'signed-out' ? t('common.actions.signIn') : t('agents.subscription.seeAgents') }}
          </UiButton>
        </div>
      </div>

      <dl v-if="c.details.length" class="plan__details">
        <div v-for="d in c.details" :key="d.label" class="plan__row">
          <dt>{{ d.label }}</dt>
          <dd class="selectable">{{ d.value }}</dd>
        </div>
      </dl>

      <div v-if="c.kind === 'plan' || c.kind === 'no-plan'" class="plan__foot">
        <UiButton variant="ghost" size="sm" @click="ws.agentsTab = 'usage'"><Gauge />{{ t('agents.subscription.limits') }}</UiButton>
      </div>
    </li>
  </ul>
</template>

<style scoped>
.subs {
  display: grid;
  gap: var(--space-4);
  margin: 0;
  padding: 0;
  list-style: none;
}
.plan {
  background: var(--bg-panel);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
}
.plan__main {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4);
}
.plan__mark { flex: none; width: 28px; height: 28px; color: var(--fg); }
.plan--missing .plan__mark { opacity: 0.45; filter: grayscale(1); }
.plan__text { flex: 1; min-width: 0; }
.plan__agent {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--fg-subtle);
}
.plan__title {
  margin: 2px 0 0;
  font-size: var(--text-lg);
  font-weight: 620;
  letter-spacing: -0.01em;
}
.plan--missing .plan__title,
.plan--checking .plan__title,
.plan--signed-out .plan__title { color: var(--fg-muted); }
.plan__note {
  margin: var(--space-1) 0 0;
  font-size: var(--text-sm);
  color: var(--fg-subtle);
  text-wrap: pretty;
}
.plan--error .plan__note { color: var(--ripe-error-fg); }
.plan__actions { flex: none; }

.plan__details {
  margin: 0;
  padding: var(--space-1) var(--space-4);
  border-top: 1px solid var(--line-soft);
}
.plan__row {
  display: flex;
  align-items: baseline;
  gap: var(--space-4);
  min-height: 32px;
  padding: var(--space-1) 0;
  font-size: var(--text-sm);
}
.plan__row + .plan__row { border-top: 1px solid var(--line-soft); }
.plan__row dt { flex: none; width: 120px; color: var(--fg-subtle); }
.plan__row dd { margin: 0; min-width: 0; overflow-wrap: anywhere; color: var(--fg); }

.plan__foot {
  display: flex;
  padding: var(--space-1) var(--space-3);
  border-top: 1px solid var(--line-soft);
}
</style>
