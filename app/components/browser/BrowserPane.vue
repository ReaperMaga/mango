<script setup lang="ts">
import { ArrowLeft, ArrowRight, Bug, CircleAlert, ExternalLink, RotateCw, X } from 'lucide-vue-next'
import { useThreads } from '~/stores/threads'
import { useBrowser } from '~/stores/browser'
import { isTauri, openExternal } from '~/composables/useBackend'
import { isBlank, normalizeAddress, parseBrowserTab } from '~/utils/browserTabs'

/**
 * A browser tab in the main pane: a toolbar (back, forward, reload, the address, open in
 * the system browser, developer tools) over a placeholder. Inside the app the page is a
 * native webview the browser store lays exactly over the placeholder (and hides while a
 * menu or dialog floats above); in the browser preview it is a sandboxed iframe, which
 * many sites refuse. A tab with nothing loaded yet shows a start view instead.
 */
const props = defineProps<{ tabId: string; paneId: string; split: boolean; active: boolean }>()

const threads = useThreads()
const browsers = useBrowser()
const native = isTauri()

const id = computed(() => parseBrowserTab(props.tabId)?.browserId ?? '')
const b = computed(() => browsers.byId(id.value))
const blank = computed(() => isBlank(b.value?.url))
const owner = computed(() => threads.byId(b.value?.threadId))

/* ---------- the address field ---------- */

const address = ref<HTMLInputElement | null>(null)
const draft = ref('')
const editing = ref(false)
/** What was typed is not an address (Mango does not search the web). */
const notAddress = ref<string | null>(null)

watch(() => b.value?.url, (url) => { if (!editing.value) draft.value = isBlank(url) ? '' : url ?? '' }, { immediate: true })

function onFocus() {
  editing.value = true
  // Select it all, as browsers do: typing replaces the address.
  nextTick(() => address.value?.select())
}
function onBlur() {
  editing.value = false
  draft.value = blank.value ? '' : b.value?.url ?? ''
}
function go() {
  const url = normalizeAddress(draft.value)
  if (!url) {
    notAddress.value = draft.value.trim() || null
    return
  }
  notAddress.value = null
  void browsers.navigate(id.value, url)
  address.value?.blur()
}
function revert() {
  notAddress.value = null
  address.value?.blur()
}
watch(draft, () => { if (notAddress.value && draft.value.trim() !== notAddress.value) notAddress.value = null })

/* ---------- the page ---------- */

const host = ref<HTMLElement | null>(null)

/** The webview follows the placeholder while this pane shows the tab. */
watch([id, host], ([now, el], [before, oldEl]) => {
  if (before && oldEl) browsers.detach(before, oldEl)
  if (now && el) browsers.attach(now, el)
}, { immediate: true })
onBeforeUnmount(() => { if (host.value) browsers.detach(id.value, host.value) })

onMounted(() => {
  // A new tab: straight to the address.
  if (props.active && blank.value) address.value?.focus()
})
watch(() => props.tabId, () => { if (props.active && blank.value) nextTick(() => address.value?.focus()) })

const loading = computed(() => !!b.value?.loading)
function reloadOrStop() {
  void browsers.go(id.value, loading.value ? 'stop' : 'reload')
}
function openOutside() {
  if (b.value && !blank.value) void openExternal(b.value.url).catch(() => {})
}
</script>

