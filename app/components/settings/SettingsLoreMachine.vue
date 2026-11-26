<script setup lang="ts">
import { CircleAlert, Container, Layers, Server } from 'lucide-vue-next'
import type { LoreMachine, LoreMachineProbe, LoreMachineRuntime } from '~/types/ipc'
import { call, isTauri, pickFiles } from '~/composables/useBackend'
import { useLore } from '~/stores/lore'
import { useEnvironments } from '~/stores/environments'
import { normalizeLoreServer } from '~/utils/lore'
import { ALL_V4, LORE_PORT, defaultLoreAddress, validListenAddress, validPublishPort } from '~/utils/lorePublish'
import { clientUrl, machineHost, validSshDest } from '~/utils/loreMachine'
import EnvLorePublishFields from '~/components/envs/EnvLorePublishFields.vue'
import EnvTerminal from '~/components/envs/EnvTerminal.vue'
import SettingsSegmented from './SettingsSegmented.vue'

/**
 * Settings > Lore > Set up a server: a Lore server on a machine over SSH, without Incus. In Docker
 * (Epic's image) when the machine has it, otherwise as a systemd service; on the address and port
 * picked here. The setup runs in a terminal in this dialog, where ssh asks for a password and sudo
 * for its own, so Mango never handles either (`lore_machine_run`). With keys, Mango first looks at
 * the machine (`lore_machine_probe`): what it has, its addresses, and whether it runs Incus, which
 * makes it an Environments server instead. Also opened from a set-up server's row to change it.
 */
const { t } = useI18n()
const lore = useLore()
const envs = useEnvironments()

const open = computed(() => !!lore.machineDialog)
const editing = computed(() => lore.machineDialog?.server ?? null)

type Auth = 'keys' | 'keyFile' | 'password'
const ssh = ref('')
const sshPort = ref('')
const auth = ref<Auth>('keys')
const identityFile = ref('')
const runtime = ref<LoreMachineRuntime>('auto')
const address = ref(ALL_V4)
const port = ref(String(LORE_PORT))
const name = ref('')
const url = ref('')
/** The user typed a name or an address for clients: they stop following the machine. */
const nameEdited = ref(false)
const urlEdited = ref(false)
const touched = ref(false)
const addressTouched = ref(false)

type Phase = 'form' | 'running' | 'saving' | 'done' | 'failed'
const phase = ref<Phase>('form')
const notice = ref<string | null>(null)
const running = ref<LoreMachine | null>(null)
/** The last look at the machine (`look`), or why it failed. */
const probe = ref<LoreMachineProbe | null>(null)
const probeError = ref<string | null>(null)

/* ---------- opening ---------- */

// Each request to open it (a new object) starts from its own values, even one made while it is open.
watch(() => lore.machineDialog, (d) => {
  if (!d) return
  const m = editing.value?.machine ?? null
  ssh.value = m?.ssh ?? ''
  sshPort.value = m?.port ? String(m.port) : ''
  auth.value = m?.password ? 'password' : m?.identityFile ? 'keyFile' : 'keys'
  identityFile.value = m?.identityFile ?? ''
  runtime.value = m?.runtime ?? 'auto'
  address.value = m ? m.address.replace(/^\[(.*)\]$/, '$1') : ALL_V4
  port.value = String(m?.listenPort ?? LORE_PORT)
  name.value = editing.value?.name ?? ''
  url.value = editing.value?.url ?? ''
  nameEdited.value = !!editing.value
  urlEdited.value = !!editing.value
  touched.value = false
  addressTouched.value = !!m
  phase.value = 'form'
  notice.value = null
  running.value = null
  probe.value = null
  probeError.value = null
}, { immediate: true })

/* ---------- the machine ---------- */

const authOptions = computed(() => [
  { value: 'keys' as const, label: t('lore.machine.authKeys') },
  { value: 'keyFile' as const, label: t('lore.machine.authKeyFile') },
  { value: 'password' as const, label: t('lore.machine.authPassword') },
])
const canBrowse = isTauri()
async function browseKey() {
  const [file] = await pickFiles(t('envs.host.chooseKey'))
  if (file) identityFile.value = file
}

const host = computed(() => machineHost(ssh.value))
watch(host, (h) => {
  if (!nameEdited.value) name.value = h ? t('lore.machine.defaultName', { host: h }) : ''
}, { immediate: true })

