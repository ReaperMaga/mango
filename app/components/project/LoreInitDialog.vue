<script setup lang="ts">
import { ChevronDown, CircleAlert, CircleCheck, TriangleAlert } from 'lucide-vue-next'
import type { LoreInitInfo } from '~/types/ipc'
import type { MenuItem } from '~/types/ui'
import { useGit } from '~/stores/git'
import { useLore } from '~/stores/lore'
import { useWorkspace } from '~/stores/workspace'
import { loreRepoNameFrom, loreRepoNameProblem, loreUrlFor } from '~/utils/lore'
import { loreIgnoreFrom, loreIgnoreProblem } from '~/utils/loreIgnore'

/**
 * Turn an existing local project folder into a Lore repository (`lore_init`): a server (or this computer
 * only), the repository's name and, when the folder has none, a `.loreignore` made from its `.gitignore`
 * and Unity VCS's `ignore.conf` (or a Unity template), shown to edit or leave out before it is written.
 * Its files stay as they are and show as new changes. Opened through `lore.initFor`.
 */
const { t } = useI18n()
const ws = useWorkspace()
const lore = useLore()
const git = useGit()

const target = computed(() => lore.initFor)
const open = computed(() => !!target.value)

const info = ref<LoreInitInfo | null>(null)
const infoError = ref<string | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)
const touched = ref(false)

const OFFLINE = 'offline'
const loreChoice = ref<string>(OFFLINE)
const repoName = ref('')
const repoEdited = ref(false)

const writeIgnore = ref(false)
const ignoreText = ref('')

function errorText(e: unknown): string {
  if (typeof e === 'string') return e
  if (e instanceof Error) return e.message
  try { return JSON.stringify(e) } catch { return String(e) }
}

watch(target, async (now) => {
  if (!now) return
  info.value = null
  infoError.value = null
  busy.value = false
  error.value = null
  touched.value = false
  repoName.value = loreRepoNameFrom(now.name)
  repoEdited.value = false
  writeIgnore.value = false
  ignoreText.value = ''
  void lore.loadCli()
  void lore.loadServers().then((list) => {
    if (!list.some(s => s.id === loreChoice.value)) loreChoice.value = list[0]?.id ?? OFFLINE
  })
  try {
    const read = await call('lore_init_info', { path: now.path })
    if (lore.initFor !== now) return
    info.value = read
    if (!read.loreignore) {
      ignoreText.value = loreIgnoreFrom({
        gitignore: read.gitignore,
        plasticIgnore: read.plasticIgnore,
        git: read.gitHere,
        plastic: read.plasticHere,
        unity: read.unity,
      })
      writeIgnore.value = !!ignoreText.value
    }
  } catch (e) {
    if (lore.initFor === now) infoError.value = errorText(e).replace(/\.$/, '')
  }
}, { immediate: true })

/* ---------- where the folder stands now ---------- */

/** Already Lore, here or above: nothing to do. */
const already = computed(() => (info.value?.vcs === 'lore' ? info.value.vcsRoot : null))
const notice = computed<{ tone: 'warn' | 'info'; text: string } | null>(() => {
  const i = info.value
  if (!i || already.value) return null
  if (i.gitHere) return { tone: 'warn', text: t('project.loreInit.gitHere') }
  if (i.plasticHere) return { tone: 'info', text: t('project.loreInit.plasticHere') }
  if (i.vcs === 'git' && i.vcsRoot) return { tone: 'info', text: t('project.loreInit.insideGit', { root: i.vcsRoot }) }
  if (i.vcs === 'plastic' && i.vcsRoot) return { tone: 'info', text: t('project.loreInit.insidePlastic', { root: i.vcsRoot }) }
  return null
})

/* ---------- server and name ---------- */

const loreServer = computed(() => lore.servers?.find(s => s.id === loreChoice.value) ?? null)
const loreUrl = computed(() => (loreServer.value ? loreUrlFor(loreServer.value, null) : null))
const repoError = computed(() => loreRepoNameProblem(repoName.value))
const loreServerLabel = computed(() => (loreChoice.value === OFFLINE ? t('project.loreInit.offline') : loreServer.value?.name ?? t('project.new.loreChoose')))