<template>
  <section class="bw" :class="{ 'is-active': active, 'is-split': split }" :aria-label="b?.title || 'Browser'">
    <header class="bw__bar">
      <UiIconButton size="sm" label="Back" :disabled="!native || blank" @click="browsers.go(id, 'back')"><ArrowLeft /></UiIconButton>
      <UiIconButton size="sm" label="Forward" :disabled="!native || blank" @click="browsers.go(id, 'forward')"><ArrowRight /></UiIconButton>
      <UiIconButton size="sm" :label="loading ? 'Stop loading' : 'Reload'" :disabled="blank" @click="reloadOrStop">
        <X v-if="loading" /><RotateCw v-else />
      </UiIconButton>
      <form class="bw__address" :class="{ 'is-wrong': notAddress }" @submit.prevent="go">
        <input
          ref="address"
          v-model="draft"
          class="bw__input"
          type="text"
          inputmode="url"
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
          aria-label="Address"
          :aria-invalid="!!notAddress"
          placeholder="localhost:3000 or an address"
          @focus="onFocus"
          @blur="onBlur"
          @keydown.esc.prevent="revert"
        >
      </form>
      <UiIconButton size="sm" label="Open in system browser" :disabled="blank" @click="openOutside"><ExternalLink /></UiIconButton>
      <UiIconButton v-if="native" size="sm" label="Developer tools" :disabled="!b || !!b.error" @click="browsers.devtools(id)"><Bug /></UiIconButton>
      <UiIconButton v-if="split" size="sm" label="Close pane" @click.stop="threads.closePane(paneId)"><X /></UiIconButton>
      <span v-if="loading" class="bw__progress" aria-hidden="true" />
    </header>

    <div v-if="notAddress" class="bw__note" role="alert">
      <CircleAlert class="bw__note-icon" aria-hidden="true" />
      <span class="bw__note-text"><strong class="selectable">{{ notAddress }}</strong> is not an address. Type a URL such as localhost:3000 or example.com.</span>
    </div>
    <div v-else-if="b?.error" class="bw__note" role="alert">
      <CircleAlert class="bw__note-icon" aria-hidden="true" />
      <span class="bw__note-text selectable">{{ b.error }}</span>
    </div>

    <div ref="host" class="bw__page" :aria-busy="loading">
      <div v-if="blank || !b" class="bw__start">
        <p class="bw__start-title">{{ owner ? `Waiting for ${owner.title}` : 'Open a page' }}</p>
        <p class="bw__start-sub">
          Type an address above, such as <span class="bw__mono">localhost:3000</span>. Links to local dev servers in chats and
          the terminal open here, and agents can use this browser to check their work.
        </p>
      </div>
      <iframe
        v-else-if="!native"
        :key="`${b.url}#${b.reloads}`"
        class="bw__frame"
        :src="b.url"
        :title="b.title || b.url"
        sandbox="allow-scripts allow-forms allow-popups"
        referrerpolicy="no-referrer"
      />
    </div>
    <p v-if="!native && !blank && b" class="bw__preview-note">Browser preview: a sandboxed frame stands in for the app's browser; many sites refuse to show in one.</p>
  </section>
</template>

<style scoped>
.bw {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-canvas);
}
.bw__bar {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 40px;
  padding: 0 var(--space-3) 0 var(--space-2);
  border-bottom: 1px solid var(--line-soft);
}
.bw.is-split:not(.is-active) .bw__bar { opacity: 0.72; }
.bw__address { flex: 1; min-width: 0; margin: 0 var(--space-1); }
.bw__input {
  width: 100%;
  height: 26px;
  padding: 0 var(--space-2);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
  color: var(--fg-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  outline: none;
  text-overflow: ellipsis;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.bw__input::placeholder { color: var(--fg-faint); font-family: var(--font-ui); }
.bw__input:hover { border-color: var(--line-strong); }
.bw__input:focus { color: var(--fg); border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.bw__address.is-wrong .bw__input { border-color: var(--ripe-error); }

/* Loading: a thin line along the toolbar's edge, a sliding stroke of ripening mango. */
.bw__progress {
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  overflow: hidden;
  pointer-events: none;
}
.bw__progress::after {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 30%;
  background: var(--ripe-running);
  animation: bw-load 1.3s var(--ease-in-out) infinite;
}
@keyframes bw-load {
  from { transform: translateX(-100%); }
  to { transform: translateX(340%); }
}
@media (prefers-reduced-motion: reduce) {
  .bw__progress::after { animation: none; width: 100%; opacity: 0.6; }
}

.bw__note {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 34px;
  padding: var(--space-1) var(--space-3) var(--space-1) var(--space-4);
  background: var(--bg-panel);
  border-bottom: 1px solid var(--line-soft);
  font-size: var(--text-sm);
}
.bw__note-icon { flex: none; width: 15px; height: 15px; stroke-width: 1.85; color: var(--ripe-error); }
.bw__note-text { min-width: 0; color: var(--fg-muted); overflow-wrap: anywhere; }
.bw__note-text strong { color: var(--fg); font-weight: 600; }

/* The native page covers this exactly; it shows only before a page loads (and while a menu is open). */
.bw__page { position: relative; flex: 1; min-height: 0; background: var(--bg-inset); }
.bw__frame { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: var(--bg-panel); }

.bw__start {
  display: grid;
  gap: var(--space-2);
  max-width: 420px;
  margin: 18vh auto 0;
  padding: 0 var(--space-4);
  text-align: center;
}
.bw__start p { margin: 0; }
.bw__start-title { font-size: var(--text-md); font-weight: 600; color: var(--fg); }
.bw__start-sub { font-size: var(--text-sm); line-height: var(--leading-normal); color: var(--fg-subtle); text-wrap: pretty; }
.bw__mono { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--fg-muted); }

.bw__preview-note {
  flex: none;
  margin: 0;
  padding: 6px var(--space-4);
  border-top: 1px solid var(--line-soft);
  font-size: var(--text-xs);
  color: var(--fg-faint);
}
</style>
