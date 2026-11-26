<script setup lang="ts">
import { Box, ChevronRight, Link2, Plus, Server, TriangleAlert } from 'lucide-vue-next'
import { directState, hostState, instanceKey, shareDay, shareExpired, useEnvironments } from '~/stores/environments'
import type { EnvHost, EnvInstance } from '~/types/ipc'
import { useNow } from '~/utils/time'
import EnvStatus from './EnvStatus.vue'

/**
 * The first page of Settings > Environments: every server with its state and,
 * where Incus is ready, its instances; then the environments others shared with
 * the user ("Shared with you"), each a row straight to its page. Adding a
 * server, creating an environment or joining one with a link opens its dialog.
 */
const { t } = useI18n()
const envs = useEnvironments()
const now = useNow()

/** Only joined environments: they lead, and the pitch for a server of one's own follows. */
const onlyJoined = computed(() => !envs.servers.length && envs.joined.length > 0)

const stateOf = (id: string) => {
  const h = envs.host(id)
  return h?.direct ? directState(h, envs.probes[id], !!envs.probing[id]) : hostState(envs.probes[id], !!envs.probing[id])
}
/** "until 23 Nov", "access ended 15 Nov", or nothing for a share with no end. */
const accessLine = (h: EnvHost) => {
  const at = h.direct?.expiresAt
  if (!at) return null
  return shareExpired(at, now.value) ? t('envs.home.accessEnded', { day: shareDay(at, now.value) }) : t('envs.home.until', { day: shareDay(at, now.value) })
}
const ready = (id: string) => envs.probes[id]?.ok === true
const instancesOf = (id: string) => envs.instances[id] ?? null

const sshLine = (id: string) => {
  const h = envs.host(id)
  if (!h) return ''
  return h.port ? `${h.ssh}:${h.port}` : h.ssh
}
const addresses = (i: EnvInstance) => [i.tailscaleIp, ...i.ipv4].filter(Boolean).join(', ')

function openSetup(id: string) {
  envs.intents[id] = 'setup-incus'
  envs.select(id)
}
</script>