const sshError = computed(() => {
  if (!ssh.value.trim()) return t('envs.host.sshEmpty')
  return validSshDest(ssh.value) ? null : t('envs.host.sshInvalid')
})
const sshPortError = computed(() => {
  const p = sshPort.value.trim()
  if (!p) return null
  return /^\d{1,5}$/.test(p) && Number(p) >= 1 && Number(p) <= 65535 ? null : t('lore.machine.sshPortInvalid')
})
const keyError = computed(() => (auth.value === 'keyFile' && !identityFile.value.trim() ? t('lore.machine.keyMissing') : null))
const accessInvalid = computed(() => !!(sshError.value || sshPortError.value || keyError.value))

/* ---------- a look at it (keys only) ---------- */

const probing = ref(false)
/** The access the probe answered for: changing it makes the answer stale. */
const probedFor = ref('')
const accessKey = computed(() => [ssh.value.trim(), sshPort.value.trim(), auth.value, identityFile.value.trim()].join('\n'))
watch(accessKey, (k) => { if (probe.value && k !== probedFor.value) probe.value = null })

async function look() {
  touched.value = true
  if (accessInvalid.value || auth.value === 'password' || probing.value) return
  probing.value = true
  probeError.value = null
  const key = accessKey.value
  try {
    const p = await lore.probeMachine({
      ssh: ssh.value.trim(),
      port: sshPort.value.trim() ? Number(sshPort.value) : null,
      identityFile: auth.value === 'keyFile' ? identityFile.value.trim() : null,
    })
    if (accessKey.value !== key) return
    probe.value = p
    probedFor.value = key
    if (!addressTouched.value) address.value = defaultLoreAddress(p.addresses)
    if (!editing.value) runtime.value = p.installed ?? (dockerOk(p) ? 'docker' : 'service')
  } catch (e) {
    probeError.value = (e instanceof Error ? e.message : String(e)).trim()
  } finally {
    probing.value = false
  }
}

function dockerOk(p: LoreMachineProbe) {
  return p.docker && p.dockerImage
}

/** What the look found, as one line. */
const found = computed(() => {
  const p = probe.value
  if (!p) return ''
  const has = [
    p.docker ? (p.dockerImage ? t('lore.machine.hasDocker') : t('lore.machine.hasDockerArch', { arch: p.arch })) : null,
    p.incus ? 'Incus' : null,
    p.systemd ? 'systemd' : null,
  ].filter(Boolean).join(', ')
  return [p.os || p.arch, has || t('lore.machine.hasNothing'), t(`lore.machine.sudo.${p.sudo}`)].join(' · ')
})

/* ---------- Incus: make it an Environments server instead ---------- */

const movingToEnvs = ref(false)
const envsError = ref<string | null>(null)
async function toEnvironments() {
  if (movingToEnvs.value) return
  movingToEnvs.value = true
  envsError.value = null
  try {
    if (!envs.loaded) await envs.load()
    const dest = ssh.value.trim()
    const p = sshPort.value.trim() ? Number(sshPort.value) : null
    const key = auth.value === 'keyFile' ? identityFile.value.trim() : null
    const known = envs.hosts.find(h => !h.direct && h.ssh === dest && (h.port ?? null) === p)
    const saved = known ?? await envs.saveHost({ id: '', name: host.value, ssh: dest, port: p, identityFile: key, incusRemote: null, tailscale: null })
    lore.machineDialog = null
    envs.select(saved.id)
    envs.dialog = { kind: 'create', hostId: saved.id, preset: 'lore-server' }
    envs.openView()
  } catch (e) {
    envsError.value = e instanceof Error ? e.message : String(e)
  } finally {
    movingToEnvs.value = false
  }
}

/* ---------- how it runs, where it listens ---------- */

const runtimeOptions = computed(() => {
  const p = probe.value
  const dockerWhy = !p ? undefined
    : !p.docker ? t('lore.machine.noDocker')
      : !p.dockerImage ? t('lore.machine.dockerArch', { arch: p.arch })
        : undefined
  const serviceWhy = p && !p.systemd ? t('lore.machine.noSystemd') : undefined
  return [
    ...(p ? [] : [{ value: 'auto' as const, label: t('lore.machine.runAuto') }]),
    { value: 'docker' as const, label: t('lore.machine.runDocker'), icon: Container, disabled: !!dockerWhy, title: dockerWhy },
    { value: 'service' as const, label: t('lore.machine.runService'), icon: Layers, disabled: !!serviceWhy, title: serviceWhy },
  ]
})
watch(probe, (p) => { if (p && runtime.value === 'auto') runtime.value = dockerOk(p) ? 'docker' : 'service' })

