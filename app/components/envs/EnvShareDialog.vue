<script setup lang="ts">
import { Check, CircleAlert, Copy, Info, KeyRound } from 'lucide-vue-next'
import { shareDay, sshHostName, useEnvironments } from '~/stores/environments'
import type { EnvShareLink, EnvShareVia } from '~/types/ipc'
import { copyToClipboard } from '~/utils/agentCli'
import SettingsSegmented from '~/components/settings/SettingsSegmented.vue'
import EnvQr from './EnvQr.vue'

/**
 * Share one instance: who it is for, how they reach it (a public port on the
 * server, or the instance's tailnet address), and when access ends. Creating
 * the first share of an instance sets up an SSH server inside it, which takes a
 * while, so the dialog shows that it is working. The result is the link, once:
 * Mango keeps no copy of its key.
 */
const props = defineProps<{ open: boolean; hostId: string; instance: string }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const envs = useEnvironments()
const host = computed(() => envs.host(props.hostId))
const inst = computed(() => envs.instance(props.hostId, props.instance))
const tailnetIp = computed(() => inst.value?.tailscaleIp ?? null)

type Days = '1' | '7' | '30' | 'never'
const label = ref('')
const via = ref<EnvShareVia>('public')
const days = ref<Days>('7')
const step = ref<'form' | 'creating' | 'done'>('form')
const touched = ref(false)
const error = ref<string | null>(null)
const result = ref<EnvShareLink | null>(null)
const copied = ref(false)
const cmdCopied = ref(false)

/**
 * The backend's note on what is left to do, e.g. "… ufw is active on it: sudo ufw allow 22101/tcp".
 * A command at its end is shown as code, whole and copyable, instead of wrapping as prose.
 */
const todo = computed(() => {
  const note = result.value?.note?.trim()
  if (!note) return null
  // "<sentence>: <command>" at the end; anything else stays one sentence.
  const m = /^([\s\S]*):\s+((?:sudo|ufw|firewall-cmd|iptables|nft)\s[^\n]+?)\.?$/.exec(note)
  return m ? { text: `${m[1]!.trim()}:`, command: m[2]!.trim() } : { text: note, command: null }
})

async function copyCommand() {
  if (!todo.value?.command) return
  await copyToClipboard(todo.value.command)
  cmdCopied.value = true
  setTimeout(() => (cmdCopied.value = false), 1800)
}
const linkInput = ref<HTMLInputElement | null>(null)

/* How long creating has taken: honest progress for a step that reports none. */
const elapsed = ref(0)
let tick: ReturnType<typeof setInterval> | undefined
const stopTick = () => clearInterval(tick)
onBeforeUnmount(stopTick)

watch(() => props.open, (o) => {
  if (!o) return
  label.value = ''
  via.value = 'public'
  days.value = '7'
  step.value = 'form'
  touched.value = false
  error.value = null
  result.value = null
  copied.value = false
})

/** Where a share over the internet points: the server's public address, else its SSH host. */
const publicHost = computed(() => {
  const h = host.value
  if (!h) return t('envs.share.theServer')
  return h.publicAddress?.trim() || sshHostName(h.ssh)
})

const viaOptions = computed(() => [
  { value: 'public' as const, label: t('envs.common.overInternet') },
  {
    value: 'tailscale' as const,
    label: 'Tailscale',
    disabled: !tailnetIp.value,
    title: tailnetIp.value ? undefined : t('envs.share.notOnTailnet', { name: props.instance }),
  },
])
const dayOptions = computed<Array<{ value: Days; label: string }>>(() => [
  { value: '1', label: t('envs.share.days', 1) },
  { value: '7', label: t('envs.share.days', 7) },
  { value: '30', label: t('envs.share.days', 30) },
  { value: 'never', label: t('envs.share.never') },
])

const labelError = computed(() => {
  if (!touched.value) return null
  const l = label.value.trim()
  if (!l) return t('envs.share.labelEmpty')
  if (l.length > 60) return t('envs.share.labelLong')
  return null
})

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\.$/, '')