const loreItems = computed<MenuItem[]>(() => [
  ...(lore.servers ?? []).map(s => ({
    label: s.name,
    hint: s.url,
    hintMono: true,
    check: 'radio' as const,
    checked: s.id === loreChoice.value,
    onSelect: () => { loreChoice.value = s.id },
  })),
  {
    label: t('project.loreInit.offline'),
    divider: !!lore.servers?.length,
    check: 'radio' as const,
    checked: loreChoice.value === OFFLINE,
    onSelect: () => { loreChoice.value = OFFLINE },
  },
  { label: t('project.new.loreAddServer'), divider: true, onSelect: openLoreSettings },
])

const cliMissing = computed(() => lore.cli !== null && !lore.cli.installed)
const serverState = computed<{ tone: 'checking' | 'ok' | 'warn' | 'error'; word: string; detail: string | null; signIn?: boolean } | null>(() => {
  const s = loreUrl.value ? lore.checkOf(loreUrl.value) : null
  if (!s || cliMissing.value) return null
  const c = s.check
  if (s.loading && !c) return { tone: 'checking', word: t('lore.state.checking'), detail: null }
  if (!c) return s.error ? { tone: 'error', word: t('lore.state.checkFailed'), detail: s.error } : null
  if (c.reach === 'udp') return { tone: 'warn', word: t('lore.state.udp'), detail: c.message }
  if (c.reach === 'error') return { tone: 'error', word: t('lore.state.error'), detail: c.message }
  if (c.reach !== 'ok') return { tone: 'error', word: t('lore.state.unreachable'), detail: c.message }
  if (c.auth === 'signedOut') return { tone: 'warn', word: t('lore.state.signInNeeded'), detail: null, signIn: true }
  const who = c.auth === 'signedIn' && c.user ? t('lore.state.signedInAs', { user: c.user }) : c.auth === 'notRequired' ? t('lore.state.noSignIn') : null
  return { tone: 'ok', word: t('lore.state.ready'), detail: who }
})

watch([open, loreUrl], ([o, url]) => {
  if (o && url && !lore.checkOf(url)) void lore.check(url)
})

function openLoreSettings() {
  if (busy.value) return
  lore.initFor = null
  ws.openSettings('lore')
}
function signInLore() {
  if (!loreUrl.value) return
  lore.signInAsked = loreUrl.value
  openLoreSettings()
}
function installLore() {
  lore.installAsked = true
  openLoreSettings()
}

/* ---------- the ignore file ---------- */

const ignoreProblem = computed(() => {
  if (!writeIgnore.value) return null
  const p = loreIgnoreProblem(ignoreText.value)
  return p ? t('project.loreInit.ignoreProblem', { line: p.line }) : null
})
const dropped = computed(() => ignoreText.value.split('\n').filter(l => l.startsWith('# Dropped')).length)
const ignoreRows = computed(() => Math.min(12, Math.max(6, ignoreText.value.split('\n').length)))
const ignoreSources = computed(() => {
  const i = info.value
  if (!i) return null
  if (i.plasticIgnore?.trim() && i.gitignore?.trim()) return t('project.loreInit.fromBoth')
  if (i.plasticIgnore?.trim()) return t('project.loreInit.fromPlastic')
  if (i.gitignore?.trim()) return t('project.loreInit.fromGit')
  if (i.unity) return t('project.loreInit.fromUnity')
  return null
})

/* ---------- create ---------- */

const ignoreEl = ref<HTMLTextAreaElement | null>(null)
const repoInput = ref<HTMLInputElement | null>(null)
const errorEl = ref<HTMLElement | null>(null)
watch(error, async (e) => {
  if (!e) return
  await nextTick()
  errorEl.value?.scrollIntoView({ block: 'nearest' })
})

const canCreate = computed(() => !!info.value && !already.value)

function close() {
  if (busy.value) return
  lore.initFor = null
}

