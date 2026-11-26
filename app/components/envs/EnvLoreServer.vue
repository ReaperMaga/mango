<script setup lang="ts">
import { Check, CircleCheck, CircleDashed, Copy, LockKeyhole, RefreshCw, TriangleAlert, UserMinus } from 'lucide-vue-next'
import type { LoreSignInAction } from '~/types/ipc'
import { call } from '~/composables/useBackend'
import { instanceKey, useEnvironments } from '~/stores/environments'
import { useLore } from '~/stores/lore'
import { copyText } from '~/utils/clipboard'
import { ALL_V4, LORE_PORT, defaultLoreAddress, validListenAddress, validPublishPort } from '~/utils/lorePublish'
import { type LoreSignInDraft, draftFrom, draftValid, firstUserOf, signInFrom, signInWays, validEmail } from '~/utils/loreSignIn'
import EnvLorePublishFields from './EnvLorePublishFields.vue'
import EnvTerminal from './EnvTerminal.vue'
import LoreSignInFields from '~/components/settings/LoreSignInFields.vue'
import LoreLoginJob from '~/components/settings/LoreLoginJob.vue'

/**
 * The Lore server in an instance (the `lore-server` component), on its page: whether it runs,
 * the URL the other environments on the same server use, and the one this computer and anyone
 * outside use once it is published (UDP and TCP, on an address of the Incus host the user picks),
 * with what a host firewall needs. "Use as Lore server" hands both URLs to the saved Lore servers
 * (`envs.useAsLoreServer`). A joined environment shows its state, without publishing.
 *
 * Once published it can require sign-in (`env_lore_auth`, `lore_auth.rs`): Dex and Caddy inside the
 * instance, ports 80 and 443 published beside it, and clients on `lores://<domain>`. Setting it up,
 * turning it off and each user change run in a terminal here, where passwords and the GitHub secret
 * are typed on the server. With sign-in on, the row also says whether this computer is signed in, and
 * "Sign in on this computer" saves the server (as "Use as Lore server") and runs `lore login` right here.
 */
const props = defineProps<{ hostId: string; instance: string; running: boolean }>()

const { t } = useI18n()
const envs = useEnvironments()
const loreServers = useLore()
const key = computed(() => instanceKey(props.hostId, props.instance))
const host = computed(() => envs.host(props.hostId))
const lore = computed(() => envs.lore[key.value] ?? null)
const loading = computed(() => !!envs.loadingLore[key.value])
const readError = computed(() => envs.loreErrors[key.value] ?? null)
const published = computed(() => lore.value?.published ?? null)

function load(force = false) {
  if (!props.running) return
  if (force || (!lore.value && !loading.value)) envs.refreshLore(props.hostId, props.instance)
}
watch(() => props.running, (r) => { if (r) load(true) })
onMounted(() => load())
onActivated(() => load(true))

/* ---------- copy ---------- */

const copied = ref<string | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | undefined
async function copy(text: string) {
  if (!(await copyText(text))) return
  copied.value = text
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => { copied.value = null }, 1600)
}
onBeforeUnmount(() => clearTimeout(copiedTimer))

/* ---------- publish / stop ---------- */

const editing = ref(false)
const address = ref('')
const port = ref(String(LORE_PORT))
const touched = ref(false)
const busy = ref<'publish' | 'unpublish' | null>(null)
const actionError = ref<string | null>(null)
/** Which action `actionError` is about. */
const failed = ref<'publish' | 'unpublish'>('publish')

function startEdit() {
  const l = lore.value
  const p = l?.published
  address.value = p ? p.address.replace(/^\[(.*)\]$/, '$1') : defaultLoreAddress(l?.addresses ?? [])
  port.value = String(p?.port ?? LORE_PORT)
  touched.value = false
  actionError.value = null
  editing.value = true
}