const runtimeHint = computed(() => {
  if (runtime.value === 'docker') return t('lore.machine.dockerHint')
  if (runtime.value === 'service') return t('lore.machine.serviceHint')
  return t('lore.machine.autoHint')
})

const listenPort = computed(() => Number(port.value.trim()))
const suggestedUrl = computed(() => (host.value && validListenAddress(address.value) && validPublishPort(port.value)
  ? clientUrl({ ssh: ssh.value, address: address.value, listenPort: listenPort.value })
  : ''))
watch(suggestedUrl, (u) => { if (!urlEdited.value) url.value = u }, { immediate: true })
watch(address, (_a, before) => { if (before !== undefined) addressTouched.value = true })

const urlError = computed(() => {
  if (!url.value.trim()) return t('lore.servers.urlMissing')
  if (!normalizeLoreServer(url.value)) return t('lore.servers.urlBad')
  const taken = (lore.servers ?? []).find(s => s.url === normalizeLoreServer(url.value) && s.id !== editing.value?.id)
  return taken ? t('lore.servers.urlTaken', { name: taken.name }) : null
})
const listenInvalid = computed(() => !validListenAddress(address.value) || !validPublishPort(port.value))
const invalid = computed(() => accessInvalid.value || listenInvalid.value || !!urlError.value)

/* ---------- run ---------- */

function machine(): LoreMachine {
  return {
    ssh: ssh.value.trim(),
    port: sshPort.value.trim() ? Number(sshPort.value) : null,
    identityFile: auth.value === 'keyFile' ? identityFile.value.trim() : null,
    password: auth.value === 'password',
    runtime: runtime.value,
    address: address.value.trim(),
    listenPort: listenPort.value,
  }
}

function submit() {
  touched.value = true
  notice.value = null
  if (invalid.value || phase.value !== 'form') return
  running.value = machine()
  phase.value = 'running'
}

const start = (cols: number, rows: number) => call('lore_machine_run', { machine: running.value!, action: 'setup', cols, rows })

async function onExit(code: number | null) {
  if (code !== 0) {
    phase.value = 'failed'
    return
  }
  phase.value = 'saving'
  try {
    const saved = await lore.upsert({
      id: editing.value?.id ?? null,
      name: name.value.trim(),
      url: url.value.trim(),
      insideUrl: null,
      origin: null,
      machine: running.value,
    })
    phase.value = 'done'
    if (saved) void lore.check(saved.url)
  } catch (e) {
    phase.value = 'failed'
    notice.value = t('lore.machine.saveFailed', { message: e instanceof Error ? e.message : String(e) })
  }
}

function stop() {
  // Unmounting the terminal ends ssh.
  phase.value = 'form'
  notice.value = t('lore.machine.stopped')
}

function back() {
  phase.value = 'form'
  if (!notice.value) notice.value = t('lore.machine.unfinished')
}

function close() {
  if (phase.value === 'running' || phase.value === 'saving') return
  lore.machineDialog = null
}

const title = computed(() => (editing.value ? t('lore.machine.titleChange', { name: editing.value.name }) : t('lore.machine.title')))
</script>