async function submit() {
  const at = target.value
  touched.value = true
  error.value = null
  if (!at || !canCreate.value || busy.value) return
  if (repoError.value) {
    repoInput.value?.focus()
    return
  }
  if (ignoreProblem.value) {
    ignoreEl.value?.focus()
    return
  }
  busy.value = true
  try {
    await call('lore_init', {
      path: at.path,
      lore: { server: loreUrl.value, repository: repoName.value.trim() },
      ignore: writeIgnore.value && ignoreText.value.trim() ? ignoreText.value : null,
    })
    lore.initFor = null
    await git.refresh(at.path)
    if (ws.activeProjectPath === at.path) ws.openTool('changes')
  } catch (e) {
    error.value = errorText(e).replace(/\.$/, '')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UiDialog :open="open" :title="t('project.loreInit.title')" :width="520" :dismissible="!busy" @close="close">
    <form v-if="target" id="lore-init-form" class="li" novalidate @submit.prevent="submit">
      <p class="li__intro">
        <i18n-t keypath="project.loreInit.intro" scope="global">
          <template #name><strong class="li__name">{{ target.name }}</strong></template>
        </i18n-t>
      </p>
      <p class="li__path selectable" :title="target.path">{{ target.path }}</p>

      <p v-if="infoError" class="li__error" role="alert">
        <CircleAlert aria-hidden="true" />
        <span class="selectable">{{ t('project.loreInit.readFailed') }} {{ infoError }}.</span>
      </p>
      <p v-else-if="!info" class="li__quiet">{{ t('project.loreInit.reading') }}</p>
      <p v-else-if="already" class="li__notice" role="status">
        <CircleAlert class="li__notice-icon li__notice-icon--info" aria-hidden="true" />
        <span class="li__notice-text">{{ already === target.path ? t('project.loreInit.already') : t('project.loreInit.insideLore', { root: already }) }}</span>
      </p>

      <template v-if="info && !already">
        <p v-if="notice" class="li__notice" role="note">
          <TriangleAlert v-if="notice.tone === 'warn'" class="li__notice-icon li__notice-icon--warn" aria-hidden="true" />
          <CircleAlert v-else class="li__notice-icon li__notice-icon--info" aria-hidden="true" />
          <span class="li__notice-text">{{ notice.text }}</span>
        </p>

        <p v-if="cliMissing" class="li__notice" role="status">
          <CircleAlert class="li__notice-icon li__notice-icon--warn" aria-hidden="true" />
          <span class="li__notice-text">{{ t('project.new.loreNoCli') }}</span>
          <UiButton size="sm" :disabled="busy" @click="installLore">{{ t('project.new.loreInstall') }}</UiButton>
        </p>

        <UiField :label="t('project.new.loreServer')" for="li-server">
          <UiMenu :items="loreItems" :width="320" :label="t('project.new.loreServer')">
            <template #default="{ toggle, open: menuOpen }">
              <button
                id="li-server"
                type="button"
                class="li__select"
                :class="{ 'is-open': menuOpen }"
                aria-haspopup="menu"
                :aria-expanded="menuOpen"
                :disabled="busy"
                @click="toggle"
              >
                <span class="li__select-label">{{ loreServerLabel }}</span>
                <code v-if="loreUrl" class="li__select-sub">{{ loreUrl }}</code>
                <ChevronDown class="li__select-chev" aria-hidden="true" />
              </button>
            </template>
          </UiMenu>
        </UiField>
        <p v-if="loreChoice === OFFLINE" class="li__hint">{{ t('project.loreInit.offlineHint') }}</p>
        <p v-else-if="serverState" class="li__state" :class="`li__state--${serverState.tone}`" role="status">
          <span class="li__state-lead" aria-hidden="true">
            <span v-if="serverState.tone === 'checking'" class="li__ring" />
            <CircleCheck v-else-if="serverState.tone === 'ok'" />
            <CircleAlert v-else-if="serverState.tone === 'warn'" />
            <TriangleAlert v-else />
          </span>
          <span class="li__state-text">
            <span class="li__state-word">{{ serverState.word }}</span>
            <span v-if="serverState.detail" class="li__state-detail selectable">{{ serverState.detail }}</span>
          </span>
          <button v-if="serverState.signIn" type="button" class="li__link" :disabled="busy" @click="signInLore">{{ t('project.new.loreSignIn') }}</button>
          <button v-else-if="serverState.tone !== 'ok' && serverState.tone !== 'checking' && loreUrl" type="button" class="li__link" :disabled="busy" @click="lore.check(loreUrl)">{{ t('project.new.loreCheck') }}</button>
        </p>

        <UiField
          class="li__gap"
          :label="t('project.new.loreRepo')"
          for="li-repo"
          :error="touched || repoEdited ? repoError : null"
          :hint="loreUrl && !repoError ? t('project.new.loreRepoHint', { url: `${loreUrl}/${repoName.trim()}` }) : undefined"
        >
          <input
            id="li-repo"
            ref="repoInput"
            v-model="repoName"
            class="input li__mono"
            type="text"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            :disabled="busy"
            :aria-invalid="!!((touched || repoEdited) && repoError) || undefined"
            @input="repoEdited = true"
          >
        </UiField>

        <div class="li__ignore">
          <span class="li__label">{{ t('project.loreInit.ignore') }}</span>
          <p v-if="info.loreignore" class="li__hint">
            <i18n-t keypath="project.loreInit.ignoreKept" scope="global"><template #file><code>.loreignore</code></template></i18n-t>
          </p>
          <template v-else>
            <label class="li__check-row">
              <input v-model="writeIgnore" type="checkbox" class="li__check" :disabled="busy">
              <i18n-t keypath="project.loreInit.ignoreWrite" tag="span" scope="global"><template #file><code>.loreignore</code></template></i18n-t>
            </label>
            <template v-if="writeIgnore">
              <textarea
                ref="ignoreEl"
                v-model="ignoreText"
                :rows="ignoreRows"
                class="li__text"
                :class="{ 'has-error': !!ignoreProblem }"
                :aria-label="t('project.loreInit.ignoreLabel')"
                :aria-invalid="!!ignoreProblem || undefined"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                wrap="off"
                :disabled="busy"
                placeholder="/Build/"
              />
              <p v-if="ignoreProblem" class="li__msg li__msg--error" role="alert">{{ ignoreProblem }}</p>
              <p v-else class="li__hint">
                {{ ignoreSources ? `${ignoreSources} ` : '' }}{{ t('project.loreInit.ignoreHint') }}<template v-if="dropped">{{ ' ' }}{{ t('project.loreInit.ignoreDropped', dropped) }}</template>
              </p>
            </template>
            <p v-else class="li__hint">{{ ignoreText ? t('project.loreInit.ignoreSkipped') : t('project.loreInit.ignoreNone') }}</p>
          </template>
        </div>
      </template>

      <p v-if="error" ref="errorEl" class="li__error" role="alert">
        <CircleAlert aria-hidden="true" />
        <span class="selectable">{{ t('project.loreInit.failed') }} {{ error }}.</span>
      </p>
    </form>

    <template #footer>
      <UiButton variant="ghost" :disabled="busy" @click="close">{{ already ? t('common.actions.close') : t('common.actions.cancel') }}</UiButton>
      <UiButton v-if="!already" variant="primary" type="submit" form="lore-init-form" :loading="busy" :disabled="!canCreate">
        {{ busy ? t('project.new.creating') : t('project.loreInit.create') }}
      </UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.li { display: grid; }
.li .input.li__mono { font-family: var(--font-mono); font-size: var(--text-xs); }
.li .input:disabled { color: var(--fg-muted); cursor: default; }

.li__intro { margin: 0; font-size: var(--text-sm); line-height: var(--leading-normal); color: var(--fg-muted); text-wrap: pretty; }
.li__name { font-weight: 560; color: var(--fg); overflow-wrap: anywhere; }
.li__path {
  margin: var(--space-1) 0 var(--space-4);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.li__quiet { margin: 0; font-size: var(--text-xs); color: var(--fg-subtle); }

.li__label { font-size: var(--text-xs); font-weight: 560; color: var(--fg-muted); }
.li__hint { margin: 6px 0 0; font-size: var(--text-xs); line-height: var(--leading-tight); color: var(--fg-subtle); text-wrap: pretty; }
.li__hint code, .li__check-row code { font-size: var(--text-2xs); color: var(--fg-muted); }
.li__gap { margin-top: var(--space-4); }

.li__link {
  display: inline;
  padding: 0;
  font: inherit;
  font-weight: 560;
  color: var(--accent-ink);
  white-space: nowrap;
  border-radius: var(--radius-xs);
}
.li__link:hover:not(:disabled) { text-decoration: underline; text-underline-offset: 3px; }
.li__link:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }

.li__select {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
  height: 32px;
  padding: 0 var(--space-2) 0 var(--space-3);
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  color: var(--fg);
  font-size: var(--text-sm);
  white-space: nowrap;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.li__select:hover:not(:disabled), .li__select.is-open { border-color: var(--line-strong); }
.li__select:focus-visible { outline: none; border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.li__select:disabled { opacity: 0.55; }
.li__select-label { flex: none; max-width: 50%; overflow: hidden; text-overflow: ellipsis; }
.li__select-sub { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: var(--text-xs); color: var(--fg-subtle); }
.li__select-chev { flex: none; width: 14px; height: 14px; margin-left: auto; color: var(--fg-subtle); }

.li__state {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 6px 0 0;
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}
.li__state-lead { flex: none; display: inline-grid; place-items: center; width: 14px; height: 18px; }
.li__state-lead :deep(svg) { width: 14px; height: 14px; stroke-width: 1.85; }
.li__state--ok .li__state-lead { color: var(--ripe-queued); }
.li__state--warn .li__state-lead { color: var(--ripe-waiting); }
.li__state--error .li__state-lead { color: var(--ripe-error); }
.li__state-text { flex: 1; min-width: 0; text-wrap: pretty; }
.li__state-word { font-weight: 560; color: var(--fg-muted); margin-right: var(--space-2); }
.li__state--ok .li__state-word { color: var(--ripe-queued-fg); }
.li__state--warn .li__state-word { color: var(--ripe-waiting-fg); }
.li__state--error .li__state-word { color: var(--ripe-error-fg); }
.li__state-detail { color: var(--fg-muted); }
.li__ring {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 1.75px solid var(--fg-subtle);
  border-right-color: transparent;
  animation: li-turn 0.7s linear infinite;
}
@keyframes li-turn { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .li__ring { animation-duration: 2s; } }

.li__notice {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0 0 var(--space-4);
  padding: var(--space-2) var(--space-3);
  background: var(--bg-inset);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--fg);
}
.li__notice-icon { flex: none; width: 14px; height: 14px; margin-top: 2px; stroke-width: 1.85; }
.li__notice-icon--warn { color: var(--ripe-waiting); }
.li__notice-icon--info { color: var(--fg-subtle); }
.li__notice-text { flex: 1; min-width: 0; text-wrap: pretty; overflow-wrap: anywhere; }

.li__ignore { display: grid; margin-top: var(--space-5); }
.li__check-row {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
  justify-self: start;
  font-size: var(--text-sm);
  color: var(--fg);
  cursor: pointer;
}
.li__check {
  appearance: none;
  flex: none;
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  margin: 0;
  background: var(--bg-inset);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-xs);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.li__check::after {
  content: '';
  width: 7px;
  height: 4px;
  margin-top: -2px;
  border: solid var(--accent-fg);
  border-width: 0 0 1.75px 1.75px;
  rotate: -45deg;
  opacity: 0;
}
.li__check:checked { background: var(--accent); border-color: var(--accent); }
.li__check:checked::after { opacity: 1; }
.li__check:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.li__check:disabled { opacity: 0.55; cursor: default; }

.li__text {
  display: block;
  width: 100%;
  margin-top: var(--space-2);
  padding: var(--space-2) var(--space-3);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.6;
  color: var(--fg);
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  resize: vertical;
  overflow: auto;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.li__text::placeholder { color: var(--fg-faint); }
.li__text:focus-visible { outline: none; }
.li__text:focus { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.li__text.has-error { border-color: var(--ripe-error); }
.li__text:disabled { color: var(--fg-muted); }
.li__msg { margin: 6px 0 0; font-size: var(--text-xs); line-height: var(--leading-tight); }
.li__msg--error { color: var(--ripe-error-fg); }

.li__error {
  display: flex;
  gap: var(--space-2);
  margin: var(--space-4) 0 0;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--fg);
}
.li__error :deep(svg) { width: 15px; height: 15px; margin-top: 2px; flex: none; color: var(--ripe-error); }
</style>