async function publish() {
  touched.value = true
  if (!validListenAddress(address.value) || !validPublishPort(port.value) || busy.value) return
  busy.value = 'publish'
  actionError.value = null
  try {
    await envs.publishLore(props.hostId, props.instance, address.value.trim(), Number(port.value.trim()))
    editing.value = false
  } catch (e) {
    actionError.value = (e instanceof Error ? e.message : String(e)).replace(/\.$/, '')
    failed.value = busy.value ?? 'publish'
  } finally {
    busy.value = null
  }
}

async function unpublish() {
  busy.value = 'unpublish'
  actionError.value = null
  try {
    await envs.unpublishLore(props.hostId, props.instance)
  } catch (e) {
    actionError.value = (e instanceof Error ? e.message : String(e)).replace(/\.$/, '')
    failed.value = busy.value ?? 'publish'
  } finally {
    busy.value = null
  }
}

/* ---------- hand it over ---------- */

const using = ref(false)
const useError = ref<string | null>(null)
/** Saves it as a Lore server; `show` moves on to Settings > Lore. Answers the saved entry. */
async function use(show = true) {
  const l = lore.value
  if (!l || !host.value) return null
  using.value = true
  useError.value = null
  try {
    // With sign-in, every client uses the domain (the CLI only sends its token to the host the token names).
    return await envs.useAsLoreServer({
      name: t('envs.lore.entryName', { instance: props.instance, host: host.value.name }),
      url: l.published?.url ?? null,
      insideUrl: l.auth?.on ? null : l.insideUrl ?? l.insideIpUrl,
      origin: { hostId: props.hostId, instance: props.instance },
    }, show)
  } catch (e) {
    useError.value = e instanceof Error ? e.message : String(e)
    return null
  } finally {
    using.value = false
  }
}

const where = computed(() => {
  const p = published.value
  if (!p) return ''
  const all = p.address === ALL_V4 || p.address === '[::]'
  return t('envs.lore.publishedAt', { port: p.port, address: all ? t('envs.lore.allAddresses') : p.address })
})
const canPublish = computed(() => !!lore.value && !lore.value.publishNote)

/* ---------- sign-in ---------- */

const auth = computed(() => lore.value?.auth ?? null)
const signedIn = computed(() => !!auth.value?.on)
const ways = computed(() => (auth.value
  ? signInWays(auth.value, { passwords: t('lore.signIn.waysPasswords'), github: t('lore.signIn.waysGithub') })
  : ''))

type SignInForm = 'setup' | 'user' | null
const signInForm = ref<SignInForm>(null)
const draft = ref<LoreSignInDraft>(draftFrom(null))
const draftTouched = ref(false)
const email = ref('')
const emailTouched = ref(false)

function startSignIn() {
  draft.value = draftFrom(auth.value)
  draftTouched.value = false
  signInForm.value = 'setup'
  editing.value = false
}
function startUser() {
  email.value = ''
  emailTouched.value = false
  signInForm.value = 'user'
}

/** The sign-in action running in the terminal below, with what it needs. */
interface SignInJob { action: LoreSignInAction; email: string | null; key: number }
const job = ref<SignInJob | null>(null)
let jobs = 0
const jobTitles = computed(() => {
  const j = job.value
  const e = j?.email ?? ''
  switch (j?.action) {
    case 'off': return [t('lore.signIn.turningOff'), t('lore.signIn.turnedOff')]
    case 'user-add': return [t('lore.signIn.adding', { email: e }), t('lore.signIn.added', { email: e })]
    case 'user-remove': return [t('lore.signIn.removing', { email: e }), t('lore.signIn.removed', { email: e })]
    case 'github-secret': return [t('lore.signIn.secret'), t('lore.signIn.secretSet')]
    default: return [t('lore.signIn.setting'), t('lore.signIn.set')]
  }
})
/** The sign-in a setup job asked for (the form may change while it runs). */
let jobSignIn: ReturnType<typeof signInFrom> | null = null

const jobRunning = ref(false)
function run(action: LoreSignInAction, who: string | null = null) {
  if (jobRunning.value) return
  job.value = { action, email: who, key: ++jobs }
  jobRunning.value = true
  signInForm.value = null
}