async function submit() {
  if (step.value !== 'form') return
  touched.value = true
  error.value = null
  if (labelError.value) return
  step.value = 'creating'
  elapsed.value = 0
  tick = setInterval(() => elapsed.value++, 1000)
  try {
    result.value = await envs.createShare(
      props.hostId, props.instance, label.value.trim(), via.value, days.value === 'never' ? null : Number(days.value),
    )
    step.value = 'done'
    // The link, selected: ready to copy with the keyboard too.
    await nextTick()
    linkInput.value?.focus()
  } catch (e) {
    error.value = errorText(e)
    step.value = 'form'
  } finally {
    stopTick()
  }
}

async function copy() {
  if (!result.value) return
  await copyToClipboard(result.value.url)
  copied.value = true
  setTimeout(() => (copied.value = false), 1800)
}

/** The whole link at once: it only works whole. */
const selectAll = (e: Event) => {
  const input = e.target as HTMLInputElement
  // Selected backwards, so the field keeps showing the start (mango://join/…) rather than scrolling to the end.
  input.setSelectionRange(0, input.value.length, 'backward')
  input.scrollLeft = 0
}

/** The server needs a public address first: its dialog, in place of this one. */
function editServer() {
  emit('close')
  envs.dialog = { kind: 'host', id: props.hostId }
}

function close() {
  if (step.value !== 'creating') emit('close')
}

const title = computed(() => (step.value === 'done' && result.value ? t('envs.share.linkFor', { name: result.value.share.label }) : t('envs.share.title', { name: props.instance })))
const clock = computed(() => `${Math.floor(elapsed.value / 60)}:${String(elapsed.value % 60).padStart(2, '0')}`)
</script>

