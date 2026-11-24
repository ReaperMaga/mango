<script lang="ts">
import { reactive } from 'vue'
import type { HostingCli } from '~/types/ipc'

/**
 * What Mango last knew about gh, glab and the GitLab servers. Kept for the life of the window so
 * reopening Settings shows it while the fresh answer comes in.
 */
const state = reactive({
  clis: null as HostingCli[] | null,
  loading: false,
  error: null as string | null,
  hosts: null as string[] | null,
})
let seq = 0
</script>

<script setup lang="ts">
import { Github, Gitlab, X } from 'lucide-vue-next'
import type { HostingToolId } from '~/types/ipc'
import { call } from '~/composables/useBackend'
import { GITHUB_COM, GITLAB_COM, gitlabHostProblem, normalizeHost } from '~/utils/gitHosts'
import SettingsSection from './SettingsSection.vue'
import SettingsHostingRow from './SettingsHostingRow.vue'

/**
 * Settings > Git hosting: the GitHub CLI and the GitLab CLI, which Mango reads pull requests, merge
 * requests, issues, checks, pipelines and releases through, and the self-managed GitLab servers whose
 * projects it treats as GitLab ones.
 */
/** `active`: this section is the one on screen (it stays mounted while Settings is open). */
const props = defineProps<{ active: boolean }>()

const { t } = useI18n()

const TOOLS = computed<Array<{ id: HostingToolId; name: string; icon: typeof Github; defaultHost: string; otherHint: string; otherPlaceholder: string }>>(() => [
  {
    id: 'gh', name: 'GitHub CLI', icon: Github, defaultHost: GITHUB_COM,
    otherHint: t('agents.hosting.ghOther'), otherPlaceholder: 'github.example.com',
  },
  {
    id: 'glab', name: 'GitLab CLI', icon: Gitlab, defaultHost: GITLAB_COM,
    otherHint: t('agents.hosting.glabOther'), otherPlaceholder: 'gitlab.example.com',
  },
])

const cliOf = (id: HostingToolId) => state.clis?.find(c => c.id === id) ?? null

async function loadHosts() {
  try {
    state.hosts = await call('gitlab_hosts', {})
  } catch (err) {
    hostsError.value = err instanceof Error ? err.message : String(err)
  }
}

async function refresh(): Promise<HostingCli[] | null> {
  const n = ++seq
  state.loading = true
  try {
    const clis = await call('hosting_status', {})
    if (n === seq) {
      state.clis = clis
      state.error = null
    }
    // Servers glab is signed in to join the list as the status is read.
    await loadHosts()
    return clis
  } catch (err) {
    if (n === seq) state.error = err instanceof Error ? err.message : String(err)
    return null
  } finally {
    if (n === seq) state.loading = false
  }
}

onMounted(() => { if (props.active) void refresh() })
watch(() => props.active, (on) => { if (on) void refresh() })

/* ---------- GitLab servers ---------- */

const draft = ref('')
const draftError = ref<string | null>(null)
const hostsError = ref<string | null>(null)
const saving = ref(false)
const removing = ref<string | null>(null)
const fieldId = useId()
const hintId = useId()
const listEl = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)

/** Servers glab holds a sign-in for: they would come straight back, so they can't be removed here. */
const glabHosts = computed(() => new Set(cliOf('glab')?.accounts.map(a => a.host) ?? []))