function submitSignIn() {
  draftTouched.value = true
  if (!draftValid(draft.value)) return
  jobSignIn = signInFrom(draft.value)
  run('setup', firstUserOf(draft.value))
}
function submitUser() {
  emailTouched.value = true
  if (!validEmail(email.value)) return
  run('user-add', email.value.trim().toLowerCase())
}

const startJob = (cols: number, rows: number) => {
  const j = job.value!
  return call('env_lore_auth', {
    hostId: props.hostId,
    instance: props.instance,
    action: j.action,
    signIn: j.action === 'setup' ? jobSignIn : null,
    email: j.email,
    cols,
    rows,
  })
}

/** After a setup or turning it off, the saved entry for this server (if any) follows its new address. */
async function jobExit(code: number | null) {
  jobRunning.value = false
  const action = job.value?.action
  if (!props.running) return
  await envs.refreshLore(props.hostId, props.instance)
  if (code !== 0 || (action !== 'setup' && action !== 'off')) return
  const saved = loreServers.servers?.some(x => x.origin?.hostId === props.hostId && x.origin.instance === props.instance)
  // It stays on this page, where signing this computer in comes next.
  if (saved) await use(false)
}

/* ---------- this computer's sign-in ---------- */

/** The address this computer signs in to: the published one, once sign-in is on. */
const hereUrl = computed(() => (signedIn.value ? published.value?.url ?? null : null))
const hereState = computed(() => (hereUrl.value ? loreServers.checkOf(hereUrl.value) : null))
watch(hereUrl, (url) => { if (url && !loreServers.checkOf(url)) void loreServers.check(url) }, { immediate: true })
/** What the row says about this computer, and whether it offers to sign in. */
const here = computed<{ text: string; wait: boolean; signIn: boolean } | null>(() => {
  const s = hereState.value
  if (!hereUrl.value || !s) return null
  const c = s.check
  if (!c) {
    if (s.loading) return { text: t('lore.signIn.hereChecking'), wait: false, signIn: false }
    return s.error ? { text: t('lore.signIn.hereUnreachable', { message: s.error }), wait: true, signIn: false } : null
  }
  if (c.auth === 'signedIn') return { text: c.user ? t('lore.signIn.hereSignedInAs', { user: c.user }) : t('lore.signIn.hereSignedIn'), wait: false, signIn: false }
  if (c.auth === 'signedOut') return { text: t('lore.signIn.hereSignedOut'), wait: true, signIn: true }
  if (c.reach === 'noCli') return { text: t('lore.signIn.hereNoCli'), wait: true, signIn: false }
  if (c.reach !== 'ok') return { text: t('lore.signIn.hereUnreachable', { message: c.message ?? t('lore.state.unreachable') }), wait: true, signIn: false }
  return null
})
/** The saved entry `lore login` runs for, while it runs. */
const login = ref<{ url: string; name: string } | null>(null)
async function signInHere() {
  if (login.value) return
  const saved = await use(false)
  if (saved) login.value = { url: saved.url, name: saved.name }
}
function closeJob() {
  if (jobRunning.value) return
  job.value = null
}

/** The address ports 80 and 443 are published at, as people read it. */
const webAddress = computed(() => {
  const p = published.value
  if (!p) return ''
  return p.address === ALL_V4 || p.address === '[::]' ? t('envs.lore.allAddresses') : p.address
})
const emailError = computed(() => (emailTouched.value && !validEmail(email.value) ? t('lore.signIn.emailBad') : null))
const outsideAddress = computed(() => {
  const p = published.value
  if (!p) return null
  if (p.address !== ALL_V4 && p.address !== '[::]') return p.address
  return lore.value?.addresses.find(a => a.kind === 'public')?.address ?? null
})
</script>

