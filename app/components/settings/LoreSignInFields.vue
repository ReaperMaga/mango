<script setup lang="ts">
import { Check, Copy } from 'lucide-vue-next'
import { copyText } from '~/utils/clipboard'
import { type LoreSignInDraft, MAX_ORGS, draftProblems, githubCallback, sslipName } from '~/utils/loreSignIn'

/**
 * A Lore server's sign-in as a form (`utils/loreSignIn.ts` checks it as the backend does): the domain
 * that points at the server, who may sign in (password users, members of GitHub organisations), the
 * GitHub OAuth app's client ID and callback URL, and optionally a first password user. Used by
 * Settings > Lore > Set up a server and by an environment's Lore server. The secret and passwords
 * are never fields: the terminal on the server asks for them.
 */
const props = defineProps<{
  idPrefix: string
  /** Show what is wrong (after a first try). */
  touched?: boolean
  /** Where the server listens: a public IPv4 address gets an sslip.io name offered. */
  address?: string | null
  /** Offer a first password user (a new sign-in). */
  firstUser?: boolean
}>()
const draft = defineModel<LoreSignInDraft>({ required: true })

const { t } = useI18n()
const problems = computed(() => draftProblems(draft.value))

const domainError = computed(() => {
  const d = props.touched ? problems.value.domain : null
  return d ? t(d === 'missing' ? 'lore.signIn.domainMissing' : 'lore.signIn.domainBad') : null
})
const clientIdError = computed(() => {
  const c = props.touched ? problems.value.clientId : null
  return c ? t(c === 'missing' ? 'lore.signIn.clientIdMissing' : 'lore.signIn.clientIdBad') : null
})
const orgsError = computed(() => {
  const o = props.touched ? problems.value.orgs : null
  if (!o) return null
  return o === 'missing' ? t('lore.signIn.orgsMissing') : o === 'bad' ? t('lore.signIn.orgsBad') : t('lore.signIn.orgsMany', { max: MAX_ORGS })
})
const firstUserError = computed(() => (props.touched && problems.value.firstUser ? t('lore.signIn.emailBad') : null))

const sslip = computed(() => (props.address ? sslipName(props.address) : null))
const callback = computed(() => githubCallback(draft.value.domain))

// The parent's value comes back on its next render: several changes in one tick (a paste, then a
// click) build on the last one sent, not on the value still shown.
let latest = draft.value
watch(draft, (v) => { latest = v })
function set<K extends keyof LoreSignInDraft>(k: K, v: LoreSignInDraft[K]) {
  latest = { ...latest, [k]: v }
  draft.value = latest
}

const copied = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
async function copyCallback() {
  if (!(await copyText(callback.value))) return
  copied.value = true
  clearTimeout(timer)
  timer = setTimeout(() => { copied.value = false }, 1600)
}
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <div class="lsf">
    <UiField :label="t('lore.signIn.domain')" :for="`${idPrefix}-domain`" :error="domainError" :hint="t('lore.signIn.domainHint')">
      <input
        :id="`${idPrefix}-domain`"
        :value="draft.domain"
        class="input lsf__mono"
        type="text"
        placeholder="lore.example.com"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        :aria-invalid="!!domainError || undefined"
        @input="set('domain', ($event.target as HTMLInputElement).value)"
      >
    </UiField>
    <p v-if="sslip && draft.domain.trim() !== sslip" class="lsf__hint lsf__sslip">
      <span>{{ t('lore.signIn.sslipHint', { name: sslip, address }) }}</span>
      <UiButton variant="ghost" size="sm" @click="set('domain', sslip)">{{ t('lore.signIn.useSslip', { name: sslip }) }}</UiButton>
    </p>

    <fieldset class="lsf__who" :aria-describedby="touched && problems.pick ? `${idPrefix}-pick` : undefined">
      <legend class="lsf__label">{{ t('lore.signIn.who') }}</legend>
      <label class="lsf__opt">
        <input :checked="draft.passwords" type="checkbox" class="lsf__check" @change="set('passwords', ($event.target as HTMLInputElement).checked)">
        <span class="lsf__opt-text">
          <span class="lsf__opt-name">{{ t('lore.signIn.passwords') }}</span>
          <span class="lsf__opt-desc">{{ t('lore.signIn.passwordsHint') }}</span>
        </span>
      </label>
      <UiField
        v-if="draft.passwords && firstUser"
        class="lsf__inner"
        :label="t('lore.signIn.firstUser')"
        :for="`${idPrefix}-first`"
        :error="firstUserError"
        :hint="t('lore.signIn.firstUserHint')"
      >
        <input
          :id="`${idPrefix}-first`"
          :value="draft.firstUser"
          class="input"
          type="email"
          placeholder="you@example.com"
          autocomplete="off"
          spellcheck="false"
          @input="set('firstUser', ($event.target as HTMLInputElement).value)"
        >
      </UiField>
      <label class="lsf__opt">
        <input :checked="draft.github" type="checkbox" class="lsf__check" @change="set('github', ($event.target as HTMLInputElement).checked)">
        <span class="lsf__opt-text">
          <span class="lsf__opt-name">{{ t('lore.signIn.github') }}</span>
          <span class="lsf__opt-desc">{{ t('lore.signIn.githubHint') }}</span>
        </span>
      </label>
      <div v-if="draft.github" class="lsf__inner lsf__gh">
        <div class="lsf__row">
          <UiField :label="t('lore.signIn.orgs')" :for="`${idPrefix}-orgs`" :error="orgsError">
            <input
              :id="`${idPrefix}-orgs`"
              :value="draft.orgs"
              class="input"
              type="text"
              placeholder="fruit-co"
              autocomplete="off"
              spellcheck="false"
              @input="set('orgs', ($event.target as HTMLInputElement).value)"
            >
          </UiField>
          <UiField :label="t('lore.signIn.clientId')" :for="`${idPrefix}-client`" :error="clientIdError">
            <input
              :id="`${idPrefix}-client`"
              :value="draft.clientId"
              class="input lsf__mono"
              type="text"
              placeholder="Ov23li…"
              autocomplete="off"
              spellcheck="false"
              @input="set('clientId', ($event.target as HTMLInputElement).value)"
            >
          </UiField>
        </div>
        <p class="lsf__hint">{{ t('lore.signIn.githubApp') }}</p>
        <span class="lsf__callback">
          <span class="lsf__callback-label">{{ t('lore.signIn.callback') }}</span>
          <code class="lsf__code selectable" :title="callback">{{ callback }}</code>
          <UiIconButton :label="t('envs.lore.copy', { what: callback })" size="sm" @click="copyCallback">
            <Check v-if="copied" /><Copy v-else />
          </UiIconButton>
        </span>
      </div>
      <p v-if="touched && problems.pick" :id="`${idPrefix}-pick`" class="lsf__error" role="alert">{{ t('lore.signIn.pickOne') }}</p>
    </fieldset>
  </div>