<template>
  <UiDialog :open="open" :title="title" :width="620" :dismissible="step !== 'creating'" @close="close">
    <!-- 1. who, how, how long -->
    <form v-if="step !== 'done'" id="env-share-form" class="sh" novalidate @submit.prevent="submit">
      <p class="sh__lede">
        {{ host ? t('envs.share.lede', { name: instance, host: host.name }) : t('envs.share.ledeServer', { name: instance }) }}
      </p>

      <UiField
        :label="t('envs.share.who')"
        for="sh-label"
        :hint="t('envs.share.whoHint')"
        :error="labelError"
      >
        <input
          id="sh-label"
          v-model="label"
          class="input"
          type="text"
          placeholder="Sam"
          autocomplete="off"
          spellcheck="false"
          maxlength="80"
          :disabled="step === 'creating'"
          :aria-invalid="!!labelError || undefined"
        >
      </UiField>

      <fieldset class="sh__group" :disabled="step === 'creating'">
        <legend id="sh-via-label" class="sh__label">{{ t('envs.share.how') }}</legend>
        <SettingsSegmented v-model="via" :options="viaOptions" labelledby="sh-via-label" describedby="sh-via-hint" />
        <p id="sh-via-hint" class="sh__hint">
          <i18n-t v-if="via === 'public'" keypath="envs.share.publicHint" scope="global">
            <template #host><span class="sh__mono selectable">{{ publicHost }}</span></template>
            <template #name>{{ instance }}</template>
          </i18n-t>
          <i18n-t v-else keypath="envs.share.tailscaleHint" scope="global">
            <template #name>{{ instance }}</template>
            <template #ip><span class="sh__mono selectable">{{ tailnetIp }}</span></template>
          </i18n-t>
        </p>
        <p v-if="via === 'public' && !host?.publicAddress" class="sh__hint sh__hint--quiet">
          {{ t('envs.share.publicQuiet') }}
        </p>
      </fieldset>

      <fieldset class="sh__group" :disabled="step === 'creating'">
        <legend id="sh-days-label" class="sh__label">{{ t('envs.common.accessEnds') }}</legend>
        <SettingsSegmented v-model="days" :options="dayOptions" labelledby="sh-days-label" />
        <p class="sh__hint">
          <template v-if="days === 'never'">{{ t('envs.share.untilRevoked') }}</template>
          <template v-else>{{ t('envs.share.after', Number(days)) }}</template>
        </p>
      </fieldset>

      <div v-if="step === 'creating'" class="sh__progress" role="status">
        <span class="ring" aria-hidden="true" />
        <span class="sh__progress-text">
          <span class="sh__progress-title">{{ t('envs.share.settingUp', { name: instance }) }}</span>
          <span class="sh__progress-note">
            {{ t('envs.share.settingUpNote') }}
          </span>
        </span>
        <span class="sh__clock tabular" aria-hidden="true">{{ clock }}</span>
      </div>

      <p v-if="error" class="sh__error" role="alert">
        <CircleAlert aria-hidden="true" />
        <span class="selectable">{{ t('envs.share.failed', { error }) }}</span>
      </p>
      <UiButton v-if="error && /public address/i.test(error)" size="sm" class="sh__fix" @click="editServer">
        {{ host ? t('envs.share.editServer', { name: host.name }) : t('envs.share.editServerUnnamed') }}
      </UiButton>
    </form>

    <!-- 2. the link, once -->
    <div v-else-if="result" class="done">
      <div class="done__grid">
        <EnvQr class="done__qr" :value="result.url" :label="t('envs.share.qr', { name: result.share.label })" />
        <div class="done__info">
          <label class="sh__label" for="sh-link">{{ t('envs.join.link') }}</label>
          <div class="done__link">
            <input
              id="sh-link"
              ref="linkInput"
              class="done__input selectable"
              type="text"
              readonly
              :value="result.url"
              spellcheck="false"
              aria-describedby="sh-note"
              @focus="selectAll"
            >
            <UiButton @click="copy">
              <Check v-if="copied" /><Copy v-else />{{ copied ? t('common.actions.copied') : t('common.actions.copy') }}
            </UiButton>
          </div>
          <dl class="done__facts">
            <div class="done__fact">
              <dt>{{ t('envs.share.reaches') }}</dt>
              <dd>
                {{ result.share.via === 'public' ? t('envs.common.overInternet') : t('envs.share.overTailscale') }},
                <span class="sh__mono selectable">{{ result.share.endpoint }}</span>
              </dd>
            </div>
            <div class="done__fact">
              <dt>{{ t('envs.common.accessEnds') }}</dt>
              <dd class="tabular">{{ result.share.expiresAt ? shareDay(result.share.expiresAt) : t('envs.share.whenRevoked') }}</dd>
            </div>
          </dl>
          <p class="sh__hint">
            {{ t('envs.share.openHint') }}
          </p>
        </div>
      </div>

      <!-- what the owner may still need to do, e.g. open the port in a firewall -->
      <div v-if="todo" class="done__todo">
        <Info class="done__todo-icon" aria-hidden="true" />
        <div class="done__todo-body">
          <span class="selectable">{{ todo.text }}</span>
          <span v-if="todo.command" class="done__cmd">
            <code class="done__cmd-text selectable">{{ todo.command }}</code>
            <UiIconButton :label="cmdCopied ? t('common.actions.copied') : t('envs.share.copyCommand')" size="sm" @click="copyCommand">
              <Check v-if="cmdCopied" /><Copy v-else />
            </UiIconButton>
          </span>
        </div>
      </div>

      <p id="sh-note" class="done__note">
        <KeyRound class="done__note-icon" aria-hidden="true" />
        <span>
          {{ t('envs.share.note', { name: instance }) }}
        </span>
      </p>
    </div>

    <template #footer>
      <template v-if="step === 'done'">
        <UiButton variant="primary" @click="emit('close')">{{ t('common.actions.done') }}</UiButton>
      </template>
      <template v-else>
        <UiButton variant="ghost" :disabled="step === 'creating'" @click="close">{{ t('common.actions.cancel') }}</UiButton>
        <UiButton variant="primary" type="submit" form="env-share-form" :loading="step === 'creating'">{{ t('envs.share.create') }}</UiButton>
      </template>
    </template>
  </UiDialog>