<template>
  <section class="lore" aria-labelledby="lore-title">
    <header class="lore__head">
      <h3 id="lore-title" class="lore__h3">{{ t('envs.lore.title') }}</h3>
      <span class="lore__actions">
        <UiIconButton :label="t('envs.common.checkAgain')" size="sm" :disabled="!running || loading" @click="load(true)">
          <RefreshCw :class="{ 'is-turning': loading }" />
        </UiIconButton>
        <UiButton
          size="sm"
          :disabled="!lore?.installed || using"
          :loading="using"
          :title="t('envs.lore.useTitle')"
          @click="use"
        >
          {{ t('envs.lore.use') }}
        </UiButton>
      </span>
    </header>

    <p v-if="!running && !lore" class="lore__desc">{{ t('envs.lore.startToSee') }}</p>
    <p v-else-if="readError" class="lore__error" role="alert">
      {{ t('envs.lore.readFailed') }} <span class="selectable">{{ readError }}</span>
    </p>

    <template v-if="lore">
      <p class="lore__state" role="status">
        <template v-if="lore.running">
          <CircleCheck class="lore__icon lore__icon--ok" aria-hidden="true" />
          <span class="lore__word lore__word--ok">{{ t('envs.lore.running') }}</span>
        </template>
        <template v-else>
          <CircleDashed class="lore__icon lore__icon--wait" aria-hidden="true" />
          <span class="lore__word lore__word--wait">{{ lore.installed ? t('envs.lore.stopped') : t('envs.lore.notInstalled') }}</span>
        </template>
        <template v-if="lore.version"><span aria-hidden="true">·</span><span class="tabular">Lore {{ lore.version }}</span></template>
        <span aria-hidden="true">·</span>
        <span v-if="signedIn" class="lore__lock"><LockKeyhole aria-hidden="true" />{{ t('lore.signIn.on') }}</span>
        <span v-else>{{ t('envs.lore.noSignIn') }}</span>
      </p>
      <p v-if="lore.installed && !lore.running" class="lore__desc">{{ t('envs.lore.stoppedHint') }}</p>

      <dl class="lore__urls">
        <div class="lore__url-row">
          <dt>{{ t('envs.lore.inside') }}</dt>
          <dd>
            <span v-if="signedIn" class="lore__sub">{{ t('lore.signIn.insideSame') }}</span>
            <template v-else-if="lore.insideUrl ?? lore.insideIpUrl">
              <span class="lore__url">
                <code class="lore__mono selectable">{{ lore.insideUrl ?? lore.insideIpUrl }}</code>
                <UiIconButton :label="t('envs.lore.copy', { what: lore.insideUrl ?? lore.insideIpUrl })" size="sm" @click="copy((lore.insideUrl ?? lore.insideIpUrl)!)">
                  <Check v-if="copied === (lore.insideUrl ?? lore.insideIpUrl)" /><Copy v-else />
                </UiIconButton>
              </span>
              <span v-if="lore.insideUrl && lore.insideIpUrl" class="lore__sub">
                {{ t('envs.lore.insideIp', { url: lore.insideIpUrl }) }}
              </span>
            </template>
            <span v-else class="lore__sub">—</span>
          </dd>
        </div>

        <div class="lore__url-row">
          <dt>{{ t('envs.lore.outside') }}</dt>
          <dd>
            <template v-if="published">
              <span v-if="published.url" class="lore__url">
                <code class="lore__mono selectable">{{ published.url }}</code>
                <UiIconButton :label="t('envs.lore.copy', { what: published.url })" size="sm" @click="copy(published.url)">
                  <Check v-if="copied === published.url" /><Copy v-else />
                </UiIconButton>
              </span>
              <span class="lore__sub">
                <span class="tabular">{{ where }}</span>
                <template v-if="published.reachable === true">
                  <span aria-hidden="true">·</span><span class="lore__word--ok">{{ t('envs.lore.reachable') }}</span>
                </template>
              </span>
              <span v-if="published.reachable === false" class="lore__sub lore__sub--wait">{{ t('envs.lore.unreachable') }}</span>
              <span v-if="!published.complete" class="lore__sub lore__sub--wait">{{ t('envs.lore.incomplete') }}</span>
              <span v-if="published.urlNote" class="lore__sub selectable">{{ published.urlNote }}</span>
            </template>
            <span v-else class="lore__sub">{{ t('envs.lore.notPublished', { host: host?.name ?? '' }) }}</span>
            <span v-if="lore.publishNote" class="lore__sub">{{ lore.publishNote }}</span>
            <span v-else-if="!editing" class="lore__url-actions">
              <UiButton size="sm" :variant="published ? 'ghost' : 'secondary'" :disabled="!running || !!busy || jobRunning" @click="startEdit">
                {{ published ? t('envs.lore.change') : t('envs.lore.publish') }}
              </UiButton>
              <UiButton v-if="published" variant="ghost" size="sm" :loading="busy === 'unpublish'" :disabled="!!busy || jobRunning" @click="unpublish">
                {{ t('envs.lore.unpublish') }}
              </UiButton>
            </span>
          </dd>
        </div>

        <div v-if="lore.installed" class="lore__url-row">
          <dt>{{ t('lore.signIn.title') }}</dt>
          <dd>
            <template v-if="signedIn && auth">
              <span class="lore__sub lore__sub--strong">{{ t('lore.signIn.onText', { ways }) }}</span>
              <span v-if="here" class="lore__sub selectable" :class="{ 'lore__sub--wait': here.wait }" role="status">{{ here.text }}</span>
              <span v-if="!auth.certificate" class="lore__sub lore__sub--wait">{{ t('lore.signIn.noCert', { domain: auth.domain }) }}</span>
              <span v-if="auth.github && !auth.githubSecret" class="lore__sub lore__sub--wait">{{ t('lore.signIn.noSecret') }}</span>
              <span v-if="published && !published.web" class="lore__sub lore__sub--wait">{{ t('envs.lore.incomplete') }}</span>
              <template v-if="auth.passwords">
                <span class="lore__sub">{{ auth.users.length ? t('lore.signIn.users') : t('lore.signIn.noUsers') }}</span>
                <ul v-if="auth.users.length" class="lore__users">
                  <li v-for="u in auth.users" :key="u" class="lore__user">
                    <span class="lore__user-name selectable" :title="u">{{ u }}</span>
                    <UiIconButton
                      :label="t('lore.signIn.removeUser', { email: u })"
                      size="sm"
                      :disabled="!running || jobRunning || !!lore.publishNote"
                      @click="run('user-remove', u)"
                    >
                      <UserMinus />
                    </UiIconButton>
                  </li>
                </ul>
              </template>
            </template>
            <span v-else class="lore__sub">{{ auth ? t('lore.signIn.offBefore') : t('lore.signIn.offText') }}</span>
            <span v-if="!published && !lore.publishNote" class="lore__sub">{{ t('lore.signIn.needsPublish') }}</span>
            <span v-if="!lore.publishNote && published && !signInForm" class="lore__url-actions">
              <template v-if="signedIn && auth">
                <UiButton
                  v-if="here?.signIn"
                  size="sm"
                  variant="secondary"
                  :loading="using"
                  :disabled="!!login || jobRunning"
                  @click="signInHere"
                >
                  {{ t('lore.signIn.signInHere') }}
                </UiButton>
                <UiButton v-if="auth.passwords" size="sm" variant="ghost" :disabled="!running || jobRunning" @click="startUser">{{ t('lore.signIn.addUser') }}</UiButton>
                <UiButton v-if="auth.github" size="sm" variant="ghost" :disabled="!running || jobRunning" @click="run('github-secret')">{{ t('lore.signIn.newSecret') }}</UiButton>
                <UiButton size="sm" variant="ghost" :disabled="!running || jobRunning" @click="startSignIn">{{ t('lore.signIn.change') }}</UiButton>
                <UiButton size="sm" variant="ghost" :disabled="!running || jobRunning" @click="run('off')">{{ t('lore.signIn.turnOff') }}</UiButton>
              </template>
              <UiButton v-else size="sm" variant="secondary" :disabled="!running || jobRunning || !!busy" @click="startSignIn">{{ t('lore.signIn.turnOn') }}</UiButton>
            </span>
          </dd>
        </div>
      </dl>

      <form v-if="signInForm === 'setup'" class="lore__form" novalidate @submit.prevent="submitSignIn">
        <p class="lore__desc">{{ t('lore.signIn.requireHint') }}</p>
        <LoreSignInFields
          v-model="draft"
          id-prefix="lore-auth"
          :touched="draftTouched"
          :address="outsideAddress"
          :first-user="!signedIn || !auth?.users.length"
        />
        <p class="lore__desc">{{ t('lore.signIn.portsHint', { address: webAddress, host: host?.name ?? '' }) }}</p>
        <span class="lore__form-actions">
          <UiButton variant="ghost" size="sm" @click="signInForm = null">{{ t('common.actions.cancel') }}</UiButton>
          <UiButton variant="primary" size="sm" type="submit">{{ signedIn ? t('lore.signIn.changeAction') : t('lore.signIn.turnOnAction') }}</UiButton>
        </span>
      </form>
      <form v-else-if="signInForm === 'user'" class="lore__form" novalidate @submit.prevent="submitUser">
        <UiField :label="t('lore.signIn.email')" for="lore-auth-email" :error="emailError" :hint="t('lore.signIn.firstUserHint')">
          <input id="lore-auth-email" v-model="email" class="input" type="email" placeholder="you@example.com" autocomplete="off" spellcheck="false">
        </UiField>
        <span class="lore__form-actions">
          <UiButton variant="ghost" size="sm" @click="signInForm = null">{{ t('common.actions.cancel') }}</UiButton>
          <UiButton variant="primary" size="sm" type="submit">{{ t('lore.signIn.add') }}</UiButton>
        </span>
      </form>
      <EnvTerminal
        v-if="job"
        :key="job.key"
        :start="startJob"
        :title="jobTitles[0]!"
        :done-title="jobTitles[1]"
        :failed-title="t('lore.signIn.stopped')"
        :label="t('lore.signIn.terminal')"
        :rows="12"
        :retryable="false"
        @exit="jobExit"
        @close="closeJob"
      >
        <template #hint>{{ t('lore.signIn.runHint') }}</template>
      </EnvTerminal>
      <LoreLoginJob v-if="login" :url="login.url" :name="login.name" @close="login = null" />

      <form v-if="editing && canPublish" class="lore__form" novalidate @submit.prevent="publish">
        <EnvLorePublishFields
          v-model:address="address"
          v-model:port="port"
          id-prefix="lore-pub"
          :addresses="lore.addresses"
          :touched="touched"
        />
        <p class="lore__desc">{{ t('envs.create.publishHint', { host: host?.name ?? '' }) }} {{ t('envs.lore.cloud', { port: port || LORE_PORT }) }}</p>
        <span class="lore__form-actions">
          <UiButton variant="ghost" size="sm" :disabled="!!busy" @click="editing = false">{{ t('common.actions.cancel') }}</UiButton>
          <UiButton variant="primary" size="sm" type="submit" :loading="busy === 'publish'">{{ t('envs.lore.publishAction') }}</UiButton>
        </span>
      </form>
      <p v-if="useError" class="lore__error" role="alert">
        {{ t('envs.lore.useFailed') }} <span class="selectable">{{ useError }}</span>
      </p>
      <p v-if="actionError" class="lore__error" role="alert">
        {{ failed === 'unpublish' ? t('envs.lore.unpublishFailed') : t('envs.lore.publishFailed') }}
        <span class="selectable">{{ actionError }}.</span>
      </p>

      <div v-if="published && !editing" class="lore__fw">
        <template v-if="lore.firewall">
          <p class="lore__fw-text">
            <TriangleAlert aria-hidden="true" />
            <span>{{ t(`envs.lore.firewall.${lore.firewall.kind}`, { host: host?.name ?? '', port: published.port }) }}</span>
          </p>
          <span v-for="c in lore.firewall.commands" :key="c" class="lore__url lore__cmd">
            <code class="lore__mono selectable">{{ c }}</code>
            <UiIconButton :label="t('envs.lore.copy', { what: c })" size="sm" @click="copy(c)">
              <Check v-if="copied === c" /><Copy v-else />
            </UiIconButton>
          </span>
        </template>
        <p class="lore__desc">{{ t('envs.lore.cloud', { port: published.port }) }}</p>
        <p v-if="published.web" class="lore__desc">{{ t('lore.signIn.portsHint', { address: webAddress, host: host?.name ?? '' }) }}</p>
      </div>
    </template>
    <div v-else-if="loading" class="lore__skeleton" aria-busy="true" aria-hidden="true">
      <span class="bone bone--a" /><span class="bone bone--b" />
    </div>
  </section>