<template>
  <div class="eh" :class="{ 'eh--joined-only': onlyJoined }">
    <header class="eh__head">
      <div class="eh__intro">
        <h2 class="eh__title" data-page-title tabindex="-1">{{ t('envs.common.title') }}</h2>
        <p class="eh__desc">
          {{ t('envs.home.description') }}
        </p>
      </div>
      <span v-if="envs.hosts.length" class="eh__head-actions">
        <UiButton variant="ghost" size="sm" @click="envs.openJoin()"><Link2 />{{ t('envs.home.join') }}</UiButton>
        <UiButton v-if="envs.servers.length" size="sm" @click="envs.dialog = { kind: 'host', id: '' }"><Plus />{{ t('envs.common.addServer') }}</UiButton>
      </span>
    </header>

    <!-- no servers yet (with nothing joined either, or after what was shared) -->
    <div v-if="envs.loaded && !envs.servers.length" class="eh__empty">
      <h3 class="eh__empty-title">{{ t('envs.home.emptyTitle') }}</h3>
      <i18n-t keypath="envs.home.emptyText" tag="p" class="eh__empty-text" scope="global">
        <template #ssh><code>ssh</code></template>
      </i18n-t>
      <p class="eh__empty-text eh__empty-text--quiet">
        {{ t('envs.home.emptyNeeds') }}
      </p>
      <UiButton :variant="onlyJoined ? 'secondary' : 'primary'" @click="envs.dialog = { kind: 'host', id: '' }"><Plus />{{ t('envs.common.addServer') }}</UiButton>
      <p v-if="!envs.hosts.length" class="eh__empty-join">
        {{ t('envs.home.haveLink') }}
        <button type="button" class="eh__link" @click="envs.openJoin()">{{ t('envs.home.joinShared') }}</button>
      </p>
    </div>

    <div v-else-if="!envs.loaded" class="eh__list" aria-busy="true" :aria-label="t('envs.home.loadingServers')">
      <div v-for="n in 2" :key="n" class="host" aria-hidden="true">
        <span class="row row--host row--skeleton"><span class="bone bone--icon" /><span class="bone bone--name" /></span>
      </div>
    </div>

    <ul v-else class="eh__list" :aria-label="t('envs.home.yourServers')">
      <li v-for="h in envs.servers" :key="h.id" class="host">
        <button type="button" class="row row--host" :data-row="h.id" @click="envs.select(h.id)">
          <Server class="row__icon" aria-hidden="true" />
          <span class="row__main">
            <span class="row__name">{{ h.name }}</span>
            <span class="row__meta">
              <span class="row__mono" :title="sshLine(h.id)">{{ sshLine(h.id) }}</span>
              <template v-if="envs.probes[h.id]?.os">
                <span aria-hidden="true">·</span><span class="row__clip">{{ envs.probes[h.id]?.os }}</span>
              </template>
            </span>
          </span>
          <span class="state" :class="`state--${stateOf(h.id).tone}`">
            <span v-if="stateOf(h.id).tone === 'checking'" class="ring" aria-hidden="true" />
            <TriangleAlert v-else-if="stateOf(h.id).tone === 'bad'" class="state__warn" aria-hidden="true" />
            <span v-else class="state__mark" aria-hidden="true" />
            <span class="state__word">{{ stateOf(h.id).label }}</span>
          </span>
          <ChevronRight class="row__go" aria-hidden="true" />
        </button>

        <!-- Incus needs setting up: say so where the server is listed, and lead to its page. -->
        <div v-if="stateOf(h.id).tone === 'setup' && envs.probes[h.id]?.canSetup" class="host__note">
          <span>{{ envs.probes[h.id]?.incus === 'missing' ? t('envs.home.canInstall') : t('envs.home.canSetUp') }}</span>
          <UiButton size="sm" @click="openSetup(h.id)">
            {{ envs.probes[h.id]?.incus === 'missing' ? t('envs.common.installIncus') : t('envs.common.setUpIncus') }}
          </UiButton>
        </div>
        <p v-else-if="stateOf(h.id).tone === 'setup'" class="host__note host__note--quiet">
          {{ envs.probes[h.id]?.setupNote ?? t('envs.home.notReady') }}
        </p>

        <template v-if="ready(h.id)">
          <p v-if="envs.errors[h.id]" class="host__error" role="alert">
            {{ t('envs.home.listFailed') }} <span class="selectable">{{ envs.errors[h.id] }}</span>
          </p>
          <ul v-if="instancesOf(h.id)?.length" class="insts" :aria-label="t('envs.home.environmentsOn', { name: h.name })">
            <li v-for="i in instancesOf(h.id)" :key="i.name">
              <button type="button" class="row row--inst" :data-row="instanceKey(h.id, i.name)" @click="envs.select(h.id, i.name)">
                <span class="row__name row__name--inst">{{ i.name }}</span>
                <EnvStatus class="row__status" :status="i.status" :busy="envs.busy[instanceKey(h.id, i.name)]" word />
                <span class="row__addr selectable" :title="addresses(i)">{{ addresses(i) || '–' }}</span>
                <span class="row__kind">{{ i.kind === 'vm' ? t('envs.common.vmShort') : t('envs.common.container') }}</span>
                <ChevronRight class="row__go" aria-hidden="true" />
              </button>
            </li>
          </ul>
          <p v-else-if="instancesOf(h.id) && !envs.loadingInstances[h.id]" class="host__none">{{ t('envs.home.none') }}</p>
          <button type="button" class="host__add" @click="envs.dialog = { kind: 'create', hostId: h.id }">
            <Plus aria-hidden="true" />{{ t('envs.common.newEnvironment') }}
          </button>
        </template>
      </li>
    </ul>

    <!-- environments joined from someone's link: no server, no Incus; each is its own page -->
    <section v-if="envs.joined.length" class="eh__shared" aria-labelledby="eh-shared">
      <h3 id="eh-shared" class="eh__h3">
        {{ t('envs.common.sharedWithYou') }}
        <span class="eh__count tabular">{{ envs.joined.length }}</span>
      </h3>
      <ul class="eh__list">
        <li v-for="h in envs.joined" :key="h.id" class="host">
          <button type="button" class="row row--host" :data-row="instanceKey(h.id, h.direct!.instance)" @click="envs.select(h.id)">
            <Box class="row__icon" aria-hidden="true" />
            <span class="row__main">
              <span class="row__name">{{ h.name }}</span>
              <span class="row__meta">
                <i18n-t keypath="envs.home.from" tag="span" class="row__clip" scope="global">
                  <template #name><span class="row__mono">{{ h.direct!.sharedFrom }}</span></template>
                </i18n-t>
                <template v-if="accessLine(h)">
                  <span aria-hidden="true">·</span>
                  <span class="row__access tabular" :class="{ 'is-ended': shareExpired(h.direct!.expiresAt, now) }">{{ accessLine(h) }}</span>
                </template>
              </span>
            </span>
            <span class="state" :class="`state--${stateOf(h.id).tone}`">
              <span v-if="stateOf(h.id).tone === 'checking'" class="ring" aria-hidden="true" />
              <TriangleAlert v-else-if="stateOf(h.id).tone === 'bad'" class="state__warn" aria-hidden="true" />
              <span v-else class="state__mark" aria-hidden="true" />
              <span class="state__word">{{ stateOf(h.id).label }}</span>
            </span>
            <ChevronRight class="row__go" aria-hidden="true" />
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.eh { display: grid; gap: var(--space-5); }

