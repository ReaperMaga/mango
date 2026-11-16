<script setup lang="ts">
import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-vue-next'
import { isTauri, pickFiles } from '~/composables/useBackend'
import { useEnvironments } from '~/stores/environments'
import type { EnvHost } from '~/types/ipc'

/**
 * Add or edit a master server: how to reach it over SSH, which Incus remote
 * holds the instances, and whether instances join a tailnet. "Save and check"
 * saves and probes it, so the remotes the server knows can be offered.
 */
const envs = useEnvironments()

const open = computed(() => envs.dialog?.kind === 'host')
/** '' while adding; the id once saved (also after "Save and check"). */
const hostId = ref('')
const editing = computed(() => !!hostId.value)
/** Opened to add a server (it may already be saved by "Save and check"). */
const adding = ref(true)

const name = ref('')
const ssh = ref('')
const port = ref('')
const identityFile = ref('')
const incusRemote = ref('')
const tsOn = ref(false)
const tsTags = ref('')
const tsKeyFile = ref('')

const touched = ref(false)
const busy = ref<null | 'save' | 'check'>(null)
type Field = 'name' | 'ssh' | 'port' | 'identityFile' | 'incusRemote' | 'tags' | 'authKeyFile' | 'general'
const serverError = ref<{ field: Field; message: string } | null>(null)
const canBrowse = isTauri()

const probe = computed(() => (hostId.value ? envs.probes[hostId.value] ?? null : null))
const probing = computed(() => !!hostId.value && !!envs.probing[hostId.value])

watch(open, (isOpen) => {
  if (!isOpen) return
  const id = envs.dialog?.kind === 'host' ? envs.dialog.id : ''
  const h = id ? envs.host(id) : null
  hostId.value = h?.id ?? ''
  adding.value = !h
  name.value = h?.name ?? ''
  ssh.value = h?.ssh ?? ''
  port.value = h?.port ? String(h.port) : ''
  identityFile.value = h?.identityFile ?? ''
  incusRemote.value = h?.incusRemote ?? ''
  tsOn.value = !!h?.tailscale
  tsTags.value = h?.tailscale?.tags.join(' ') ?? 'tag:mango'
  tsKeyFile.value = h?.tailscale?.authKeyFile ?? ''
  touched.value = false
  busy.value = null
  serverError.value = null
})

/* ---------- checks the backend also makes, so most mistakes show before a round trip ---------- */

const tags = computed(() => tsTags.value.split(/[\s,]+/).map(t => t.trim()).filter(Boolean))

const sshError = computed(() => {
  const s = ssh.value.trim()
  if (!s) return 'Enter user@host, or a host name from ~/.ssh/config.'
  if (s.startsWith('-') || !/^[\w.@%+:-]+$/.test(s)) return 'Use user@host or a name from ~/.ssh/config, without spaces.'
  return null
})
const portError = computed(() => {
  const p = port.value.trim()
  if (!p) return null
  const n = Number(p)
  return Number.isInteger(n) && n > 0 && n < 65536 ? null : 'A port is a number from 1 to 65535.'
})
const tagsError = computed(() => {
  if (!tsOn.value) return null
  const bad = tags.value.find(t => !/^tag:[a-z0-9][a-z0-9-]{0,59}$/.test(t))
  return bad ? `"${bad}" is not a Tailscale tag. Tags look like tag:mango (lower case, digits and dashes).` : null
})
const keyFileError = computed(() => {
  const p = tsKeyFile.value.trim()
  if (!tsOn.value || !p) return null
  return /^(\/|~\/)/.test(p) && !p.split('/').includes('..') ? null : 'Use a path on the server: /abs/path or ~/path.'
})

const clientError = computed(() => sshError.value ?? portError.value ?? tagsError.value ?? keyFileError.value)

