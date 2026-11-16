<script setup lang="ts">
import { RefreshCw, Share2 } from 'lucide-vue-next'
import { instanceKey, shareDay, shareExpired, useEnvironments } from '~/stores/environments'
import type { EnvShare } from '~/types/ipc'
import { useNow } from '~/utils/time'

/**
 * Who an instance is shared with, on its page: one row per share link (who it
 * is for, how it reaches the instance, when it ends), each revocable after a
 * second, explicit step. "Share…" asks the page to open the share dialog.
 */
const props = defineProps<{ hostId: string; instance: string; running: boolean }>()
const emit = defineEmits<{ share: [] }>()

const envs = useEnvironments()
const now = useNow()
const key = computed(() => instanceKey(props.hostId, props.instance))
const shares = computed(() => envs.shares[key.value] ?? null)
const loading = computed(() => !!envs.loadingShares[key.value])
const listError = computed(() => envs.shareErrors[key.value] ?? null)

function load(force = false) {
  if (!props.running) return
  if (force || (!shares.value && !loading.value)) envs.refreshShares(props.hostId, props.instance)
}
watch(() => props.running, (r) => { if (r) load() })
onMounted(() => load())
onActivated(() => load(true))

/* ---------- revoke (two steps) ---------- */

const confirming = ref<string | null>(null)
const revokeError = ref<{ id: string; message: string } | null>(null)

async function revoke(s: EnvShare) {
  revokeError.value = null
  try {
    await envs.revokeShare(props.hostId, props.instance, s.id)
    confirming.value = null
  } catch (e) {
    revokeError.value = { id: s.id, message: (e instanceof Error ? e.message : String(e)).replace(/\.$/, '') }
  }
}

const viaWord = (s: EnvShare) => (s.via === 'public' ? 'Over the internet' : 'Tailscale')
const ends = (s: EnvShare) => {
  if (!s.expiresAt) return 'No end date'
  return shareExpired(s.expiresAt, now.value) ? `Expired ${shareDay(s.expiresAt, now.value)}` : `Until ${shareDay(s.expiresAt, now.value)}`
}
</script>

<template>
  <section class="shr" aria-labelledby="shr-title">
    <header class="shr__head">
      <h3 id="shr-title" class="shr__h3">
        Sharing
        <span v-if="shares?.length" class="shr__count tabular">{{ shares.length }}</span>
      </h3>
      <span class="shr__actions">
        <UiIconButton label="Check again" size="sm" :disabled="!running || loading" @click="load(true)">
          <RefreshCw :class="{ 'is-turning': loading }" />
        </UiIconButton>
        <UiButton size="sm" :disabled="!running" :title="running ? undefined : 'Start it first'" @click="emit('share')">
          <Share2 />Share…
        </UiButton>
      </span>
    </header>
    <p class="shr__desc">
      Give one person full access to {{ instance }} with a link, and nothing else on the server. They need no server of their own.
    </p>

    <p v-if="!running && !shares" class="shr__desc">Start the environment to see who it is shared with.</p>
    <p v-else-if="listError" class="shr__error" role="alert">
      Couldn't read its shares. <span class="selectable">{{ listError }}</span>
    </p>

    <ul v-if="shares?.length" class="rows" aria-label="Shares">
      <li v-for="s in shares" :key="s.id" class="share">
        <div class="share__row">
          <span class="share__who">
            <span class="share__label">{{ s.label }}</span>
            <span class="share__via">
              <span>{{ viaWord(s) }}</span>
              <span aria-hidden="true">·</span>
              <span class="share__mono selectable" :title="s.endpoint">{{ s.endpoint }}</span>
            </span>
          </span>
          <span class="share__when">
            <span class="share__ends tabular" :class="{ 'is-expired': shareExpired(s.expiresAt, now) }">{{ ends(s) }}</span>
            <span class="share__made tabular">Created {{ shareDay(s.createdAt, now) }}</span>
          </span>
          <UiButton
            variant="ghost"
            size="sm"
            :disabled="!running || confirming === s.id"
            :title="running ? undefined : 'Start it to revoke access'"
            @click="confirming = s.id; revokeError = null"
          >
            {{ shareExpired(s.expiresAt, now) ? 'Remove' : 'Revoke' }}
          </UiButton>
        </div>
        <div v-if="confirming === s.id" class="share__confirm" role="group" :aria-label="`Confirm removing ${s.label}'s access`">
          <span v-if="shareExpired(s.expiresAt, now)">
            Remove {{ s.label }}'s expired share? This deletes its key from {{ instance }}; the link already stopped working.
          </span>
          <span v-else>
            Revoke {{ s.label }}'s access? This removes their key from {{ instance }}: the link stops working and they can't connect
            again. Anything they left inside stays.
          </span>
          <span class="share__confirm-actions">
            <UiButton variant="ghost" size="sm" :disabled="envs.revoking[s.id]" @click="confirming = null">Cancel</UiButton>
            <UiButton variant="danger" size="sm" :loading="envs.revoking[s.id]" @click="revoke(s)">
              {{ shareExpired(s.expiresAt, now) ? 'Remove' : 'Revoke access' }}
            </UiButton>
          </span>
        </div>
        <p v-if="revokeError?.id === s.id" class="shr__error" role="alert">
          Couldn't revoke it. <span class="selectable">{{ revokeError.message }}.</span>
        </p>
      </li>
    </ul>
    <ul v-else-if="loading" class="rows" aria-busy="true" aria-label="Loading shares">
      <li v-for="n in 2" :key="n" class="share share--skeleton" aria-hidden="true">
        <span class="bone bone--name" /><span class="bone bone--when" />
      </li>
    </ul>
    <p v-else-if="shares" class="shr__empty">Not shared with anyone.</p>
  </section>