.eh__head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); }
.eh__intro { display: grid; gap: var(--space-2); min-width: 0; }
.eh__title {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: 620;
  letter-spacing: -0.015em;
  line-height: var(--leading-tight);
}
.eh__title:focus { outline: none; }
.eh__desc { margin: 0; max-width: 62ch; font-size: var(--text-sm); color: var(--fg-subtle); text-wrap: pretty; }
.eh__head-actions { flex: none; display: inline-flex; align-items: center; gap: var(--space-1); }

/* Only environments others shared: they lead, the pitch for an own server follows. */
.eh--joined-only .eh__empty { order: 2; padding-top: var(--space-3); border-top: 0; }
.eh--joined-only .eh__shared { order: 1; padding-top: var(--space-2); }

.eh__h3 {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-2);
  margin: 0 0 var(--space-1);
  font-size: var(--text-lg);
  font-weight: 620;
  letter-spacing: -0.01em;
}
.eh__count { font-size: var(--text-xs); font-weight: 500; color: var(--fg-faint); }
.eh__shared { display: grid; }
.row__access { flex: none; }
.row__access.is-ended { font-weight: 560; color: var(--ripe-waiting-fg); }

.eh__empty-join { margin: var(--space-1) 0 0; font-size: var(--text-sm); color: var(--fg-subtle); }
.eh__link {
  color: var(--accent-ink);
  font-weight: 560;
  border-radius: var(--radius-xs);
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 2px;
  transition: text-decoration-color var(--dur-fast) var(--ease-out);
}
.eh__link:hover { text-decoration-color: currentColor; }

/* ---- no servers yet ---- */
.eh__empty {
  display: grid;
  justify-items: start;
  gap: var(--space-3);
  max-width: 560px;
  padding-top: var(--space-4);
  border-top: 1px solid var(--line-soft);
}
.eh__empty-title { margin: 0; font-size: var(--text-lg); font-weight: 620; letter-spacing: -0.01em; }
.eh__empty-text { margin: 0; font-size: var(--text-md); color: var(--fg-muted); text-wrap: pretty; }
.eh__empty-text--quiet { font-size: var(--text-sm); color: var(--fg-subtle); }
.eh__empty-text code { font-size: var(--text-xs); color: var(--fg); }
.eh__empty :deep(.btn) { margin-top: var(--space-2); }

/* ---- servers, each with its environments under it ---- */
.eh__list { display: grid; margin: 0; padding: 0; list-style: none; }
.host {
  display: grid;
  gap: 2px;
  padding: var(--space-2) 0 var(--space-3);
  border-top: 1px solid var(--line-soft);
}
.host:last-child { border-bottom: 1px solid var(--line-soft); }