<template>
  <UiDialog :open="open" :title="title" :width="580" :dismissible="phase === 'form' || phase === 'done' || phase === 'failed'" @close="close">
    <form v-if="phase === 'form'" id="lore-machine-form" class="lm" novalidate @submit.prevent="submit">
      <p class="lm__lede">{{ t('lore.machine.lede') }}</p>

      <div class="lm__row">
        <UiField :label="t('envs.host.ssh')" for="lm-ssh" :error="touched ? sshError : null">
          <input
            id="lm-ssh"
            v-model="ssh"
            class="input lm__mono"
            type="text"
            placeholder="you@build.example.com"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            :disabled="!!editing"
            :aria-invalid="(touched && !!sshError) || undefined"
          >
        </UiField>
        <UiField :label="t('envs.host.port')" for="lm-ssh-port" :error="touched ? sshPortError : null">
          <input id="lm-ssh-port" v-model="sshPort" class="input tabular" type="text" inputmode="numeric" placeholder="22" autocomplete="off" :disabled="!!editing">
        </UiField>
      </div>

      <div class="lm__group">
        <span id="lm-auth-label" class="lm__label">{{ t('lore.machine.auth') }}</span>
        <SettingsSegmented v-model="auth" :options="authOptions" labelledby="lm-auth-label" describedby="lm-auth-hint" />
        <UiField v-if="auth === 'keyFile'" :label="t('envs.host.keyFile')" for="lm-key" :error="touched ? keyError : null">
          <div class="lm__picker">
            <input id="lm-key" v-model="identityFile" class="input lm__mono" type="text" placeholder="~/.ssh/id_ed25519" autocomplete="off" spellcheck="false">
            <UiButton v-if="canBrowse" @click="browseKey">{{ t('envs.host.browse') }}</UiButton>
          </div>
        </UiField>
        <p id="lm-auth-hint" class="lm__hint">
          {{ auth === 'password' ? t('lore.machine.passwordHint') : auth === 'keys' ? t('lore.machine.keysHint') : t('lore.machine.keyFileHint') }}
        </p>
      </div>

      <div v-if="auth !== 'password'" class="lm__look">
        <div class="lm__look-head">
          <UiButton size="sm" :loading="probing" :disabled="probing" @click="look">{{ probe ? t('lore.machine.lookAgain') : t('lore.machine.look') }}</UiButton>
          <span v-if="probe" class="lm__found selectable" role="status">
            <Server aria-hidden="true" />
            <span>{{ found }}</span>
          </span>
          <span v-else-if="!probeError" class="lm__hint lm__hint--inline">{{ t('lore.machine.lookHint') }}</span>
        </div>
        <p v-if="probeError" class="lm__error selectable" role="alert">{{ probeError }}</p>
        <div v-if="probe?.incus" class="lm__incus">
          <p class="lm__incus-text">{{ t('lore.machine.incus', { host }) }}</p>
          <UiButton size="sm" :loading="movingToEnvs" @click="toEnvironments">{{ t('lore.machine.incusAction') }}</UiButton>
          <p v-if="envsError" class="lm__error selectable" role="alert">{{ envsError }}</p>
        </div>
        <p v-if="probe?.installed" class="lm__hint">{{ t(`lore.machine.installed.${probe.installed}`) }}</p>
      </div>
      <p v-else class="lm__hint lm__note">{{ t('lore.machine.passwordIncus') }}</p>

      <fieldset class="lm__section">
        <legend class="lm__label">{{ t('lore.machine.runs') }}</legend>
        <SettingsSegmented v-model="runtime" :options="runtimeOptions" :label="t('lore.machine.runs')" describedby="lm-run-hint" />
        <p id="lm-run-hint" class="lm__hint">{{ runtimeHint }}</p>
      </fieldset>

      <fieldset class="lm__section">
        <legend class="lm__label">{{ t('lore.machine.listens') }}</legend>
        <EnvLorePublishFields
          v-model:address="address"
          v-model:port="port"
          id-prefix="lm-listen"
          :addresses="probe?.addresses ?? []"
          :note="probe ? null : t('lore.machine.noAddresses')"
          :touched="touched"
        />
        <p class="lm__hint">{{ t('lore.machine.listensHint', { port: port || LORE_PORT }) }}</p>
      </fieldset>

      <fieldset class="lm__section">
        <legend class="lm__label">{{ t('lore.machine.entry') }}</legend>
        <div class="lm__row lm__row--even">
          <UiField :label="t('lore.servers.name')" for="lm-name">
            <input id="lm-name" v-model="name" class="input" type="text" autocomplete="off" spellcheck="false" @input="nameEdited = true">
          </UiField>
          <UiField :label="t('lore.machine.clientUrl')" for="lm-url" :error="touched ? urlError : null">
            <input id="lm-url" v-model="url" class="input lm__mono" type="text" placeholder="lore://build.example.com" autocomplete="off" spellcheck="false" @input="urlEdited = true">
          </UiField>
        </div>
        <p class="lm__hint">{{ t('lore.machine.clientUrlHint') }}</p>
      </fieldset>

      <p v-if="notice" class="lm__notice" role="status">
        <CircleAlert aria-hidden="true" />
        <span>{{ notice }}</span>
      </p>
    </form>

    <div v-else class="lm__run">
      <EnvTerminal
        :start="start"
        :title="t('lore.machine.running', { host })"
        :done-title="t('lore.machine.done', { host })"
        :failed-title="t('lore.machine.failed')"
        :label="t('lore.machine.terminal', { host })"
        :rows="14"
        flat
        :closable="false"
        :retryable="false"
        @exit="onExit"
      >
        <template #hint>{{ running?.password ? t('lore.machine.runHintPassword') : t('lore.machine.runHint') }}</template>
      </EnvTerminal>
      <p v-if="phase === 'failed' && notice" class="lm__error selectable" role="alert">{{ notice }}</p>
      <p v-if="phase === 'done'" class="lm__hint">{{ t('lore.machine.doneHint') }}</p>
    </div>

    <template #footer>
      <template v-if="phase === 'form'">
        <UiButton variant="ghost" @click="close">{{ t('common.actions.cancel') }}</UiButton>
        <UiButton variant="primary" type="submit" form="lore-machine-form">{{ editing ? t('lore.machine.submitChange') : t('lore.machine.submit') }}</UiButton>
      </template>
      <UiButton v-else-if="phase === 'running'" variant="ghost" @click="stop">{{ t('envs.common.stop') }}</UiButton>
      <template v-else-if="phase === 'failed'">
        <UiButton variant="ghost" @click="close">{{ t('common.actions.close') }}</UiButton>
        <UiButton @click="back">{{ t('lore.machine.back') }}</UiButton>
      </template>
      <UiButton v-else-if="phase === 'done'" variant="primary" data-autofocus @click="close">{{ t('common.actions.done') }}</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.lm { display: grid; border: 0; }
