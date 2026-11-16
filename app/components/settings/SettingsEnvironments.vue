<script setup lang="ts">
import { ArrowLeft, ChevronRight } from 'lucide-vue-next'
import { instanceKey, useEnvironments, type EnvSelection } from '~/stores/environments'
import EnvHome from '~/components/envs/EnvHome.vue'
import EnvServerPage from '~/components/envs/EnvServerPage.vue'
import EnvInstancePage from '~/components/envs/EnvInstancePage.vue'
import EnvHostDialog from '~/components/envs/EnvHostDialog.vue'
import EnvCreateDialog from '~/components/envs/EnvCreateDialog.vue'
import EnvJoinDialog from '~/components/envs/EnvJoinDialog.vue'

/**
 * Settings > Environments. Three levels in the content column: the list of
 * servers (with their instances), a server's page, an instance's page; a
 * breadcrumb leads back up. Pages are kept alive while another shows, and
 * Settings keeps this section mounted once it has been opened, so an installer,
 * a sign-in or a shell started here keeps running while the user looks elsewhere.
 *
 * `active`: the section is on screen (Settings open on it).
 */
const props = defineProps<{ active: boolean }>()

const envs = useEnvironments()
const root = ref<HTMLElement | null>(null)
const host = computed(() => (envs.selected ? envs.host(envs.selected.hostId) : null))
/** Where we are; a joined environment has no server page, so it is always its one instance. */
const sel = computed<EnvSelection | null>(() => {
  const s = envs.selected
  const direct = host.value?.direct
  return s && direct ? { hostId: s.hostId, instance: direct.instance } : s
})

const modKey = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌥' : 'Alt'

/* ---------- data: fresh every time the section shows ---------- */

async function refresh() {
  if (!envs.loaded) await envs.load().catch(() => { /* the empty state explains */ })
  if (sel.value && !envs.host(sel.value.hostId)) envs.home()
  await Promise.all(envs.hosts.map(h => envs.refreshHost(h.id)))
}

watch(() => props.active, (a) => { if (a) refresh() }, { immediate: true })

/* A starting or stopping instance settles in a few seconds: look again until it has. */
let settleTimer: ReturnType<typeof setInterval> | undefined
watch(() => {
  if (!props.active) return ''
  return envs.hosts
    .filter(h => (envs.instances[h.id] ?? []).some(i => i.status === 'starting' || i.status === 'stopping'))
    .map(h => h.id)
    .join('\n')
}, (ids) => {
  clearInterval(settleTimer)
  if (!ids) return
  settleTimer = setInterval(() => {
    for (const id of ids.split('\n')) if (!envs.loadingInstances[id]) envs.refreshInstances(id)
  }, 2500)
})
onBeforeUnmount(() => clearInterval(settleTimer))

/* ---------- navigation ---------- */

function up() {
  const s = sel.value
  if (!s) return
  if (s.instance && !host.value?.direct) envs.select(s.hostId)
  else envs.home()
}

/** Alt+Left goes up a level, like Back in a browser. */
function onKey(e: KeyboardEvent) {
  if (!props.active || !sel.value || e.defaultPrevented) return
  if (!(e.altKey && e.key === 'ArrowLeft') || e.ctrlKey || e.metaKey || e.shiftKey) return
  if ((e.target as HTMLElement | null)?.closest?.('.xterm, input, textarea, [contenteditable]')) return
  e.preventDefault()
  up()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const keyOf = (s: EnvSelection | null) => (s ? (s.instance ? instanceKey(s.hostId, s.instance) : s.hostId) : '')

/**
 * After moving between pages: start at the top, and put keyboard focus on the
 * new page's title, or, going back up, on the row of the page just left.
 */
watch(sel, async (now, before) => {
  if (!props.active) return
  const deeper = !!now && (!before || (!!now.instance && !before.instance))
  await nextTick()
  const el = root.value
  if (!el) return
  el.closest('.settings__scroll')?.scrollTo({ top: 0 })
  const back = !deeper && before ? el.querySelector<HTMLElement>(`[data-row="${CSS.escape(keyOf(before))}"]`) : null
  const target = back ?? el.querySelector<HTMLElement>('[data-page-title]')
  // Only when focus was in the section: a page changed by a dialog or the palette leaves focus alone.
  if (target && (!document.activeElement || document.activeElement === document.body || el.contains(document.activeElement))) {
    target.focus({ preventScroll: !back })
  }
})
</script>

<template>
  <div ref="root" class="envs">
    <nav v-if="sel" class="crumbs" aria-label="Breadcrumb">
      <UiIconButton label="Back" :shortcut="`${modKey}+Left`" size="sm" class="crumbs__back" @click="up">
        <ArrowLeft />
      </UiIconButton>
      <ol class="crumbs__list">
        <li class="crumbs__item">
          <button type="button" class="crumbs__link" @click="envs.home()">Environments</button>
        </li>
        <!-- a joined environment: Environments › its name -->
        <li v-if="host?.direct" class="crumbs__item">
          <ChevronRight class="crumbs__sep" aria-hidden="true" />
          <span class="crumbs__here" aria-current="location">{{ host.name }}</span>
        </li>
        <li v-else class="crumbs__item">
          <ChevronRight class="crumbs__sep" aria-hidden="true" />
          <button v-if="sel.instance" type="button" class="crumbs__link" @click="envs.select(sel.hostId)">
            {{ host?.name ?? 'Server' }}
          </button>
          <span v-else class="crumbs__here" aria-current="location">{{ host?.name ?? 'Server' }}</span>
        </li>
        <li v-if="sel.instance && !host?.direct" class="crumbs__item">
          <ChevronRight class="crumbs__sep" aria-hidden="true" />
          <span class="crumbs__here" aria-current="location">{{ sel.instance }}</span>
        </li>
      </ol>
    </nav>

    <KeepAlive :max="12">
      <EnvInstancePage
        v-if="sel?.instance"
        :key="`i:${instanceKey(sel.hostId, sel.instance)}`"
        :host-id="sel.hostId"
        :name="sel.instance"
      />
      <EnvServerPage v-else-if="sel" :key="`s:${sel.hostId}`" :host-id="sel.hostId" />
      <EnvHome v-else key="home" />
    </KeepAlive>

    <EnvHostDialog />
    <EnvCreateDialog />
    <EnvJoinDialog />
  </div>
</template>

<style scoped>
.envs { display: grid; }

/* ---- breadcrumb: where this page sits, and the way back ---- */
.crumbs {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  margin: calc(var(--space-2) * -1) 0 var(--space-5) calc(var(--space-1) * -1);
}
.crumbs__list {
  display: flex;
  align-items: center;
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}
.crumbs__item { display: flex; align-items: center; min-width: 0; }
.crumbs__item:first-child { flex: none; }
.crumbs__sep { flex: none; width: 13px; height: 13px; margin: 0 2px; stroke-width: 1.85; color: var(--fg-faint); }
.crumbs__link,
.crumbs__here {
  min-width: 0;
  height: 24px;
  padding: 0 6px;
  font-size: var(--text-sm);
  line-height: 24px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-radius: var(--radius-xs);
}
.crumbs__link {
  color: var(--fg-subtle);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.crumbs__link:hover { background: var(--bg-hover); color: var(--fg); }
.crumbs__here { color: var(--fg-muted); font-weight: 560; }
</style>