.row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-width: 0;
  text-align: left;
  border-radius: var(--radius-sm);
  transition: background var(--dur-fast) var(--ease-out);
}
button.row:hover { background: var(--bg-hover); }
button.row:active { background: var(--bg-active); }
button.row:focus-visible { outline: none; background: var(--bg-hover); box-shadow: inset 0 0 0 1.5px var(--focus-ring); }
.row--host { min-height: 48px; padding: var(--space-1) var(--space-2); margin: 0 calc(var(--space-2) * -1); width: calc(100% + var(--space-2) * 2); }
.row__icon { flex: none; width: 16px; height: 16px; stroke-width: 1.75; color: var(--fg-subtle); }
.row__main { flex: 1; display: grid; min-width: 0; }
.row__name {
  min-width: 0;
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row__meta {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  white-space: nowrap;
}
.row__mono {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--fg-muted);
  overflow: hidden;
  text-overflow: ellipsis;
}
.row__clip { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.row__go { flex: none; width: 14px; height: 14px; stroke-width: 1.85; color: var(--fg-faint); transition: color var(--dur-fast) var(--ease-out); }
button.row:hover .row__go { color: var(--fg-subtle); }

/* Instances sit under their server, indented to its name. */
.insts { display: grid; gap: 1px; margin: 0; padding: 0; list-style: none; }
.row--inst {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) 92px minmax(0, 1fr) 76px 14px;
  min-height: 32px;
  padding: 0 var(--space-2) 0 calc(16px + var(--space-3) + var(--space-2));
  margin: 0 calc(var(--space-2) * -1);
  width: calc(100% + var(--space-2) * 2);
}
.row__name--inst { font-size: var(--text-sm); font-weight: 560; }
.row__kind { font-size: var(--text-xs); color: var(--fg-subtle); text-align: right; }
.row__addr {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--fg-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- server state: colour, fill and a word ---- */
.state {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-xs);
  font-weight: 560;
  color: var(--fg-subtle);
  white-space: nowrap;
}
.state__mark {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1.25px var(--ripe-idle);
}
.state--ready .state__mark { background: var(--ripe-queued); box-shadow: none; }
.state--ready .state__word { color: var(--fg-muted); }
/* Needs setting up: half full in the "needs you" colour. */
.state--setup .state__mark {
  box-shadow: inset 0 0 0 1.25px var(--ripe-waiting);
  background: linear-gradient(var(--ripe-waiting), var(--ripe-waiting)) bottom / 100% 50% no-repeat;
}
.state--setup .state__word { color: var(--ripe-waiting-fg); }
.state--bad .state__word { color: var(--ripe-error-fg); }
.state__warn { flex: none; width: 12px; height: 12px; stroke-width: 2; color: var(--ripe-error); }

.host__note {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 32px;
  margin: 0;
  padding-left: calc(16px + var(--space-3));
  font-size: var(--text-sm);
  color: var(--fg-muted);
  text-wrap: pretty;
}
.host__note--quiet { color: var(--fg-subtle); }
.host__error,
.host__none {
  margin: 0;
  padding: var(--space-1) 0 var(--space-1) calc(16px + var(--space-3));
  font-size: var(--text-xs);
  color: var(--fg-subtle);
}
.host__error { color: var(--ripe-error-fg); }
.host__add {
  justify-self: start;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  height: 28px;
  margin-left: calc(16px + var(--space-3) - var(--space-2));
  padding: 0 var(--space-2);
  font-size: var(--text-sm);
  color: var(--fg-subtle);
  border-radius: var(--radius-sm);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.host__add:hover { background: var(--bg-hover); color: var(--fg); }
.host__add svg { width: 14px; height: 14px; stroke-width: 1.85; color: var(--accent-ink); }

/* ---- loading ---- */
.row--skeleton { min-height: 48px; padding: 0 var(--space-2); }
.bone { height: 10px; border-radius: var(--radius-xs); background: var(--bg-hover); }
.bone--icon { width: 16px; height: 16px; }
.bone--name { width: 30%; height: 12px; }

.ring {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1.5px solid var(--fg-subtle);
  border-right-color: transparent;
  animation: eh-turn 0.7s linear infinite;
}
@keyframes eh-turn { to { transform: rotate(360deg); } }
</style>