.lm__mono { font-family: var(--font-mono); }
.lm .input.lm__mono { font-size: var(--text-xs); }
.lm__lede { margin: 0 0 var(--space-4); max-width: 62ch; font-size: var(--text-sm); color: var(--fg-muted); text-wrap: pretty; }
.lm__label { padding: 0; font-size: var(--text-xs); font-weight: 560; color: var(--fg-muted); }
.lm__hint { margin: 0; max-width: 62ch; font-size: var(--text-xs); line-height: var(--leading-tight); color: var(--fg-subtle); text-wrap: pretty; }
.lm__hint--inline { align-self: center; }
.lm__note { margin-top: var(--space-3); }
.lm__error { margin: 0; font-size: var(--text-xs); color: var(--ripe-error-fg); text-wrap: pretty; white-space: pre-line; }

.lm__row { display: grid; grid-template-columns: 1fr 96px; gap: var(--space-3); align-items: start; }
.lm__row--even { grid-template-columns: 1fr 1fr; }
.lm__row :deep(.field + .field) { margin-top: 0; }
.lm__group { display: grid; gap: 6px; margin-top: var(--space-4); justify-items: start; }
.lm__group :deep(.field) { width: 100%; margin-top: var(--space-1); }
.lm__picker { display: flex; gap: var(--space-2); }

.lm__look { display: grid; gap: var(--space-2); margin-top: var(--space-4); }
.lm__look-head { display: flex; align-items: center; gap: var(--space-3); min-height: 28px; min-width: 0; }
.lm__found { display: inline-flex; align-items: center; gap: 6px; min-width: 0; font-size: var(--text-xs); color: var(--fg-muted); }
.lm__found svg { flex: none; width: 13px; height: 13px; color: var(--fg-subtle); }
.lm__found span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lm__incus {
  display: grid;
  justify-items: start;
  gap: var(--space-2);
  padding: var(--space-3);
  background: var(--bg-raised);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
}
.lm__incus-text { margin: 0; max-width: 62ch; font-size: var(--text-xs); color: var(--fg); text-wrap: pretty; }

.lm__section {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
  margin: var(--space-5) 0 0;
  padding: var(--space-4) 0 0;
  border: 0;
  border-top: 1px solid var(--line-soft);
}
.lm__section :deep(.seg) { justify-self: start; }
.lm__section legend { float: left; width: 100%; margin-bottom: var(--space-1); }
.lm__section .lm__row { width: 100%; }

.lm__notice {
  display: flex;
  gap: var(--space-2);
  margin: var(--space-4) 0 0;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--ripe-waiting);
}
.lm__notice :deep(svg) { width: 15px; height: 15px; margin-top: 2px; flex: none; }
.lm__notice span { color: var(--fg); }

.lm__run { display: grid; gap: var(--space-3); padding-top: var(--space-2); }
</style>