</template>

<style scoped>
.lsf { display: grid; gap: var(--space-2); min-width: 0; }
.lsf :deep(.field + .field) { margin-top: 0; }
.lsf__mono { font-family: var(--font-mono); }
.lsf .input.lsf__mono { font-size: var(--text-xs); }
.lsf__label { padding: 0; font-size: var(--text-xs); font-weight: 560; color: var(--fg-muted); }
.lsf__hint { margin: 0; max-width: 62ch; font-size: var(--text-xs); line-height: var(--leading-tight); color: var(--fg-subtle); text-wrap: pretty; }
.lsf__error { margin: 0; font-size: var(--text-xs); color: var(--ripe-error-fg); }
.lsf__sslip { display: flex; flex-wrap: wrap; align-items: center; gap: 4px var(--space-2); margin-top: -2px; }

.lsf__who { display: grid; gap: 2px; min-width: 0; margin: var(--space-2) 0 0; padding: 0; border: 0; }
.lsf__who legend { float: left; width: 100%; margin-bottom: var(--space-1); }
.lsf__opt {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: 6px var(--space-2);
  margin: 0 calc(var(--space-2) * -1);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.lsf__opt:hover { background: var(--bg-hover); }
.lsf__opt-text { display: grid; min-width: 0; }
.lsf__opt-name { font-size: var(--text-sm); font-weight: 560; color: var(--fg); }
.lsf__opt-desc { font-size: var(--text-xs); color: var(--fg-subtle); text-wrap: pretty; }
.lsf__check {
  appearance: none;
  flex: none;
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  margin: 2px 0 0;
  background: var(--bg-inset);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-xs);
  cursor: inherit;
  transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.lsf__check::after {
  content: '';
  width: 7px;
  height: 4px;
  margin-top: -2px;
  border: solid var(--accent-fg);
  border-width: 0 0 1.75px 1.75px;
  rotate: -45deg;
  opacity: 0;
}
.lsf__check:checked { background: var(--accent); border-color: var(--accent); }
.lsf__check:checked::after { opacity: 1; }
.lsf__check:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }

/* Under its option, lined up with the option's text (checkbox 14px + the gap). */
.lsf__inner { margin: 2px 0 var(--space-2) calc(14px + var(--space-2)); }
.lsf__gh { display: grid; gap: var(--space-2); min-width: 0; }
.lsf__row { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); align-items: start; }
.lsf__callback { display: inline-flex; align-items: center; gap: var(--space-2); min-width: 0; max-width: 100%; }
.lsf__callback-label { flex: none; font-size: var(--text-xs); color: var(--fg-muted); }
.lsf__code {
  min-width: 0;
  padding: 3px var(--space-2);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--fg);
  background: var(--bg-inset);
  border-radius: var(--radius-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