</template>

<style scoped>
.shr { display: grid; gap: var(--space-2); margin-top: var(--space-3); }
.shr__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.shr__h3 {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 620;
  letter-spacing: -0.01em;
}
.shr__count { font-size: var(--text-xs); font-weight: 500; color: var(--fg-faint); }
.shr__actions { display: inline-flex; align-items: center; gap: var(--space-1); }
.shr__desc { margin: 0; max-width: 70ch; font-size: var(--text-sm); color: var(--fg-subtle); text-wrap: pretty; }
.shr__error { margin: 0; font-size: var(--text-xs); color: var(--ripe-error-fg); text-wrap: pretty; }
.shr__empty { margin: 0; padding: var(--space-2) 0; font-size: var(--text-sm); color: var(--fg-subtle); }

.rows { display: grid; margin: 0; padding: 0; list-style: none; }
.share { display: grid; gap: var(--space-2); padding: var(--space-2) 0; border-top: 1px solid var(--line-soft); }
.share:last-child { border-bottom: 1px solid var(--line-soft); }
.share__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: var(--space-4);
  min-height: 36px;
}
.share__who, .share__when { display: grid; min-width: 0; }
.share__label {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.share__via {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  white-space: nowrap;
}
.share__mono {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--fg-muted);
  overflow: hidden;
  text-overflow: ellipsis;
}
.share__when { justify-items: end; text-align: right; }
.share__ends { font-size: var(--text-sm); color: var(--fg-muted); white-space: nowrap; }
.share__ends.is-expired { font-weight: 560; color: var(--ripe-waiting-fg); }
.share__made { font-size: var(--text-xs); color: var(--fg-faint); white-space: nowrap; }

.share__confirm {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  font-size: var(--text-sm);
  color: var(--fg);
  background: color-mix(in oklch, var(--ripe-error) 8%, transparent);
  border: 1px solid color-mix(in oklch, var(--ripe-error) 35%, transparent);
  border-radius: var(--radius-md);
  text-wrap: pretty;
}
.share__confirm-actions { flex: none; display: inline-flex; gap: var(--space-1); }

.share--skeleton { grid-template-columns: 1fr auto; align-items: center; min-height: 52px; }
.bone { height: 10px; border-radius: var(--radius-xs); background: var(--bg-hover); }
.bone--name { width: 30%; height: 12px; }
.bone--when { width: 72px; }

.is-turning { animation: shr-turn 0.8s linear infinite; }
@keyframes shr-turn { to { transform: rotate(360deg); } }
</style>