function errorFor(field: Field): string | null {
  if (serverError.value?.field === field) return serverError.value.message
  if (!touched.value) return null
  if (field === 'ssh') return sshError.value
  if (field === 'port') return portError.value
  if (field === 'tags') return tagsError.value
  if (field === 'authKeyFile') return keyFileError.value
  return null
}

/** The backend refuses with one sentence; put it under the field it is about. */
function fieldOf(message: string): Field {
  const m = message.toLowerCase()
  if (m.includes('ssh destination')) return 'ssh'
  if (m.includes('key file')) return 'identityFile'
  if (m.includes('incus remote')) return 'incusRemote'
  if (m.includes('tailscale tag')) return 'tags'
  if (m.includes('path on the server')) return 'authKeyFile'
  if (m.includes('name')) return 'name'
  return 'general'
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

function build(): EnvHost {
  return {
    id: hostId.value,
    name: name.value.trim(),
    ssh: ssh.value.trim(),
    port: port.value.trim() ? Number(port.value) : null,
    identityFile: identityFile.value.trim() || null,
    incusRemote: incusRemote.value.trim().replace(/:$/, '') || null,
    tailscale: tsOn.value ? { tags: tags.value, authKeyFile: tsKeyFile.value.trim() || null } : null,
  }
}

async function save(): Promise<boolean> {
  touched.value = true
  serverError.value = null
  if (clientError.value) return false
  try {
    const saved = await envs.saveHost(build())
    hostId.value = saved.id
    return true
  } catch (e) {
    const message = errorText(e)
    serverError.value = { field: fieldOf(message), message }
    return false
  }
}

async function submit() {
  if (busy.value) return
  busy.value = 'save'
  const ok = await save()
  busy.value = null
  if (!ok) return
  const id = hostId.value
  envs.dialog = null
  envs.select(id)
  // Fresh settings: look again.
  envs.probe(id).then((p) => { if (p.ok) envs.refreshInstances(id) })
}

async function check() {
  if (busy.value) return
  busy.value = 'check'
  const ok = await save()
  if (ok) await envs.probe(hostId.value)
  busy.value = null
}

async function browseKey() {
  const [file] = await pickFiles('Choose an SSH private key')
  if (file) identityFile.value = file
}

function close() {
  if (busy.value) return
  envs.dialog = null
}
</script>

<template>
  <UiDialog :open="open" :title="adding ? 'Add server' : 'Edit server'" :width="520" @close="close">
    <form id="env-host-form" class="hf" novalidate @submit.prevent="submit">
      <p class="hf__lede">
        A machine you can reach with <code>ssh</code> that has the <code>incus</code> command. Mango runs each action as one
        SSH command with your own keys and installs nothing of its own there.
      </p>

      <div class="hf__pair">
        <UiField label="SSH destination" for="hf-ssh" :error="errorFor('ssh')">
          <input
            id="hf-ssh"
            v-model="ssh"
            class="input hf__mono"
            type="text"
            placeholder="you@build-box"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            :aria-invalid="!!errorFor('ssh') || undefined"
            @blur="ssh && (touched = true)"
          >
        </UiField>
        <UiField label="Port" for="hf-port" :error="errorFor('port')">
          <input
            id="hf-port"
            v-model="port"
            class="input tabular"
            type="text"
            inputmode="numeric"
            placeholder="22"
            autocomplete="off"
            :aria-invalid="!!errorFor('port') || undefined"
          >
        </UiField>
      </div>
      <p class="hf__hint">user@host, or a host name from <code>~/.ssh/config</code> (its settings apply).</p>

      <UiField label="Name" for="hf-name" hint="How the server is listed. Defaults to the host name." :error="errorFor('name')">
        <input id="hf-name" v-model="name" class="input" type="text" placeholder="Build box" autocomplete="off" spellcheck="false">
      </UiField>

      <UiField
        label="Key file"
        for="hf-key"
        hint="Optional. Leave empty to use your SSH agent and ~/.ssh/config."
        :error="errorFor('identityFile')"
      >
        <div class="hf__picker">
          <input
            id="hf-key"
            v-model="identityFile"
            class="input hf__mono"
            type="text"
            placeholder="~/.ssh/id_ed25519"
            autocomplete="off"
            spellcheck="false"
          >
          <UiButton v-if="canBrowse" @click="browseKey">Browse…</UiButton>
        </div>
      </UiField>

      <UiField
        label="Incus remote"
        for="hf-remote"
        hint="Optional. The remote on the server that holds the instances, such as an IncusOS host. Empty uses its default."
        :error="errorFor('incusRemote')"
      >
        <input
          id="hf-remote"
          v-model="incusRemote"
          class="input hf__mono"
          type="text"
          placeholder="Default"
          autocomplete="off"
          spellcheck="false"
        >
      </UiField>

      <div v-if="probe && !probing" class="hf__probe" role="status">
        <template v-if="probe.ok">
          <p class="hf__probe-line">
            <CircleCheck class="hf__probe-icon hf__probe-icon--ok" aria-hidden="true" />
            <span class="hf__probe-word hf__probe-word--ok">Connected</span>
            <span v-if="probe.incusVersion" class="hf__probe-more">Incus {{ probe.incusVersion }}</span>
          </p>
          <div v-if="probe.remotes.length" class="hf__remotes" role="group" aria-label="Remotes on this server">
            <span class="hf__remotes-label">Remotes on this server</span>
            <button
              v-for="r in probe.remotes"
              :key="r"
              type="button"
              class="hf__remote"
              :aria-pressed="incusRemote.trim() === r"
              @click="incusRemote = r"
            >
              {{ r }}
            </button>
          </div>
        </template>
        <p v-else class="hf__probe-line hf__probe-line--bad">
          <TriangleAlert class="hf__probe-icon hf__probe-icon--bad" aria-hidden="true" />
          <span class="selectable">{{ probe.error ?? 'The server did not answer.' }}</span>
        </p>
      </div>

      <div class="hf__ts">
        <div class="hf__switch-row">
          <span class="hf__switch-text">
            <span id="hf-ts-label" class="hf__switch-label">Tailscale</span>
            <span class="hf__switch-hint">Instances with the Tailscale component join your tailnet with these tags.</span>
          </span>
          <button
            type="button"
            class="switch"
            role="switch"
            aria-labelledby="hf-ts-label"
            :aria-checked="tsOn"
            @click="tsOn = !tsOn"
          >
            <span class="switch__thumb" />
          </button>
        </div>

        <template v-if="tsOn">
          <UiField label="Tags" for="hf-tags" hint="Separate with spaces. Your tailnet's ACLs decide what tagged devices may reach." :error="errorFor('tags')">
            <input id="hf-tags" v-model="tsTags" class="input hf__mono" type="text" placeholder="tag:mango" autocomplete="off" spellcheck="false">
          </UiField>
          <UiField
            label="Auth key file on the server"
            for="hf-tskey"
            hint="Optional. A file on the server holding a Tailscale auth key. It is read there, during install; Mango never reads or stores the key. Leave empty to sign in with a link instead."
            :error="errorFor('authKeyFile')"
          >
            <input
              id="hf-tskey"
              v-model="tsKeyFile"
              class="input hf__mono"
              type="text"
              placeholder="~/.config/tailscale/authkey"
              autocomplete="off"
              spellcheck="false"
            >
          </UiField>
        </template>
      </div>

      <p v-if="serverError?.field === 'general'" class="hf__error" role="alert">
        <CircleAlert aria-hidden="true" />
        <span class="selectable">{{ serverError.message }}</span>
      </p>
    </form>

    <template #footer>
      <UiButton
        class="hf__check"
        :loading="busy === 'check' || probing"
        :disabled="!!busy"
        title="Save the server and test the connection; its Incus remotes are offered above"
        @click="check"
      >
        Save and check
      </UiButton>
      <UiButton variant="ghost" :disabled="!!busy" @click="close">{{ adding && editing ? 'Close' : 'Cancel' }}</UiButton>
      <UiButton variant="primary" type="submit" form="env-host-form" :loading="busy === 'save'" :disabled="busy === 'check'">
        {{ adding ? (editing ? 'Done' : 'Add server') : 'Save' }}
      </UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.hf { display: grid; }
.hf__lede {
  margin: 0 0 var(--space-4);
  font-size: var(--text-sm);
  color: var(--fg-subtle);
  text-wrap: pretty;
}
.hf code, .hf__hint code { font-size: var(--text-2xs); color: var(--fg-muted); }
.hf__mono { font-family: var(--font-mono); }
.hf .input.hf__mono { font-size: var(--text-xs); }

.hf__pair {
  display: grid;
  grid-template-columns: 1fr 88px;
  gap: var(--space-2);
  align-items: start;
}
/* The pair shares one hint below both fields. */
.hf__pair :deep(.field + .field) { margin-top: 0; }
.hf__hint {
  margin: 6px 0 var(--space-4);
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  line-height: var(--leading-tight);
}
.hf__picker { display: flex; gap: var(--space-2); }
/* Checks the whole server, not one field: it leads the footer. */
.hf__check { margin-right: auto; }
.hf__picker .input { flex: 1; min-width: 0; }

/* ---- check result ---- */
.hf__probe {
  display: grid;
  gap: var(--space-2);
  margin-top: var(--space-3);
}
.hf__probe-line {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
}
.hf__probe-line--bad { color: var(--fg); }
.hf__probe-icon { flex: none; width: 14px; height: 14px; margin-top: 2px; stroke-width: 1.85; }
.hf__probe-icon--ok { color: var(--ripe-queued); }
.hf__probe-icon--bad { color: var(--ripe-error); }
.hf__probe-word { font-weight: 560; }
.hf__probe-word--ok { color: var(--ripe-queued-fg); }
.hf__probe-more { color: var(--fg-subtle); }
.hf__remotes { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1); }
.hf__remotes-label { margin-right: var(--space-1); font-size: var(--text-xs); color: var(--fg-subtle); }
.hf__remote {
  height: 22px;
  padding: 0 var(--space-2);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--fg-muted);
  background: var(--bg-hover);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-xs);
  transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.hf__remote:hover { color: var(--fg); border-color: var(--line-strong); }
