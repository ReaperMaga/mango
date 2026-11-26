<script setup lang="ts">
import { Check, CircleCheck, CircleDashed, Copy, RefreshCw, TriangleAlert } from 'lucide-vue-next'
import { instanceKey, useEnvironments } from '~/stores/environments'
import { copyText } from '~/utils/clipboard'
import { ALL_V4, LORE_PORT, defaultLoreAddress, validListenAddress, validPublishPort } from '~/utils/lorePublish'
import EnvLorePublishFields from './EnvLorePublishFields.vue'

/**
 * The Lore server in an instance (the `lore-server` component), on its page: whether it runs,
 * the URL the other environments on the same server use, and the one this computer and anyone
 * outside use once it is published (UDP and TCP, on an address of the Incus host the user picks),
 * with what a host firewall needs. "Use as Lore server" hands both URLs to the saved Lore servers
 * (`envs.useAsLoreServer`). A joined environment shows its state, without publishing.
 */
const props = defineProps<{ hostId: string; instance: string; running: boolean }>()

const { t } = useI18n()
const envs = useEnvironments()
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
async function use() {
  const l = lore.value
  if (!l || !host.value) return
  using.value = true
  try {
    await envs.useAsLoreServer({
      name: t('envs.lore.entryName', { instance: props.instance, host: host.value.name }),
      url: l.published?.url ?? null,
      insideUrl: l.insideUrl ?? l.insideIpUrl,
      origin: { hostId: props.hostId, instance: props.instance },
    })
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
        <span>{{ t('envs.lore.noSignIn') }}</span>
      </p>
      <p v-if="lore.installed && !lore.running" class="lore__desc">{{ t('envs.lore.stoppedHint') }}</p>

      <dl class="lore__urls">
        <div class="lore__url-row">
          <dt>{{ t('envs.lore.inside') }}</dt>
          <dd>
            <template v-if="lore.insideUrl ?? lore.insideIpUrl">
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
              <UiButton size="sm" :variant="published ? 'ghost' : 'secondary'" :disabled="!running || !!busy" @click="startEdit">
                {{ published ? t('envs.lore.change') : t('envs.lore.publish') }}
              </UiButton>
              <UiButton v-if="published" variant="ghost" size="sm" :loading="busy === 'unpublish'" :disabled="!!busy" @click="unpublish">
                {{ t('envs.lore.unpublish') }}
              </UiButton>
            </span>
          </dd>
        </div>
      </dl>

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