</template>

<style scoped>
.sh { display: grid; gap: var(--space-4); }
.sh__lede { margin: 0; font-size: var(--text-sm); color: var(--fg-subtle); text-wrap: pretty; }
.sh :deep(.field + .field) { margin-top: 0; }

.sh__group { display: grid; justify-items: start; gap: 6px; margin: 0; padding: 0; border: 0; min-width: 0; }
.sh__label { padding: 0; font-size: var(--text-xs); font-weight: 560; color: var(--fg-muted); }
.sh__hint { margin: 0; max-width: 64ch; font-size: var(--text-xs); color: var(--fg-subtle); line-height: var(--leading-normal); text-wrap: pretty; }
.sh__hint--quiet { color: var(--fg-faint); }
.sh__mono { font-family: var(--font-mono); font-size: var(--text-2xs); color: var(--fg-muted); }

/* ---- creating ---- */
.sh__progress {
  display: grid;
  grid-template-columns: 14px 1fr auto;
  align-items: start;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
}
.sh__progress .ring { margin-top: 3px; }
.sh__progress-text { display: grid; gap: 2px; min-width: 0; }
.sh__progress-title { font-size: var(--text-sm); font-weight: 560; color: var(--fg); }
.sh__progress-note { font-size: var(--text-xs); color: var(--fg-subtle); text-wrap: pretty; }
.sh__clock { font-size: var(--text-xs); color: var(--fg-faint); line-height: 20px; }

.sh__error {
  display: flex;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--ripe-error);
}
.sh__error :deep(svg) { width: 15px; height: 15px; margin-top: 2px; flex: none; }
.sh__error span { color: var(--fg); }
.sh__fix { justify-self: start; margin: calc(var(--space-2) * -1) 0 0 23px; }

/* ---- the link ---- */
.done { display: grid; gap: var(--space-4); }
.done__grid {
  display: grid;
  grid-template-columns: 224px minmax(0, 1fr);
  gap: var(--space-5);
  align-items: start;
}
.done__info { display: grid; gap: 6px; min-width: 0; }
.done__link { display: flex; gap: var(--space-2); min-width: 0; }
.done__input {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 var(--space-3);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--fg);
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  text-overflow: ellipsis;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.done__input:focus { outline: none; border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.done__facts { display: grid; gap: 2px; margin: var(--space-2) 0 var(--space-1); }
.done__fact { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: var(--space-2); font-size: var(--text-sm); }
.done__fact dt { color: var(--fg-subtle); }
.done__fact dd { margin: 0; min-width: 0; color: var(--fg-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.done__todo {
  display: flex;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--fg-muted);
  text-wrap: pretty;
}
.done__todo-icon { flex: none; width: 15px; height: 15px; margin-top: 2px; stroke-width: 1.85; color: var(--fg-subtle); }
.done__todo-body { display: grid; justify-items: start; gap: 6px; min-width: 0; }
.done__cmd {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  max-width: 100%;
  padding: 0 2px 0 var(--space-2);
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}
.done__cmd-text {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--fg);
  white-space: nowrap;
  overflow-x: auto;
}

.done__note {
  display: flex;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-3);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--fg);
  border: 1px solid color-mix(in oklch, var(--ripe-waiting) 45%, transparent);
  border-radius: var(--radius-md);
  text-wrap: pretty;
}
.done__note-icon { flex: none; width: 15px; height: 15px; margin-top: 2px; stroke-width: 1.85; color: var(--ripe-waiting); }

.ring {
  flex: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.75px solid var(--ripe-running);
  border-right-color: transparent;
  animation: sh-turn 0.7s linear infinite;
}
@keyframes sh-turn { to { transform: rotate(360deg); } }
</style>