.hf__remote[aria-pressed='true'] { color: var(--fg); background: var(--bg-active); border-color: var(--line-strong); }

/* ---- tailscale ---- */
.hf__ts {
  display: grid;
  margin-top: var(--space-5);
  padding-top: var(--space-4);
  border-top: 1px solid var(--line-soft);
}
.hf__ts > :deep(.field) { margin-top: var(--space-4); }
.hf__switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}
.hf__switch-text { display: grid; gap: 2px; }
.hf__switch-label { font-size: var(--text-sm); font-weight: 560; color: var(--fg); }
.hf__switch-hint { font-size: var(--text-xs); color: var(--fg-subtle); }

.switch {
  position: relative;
  flex: none;
  width: 30px;
  height: 18px;
  border-radius: var(--radius-pill);
  background: var(--bg-active);
  box-shadow: inset 0 0 0 1px var(--line-strong);
  transition: background var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.switch__thumb {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--fg-muted);
  transition: translate var(--dur-med) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
.switch[aria-checked='true'] { background: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.switch[aria-checked='true'] .switch__thumb { translate: 12px 0; background: var(--accent-fg); }
.switch:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; border-radius: var(--radius-pill); }

.hf__error {
  display: flex;
  gap: var(--space-2);
  margin: var(--space-4) 0 0;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--ripe-error);
}
.hf__error :deep(svg) { width: 15px; height: 15px; margin-top: 2px; flex: none; }
.hf__error span { color: var(--fg); }
</style>