</template>

<style scoped>
.lore { display: grid; gap: var(--space-2); margin-top: var(--space-3); }
.lore__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.lore__h3 { margin: 0; font-size: var(--text-lg); font-weight: 620; letter-spacing: -0.01em; }
.lore__actions { display: inline-flex; align-items: center; gap: var(--space-1); }
.lore__desc { margin: 0; max-width: 70ch; font-size: var(--text-xs); color: var(--fg-subtle); text-wrap: pretty; }
.lore__error { margin: 0; font-size: var(--text-xs); color: var(--ripe-error-fg); text-wrap: pretty; }

.lore__state {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px var(--space-2);
  margin: 0;
  font-size: var(--text-sm);
  color: var(--fg-muted);
}
.lore__icon { width: 15px; height: 15px; flex: none; }
.lore__icon--ok { color: var(--ripe-done); }
.lore__icon--wait { color: var(--ripe-waiting); }
.lore__word { font-weight: 560; }
.lore__word--ok { color: var(--ripe-done-fg); }
.lore__word--wait { color: var(--ripe-waiting-fg); }

.lore__urls { display: grid; margin: var(--space-1) 0 0; }
.lore__url-row {
  display: grid;
  grid-template-columns: minmax(140px, 220px) minmax(0, 1fr);
  gap: var(--space-4);
  padding: var(--space-2) 0;
  border-top: 1px solid var(--line-soft);
}
.lore__url-row:last-child { border-bottom: 1px solid var(--line-soft); }
.lore__url-row dt { padding-top: 5px; font-size: var(--text-sm); color: var(--fg-muted); }
.lore__url-row dd { display: grid; justify-items: start; gap: 4px; min-width: 0; margin: 0; }
.lore__url { display: inline-flex; align-items: center; gap: var(--space-1); max-width: 100%; min-width: 0; }
.lore__mono {
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
.lore__sub { display: inline-flex; flex-wrap: wrap; gap: 4px 6px; font-size: var(--text-xs); color: var(--fg-subtle); text-wrap: pretty; }
.lore__sub--wait { color: var(--ripe-waiting-fg); }
.lore__sub--strong { color: var(--fg-muted); }
.lore__lock { display: inline-flex; align-items: center; gap: 4px; color: var(--ripe-done-fg); }
.lore__lock svg { width: 13px; height: 13px; }
.lore__users { display: grid; width: 100%; max-width: 420px; margin: 0; padding: 0; list-style: none; }
.lore__user { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); min-height: 26px; }
.lore__user-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-xs); color: var(--fg); }
.lore__url-actions { display: inline-flex; gap: var(--space-1); margin-top: 2px; }

.lore__form {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-3);
  background: var(--bg-raised);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
}
.lore__form-actions { display: inline-flex; justify-content: flex-end; gap: var(--space-1); }

.lore__fw { display: grid; justify-items: start; gap: var(--space-1); }
.lore__fw-text { display: flex; gap: var(--space-2); margin: 0; font-size: var(--text-xs); color: var(--fg); text-wrap: pretty; }
.lore__fw-text :deep(svg) { flex: none; width: 14px; height: 14px; margin-top: 1px; color: var(--ripe-waiting); }
.lore__cmd { margin-left: calc(14px + var(--space-2)); }

.lore__skeleton { display: grid; gap: var(--space-2); padding: var(--space-2) 0; }
.bone { height: 10px; border-radius: var(--radius-xs); background: var(--bg-hover); }
.bone--a { width: 40%; height: 12px; }
.bone--b { width: 65%; }

.is-turning { animation: lore-turn 0.8s linear infinite; }
@keyframes lore-turn { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .is-turning { animation: none; } }
</style>