async function add() {
  const list = state.hosts ?? []
  const problem = gitlabHostProblem(draft.value, list)
  if (problem) {
    draftError.value = problem
    return
  }
  saving.value = true
  try {
    state.hosts = await call('gitlab_hosts_save', { hosts: [...list, normalizeHost(draft.value)!] })
    draft.value = ''
    hostsError.value = null
  } catch (err) {
    draftError.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}

async function remove(host: string) {
  if (removing.value) return
  removing.value = host
  try {
    state.hosts = await call('gitlab_hosts_save', { hosts: (state.hosts ?? []).filter(h => h !== host) })
    hostsError.value = null
    await nextTick()
    // The button that had the keyboard is gone: land in the field.
    input.value?.focus()
  } catch (err) {
    hostsError.value = t('agents.hosting.removeFailed', { host, message: err instanceof Error ? err.message : String(err) })
  } finally {
    removing.value = null
  }
}

onMounted(() => { if (!state.hosts) void loadHosts() })
</script>

<template>
  <SettingsSection
    :title="t('settings.nav.hosting')"
    :description="t('agents.hosting.description')"
  >
    <ul class="clis" :aria-label="t('agents.hosting.tools')">
      <SettingsHostingRow
        v-for="tool in TOOLS"
        :key="tool.id"
        :tool="tool.id"
        :name="tool.name"
        :icon="tool.icon"
        :default-host="tool.defaultHost"
        :other-hint="tool.otherHint"
        :other-placeholder="tool.otherPlaceholder"
        :cli="cliOf(tool.id)"
        :loading="state.loading"
        :error="state.error"
        :refresh="refresh"
      />
    </ul>

    <section class="servers" aria-labelledby="hosting-servers">
      <h3 id="hosting-servers" class="servers__title">{{ t('agents.hosting.servers') }}</h3>
      <p class="servers__note">
        <i18n-t keypath="agents.hosting.serversNote" scope="global">
          <template #something><i>{{ t('agents.hosting.something') }}</i></template>
        </i18n-t>
      </p>

      <ul v-if="state.hosts?.length" ref="listEl" class="servers__list" :aria-label="t('agents.hosting.serversLabel')">
        <li v-for="h in state.hosts" :key="h" class="server">
          <Gitlab class="server__mark" aria-hidden="true" />
          <span class="server__host selectable">{{ h }}</span>
          <span v-if="glabHosts.has(h)" class="server__meta">{{ t('agents.hosting.known') }}</span>
          <UiIconButton
            v-else
            size="sm"
            :label="t('agents.hosting.remove', { host: h })"
            :disabled="removing === h"
            @click="remove(h)"
          ><X /></UiIconButton>
        </li>
      </ul>
      <p v-else-if="state.hosts" class="servers__empty">{{ t('agents.hosting.empty') }}</p>

      <p v-if="hostsError" class="servers__error selectable" role="alert">{{ hostsError }}</p>

      <form class="add" @submit.prevent="add">
        <label class="add__label" :for="fieldId">{{ t('agents.hosting.add') }}</label>
        <div class="add__line">
          <input
            :id="fieldId"
            ref="input"
            v-model="draft"
            class="add__input"
            :class="{ 'has-error': !!draftError }"
            type="text"
            spellcheck="false"
            autocomplete="off"
            placeholder="git.example.com"
            :aria-describedby="hintId"
            :aria-invalid="!!draftError || undefined"
            @input="draftError = null"
          >
          <UiButton size="sm" type="submit" :loading="saving">{{ t('common.actions.add') }}</UiButton>
        </div>
        <p v-if="draftError" :id="hintId" class="add__hint add__hint--error" role="alert">{{ draftError }}</p>
        <p v-else :id="hintId" class="add__hint">{{ t('agents.hosting.addHint') }}</p>
      </form>
    </section>
  </SettingsSection>
</template>

<style scoped>
.clis {
  margin: 0;
  padding: 0;
  list-style: none;
}

.servers { margin-top: var(--space-8); }
.servers__title {
  margin: 0;
  font-size: var(--text-md);
  font-weight: 600;
  letter-spacing: -0.005em;
  color: var(--fg);
}
.servers__note {
  margin: var(--space-1) 0 var(--space-3);
  max-width: 62ch;
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  text-wrap: pretty;
}
.servers__list {
  margin: 0 0 var(--space-3);
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--line-soft);
}
.server {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 34px;
  border-bottom: 1px solid var(--line-soft);
  font-size: var(--text-sm);
}
.server__mark { flex: none; width: 14px; height: 14px; stroke-width: 1.75; color: var(--fg-subtle); }
.server__host {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg);
}
.server__meta { flex: none; font-size: var(--text-xs); color: var(--fg-subtle); }
.servers__empty {
  margin: 0 0 var(--space-3);
  font-size: var(--text-xs);
  color: var(--fg-faint);
}
.servers__error {
  margin: 0 0 var(--space-3);
  font-size: var(--text-xs);
  color: var(--ripe-error-fg);
  text-wrap: pretty;
}

.add { display: grid; gap: 6px; max-width: 420px; }
.add__label { font-size: var(--text-xs); font-weight: 560; color: var(--fg-muted); }
.add__line { display: flex; align-items: center; gap: var(--space-2); }
.add__input {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 var(--space-3);
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.add__input::placeholder { color: var(--fg-faint); }
.add__input:focus-visible { outline: none; }
.add__input:focus { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.add__input.has-error { border-color: color-mix(in oklch, var(--ripe-error) 60%, transparent); }
.add__hint { margin: 0; font-size: var(--text-xs); color: var(--fg-subtle); line-height: var(--leading-tight); }
.add__hint--error { color: var(--ripe-error-fg); }
</style>
