<script setup lang="ts">
import { computed, provide, ref } from 'vue'
import { PLANNER, type Planner } from '../context.ts'
import type { ServerConnection } from '../data/connection.ts'
import { SERVER } from '../data/routed.ts'
import { strings } from '../strings.ts'
import Icon from '../ui/Icon.vue'

/**
 * Settings > Planner server: connect this computer to a planner server's space, see how the connection is, or end it.
 * The token is only ever sent to the server; once connected it is not shown again.
 */
const props = defineProps<{ planner: Planner; server: ServerConnection }>()
// Outside of the planner's tab: its components still find it.
provide(PLANNER, props.planner)
const { mango, store } = props.planner
const { Button, Field } = mango.ui.components
const s = strings.server

const address = ref('')
const token = ref('')
const error = ref<string | null>(null)
const busy = ref(false)

const url = computed(() => props.server.url.value)
const said = computed(() => props.server.space.value)
const place = computed(() => store.places.value.find(p => p.id === SERVER) ?? null)
const state = computed(() => {
  const status = place.value?.status
  if (!status) return null
  if (!status.online && status.readonly) return { tone: 'bad', text: status.message ?? s.refused }
  if (!status.online) return { tone: 'warn', text: status.message ?? s.offline }
  return { tone: 'good', text: s.connected }
})
const onServer = computed(() => store.allCollections.value.filter(c => store.placeOf(c.id) === SERVER).length)

async function connect() {
  if (busy.value) return
  busy.value = true
  error.value = null
  try {
    error.value = await props.server.connect(address.value, token.value)
    if (!error.value) {
      address.value = ''
      token.value = ''
    }
  } finally {
    busy.value = false
  }
}

async function disconnect() {
  const ok = await mango.ui.confirm({ title: s.disconnectTitle, body: s.disconnectBody, confirmLabel: s.disconnect })
  if (ok) props.server.disconnect()
}
</script>

<template>
  <div class="pl-server">
    <p class="pl-server__intro">{{ s.intro }}</p>

    <template v-if="url">
      <div class="pl-server__row">
        <div class="pl-server__text">
          <div class="pl-server__label">{{ said?.space.name ?? s.space }}</div>
          <p class="pl-server__hint"><span class="pl-server__url">{{ url }}</span></p>
        </div>
        <component :is="Button" variant="secondary" @click="disconnect">{{ s.disconnect }}</component>
      </div>
      <div class="pl-server__row">
        <div class="pl-server__text">
          <div class="pl-server__label">{{ s.connection }}</div>
          <p v-if="state" class="pl-server__state" :class="`is-${state.tone}`" role="status">
            <Icon :name="state.tone === 'good' ? 'cloud' : 'cloud-off'" />{{ state.text }}
          </p>
        </div>
      </div>
      <div class="pl-server__row">
        <div class="pl-server__text">
          <div class="pl-server__label">{{ s.access }}</div>
          <p class="pl-server__hint">{{ said?.role === 'write' ? s.canEdit : s.readOnly }} · {{ s.collections(onServer) }}</p>
        </div>
      </div>
    </template>

    <form v-else class="pl-server__form" @submit.prevent="connect">
      <component :is="Field" :label="s.address" for="pl-server-address">
        <input
          id="pl-server-address"
          v-model="address"
          class="input"
          type="url"
          inputmode="url"
          placeholder="https://planner.example.com"
          autocomplete="off"
          spellcheck="false"
        >
      </component>
      <component :is="Field" :label="s.token" :hint="s.tokenHint" :error="error" for="pl-server-token">
        <input
          id="pl-server-token"
          v-model="token"
          class="input pl-server__token"
          type="password"
          placeholder="pls_…"
          autocomplete="off"
          spellcheck="false"
        >
      </component>
      <div class="pl-server__foot">
        <component :is="Button" variant="primary" type="submit" :loading="busy">{{ s.connect }}</component>
      </div>
    </form>
  </div>
</template>

<style scoped>
.pl-server { display: grid; gap: var(--space-2); max-width: 560px; }
.pl-server__intro { margin: 0 0 var(--space-2); font-size: var(--text-sm); color: var(--fg-muted); text-wrap: pretty; }
.pl-server__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-6);
  min-height: 52px;
  padding: var(--space-3) 0;
  border-top: 1px solid var(--line-soft);
}
.pl-server__text { flex: 1 1 220px; min-width: 0; }
.pl-server__label { font-size: var(--text-sm); font-weight: 560; color: var(--fg); }
.pl-server__hint { margin: 2px 0 0; font-size: var(--text-xs); color: var(--fg-subtle); }
.pl-server__url { font-family: var(--font-mono); overflow-wrap: anywhere; }
.pl-server__state { display: flex; align-items: center; gap: 6px; margin: 2px 0 0; font-size: var(--text-xs); }
.pl-server__state svg { flex: none; width: 13px; height: 13px; stroke-width: 1.85; }
.pl-server__state.is-good { color: var(--ripe-done-fg); }
.pl-server__state.is-warn { color: var(--ripe-waiting-fg); }
.pl-server__state.is-bad { color: var(--ripe-error-fg); }
.pl-server__form { display: grid; gap: var(--space-4); }
.pl-server__token { font-family: var(--font-mono); }
.pl-server__foot { display: flex; justify-content: flex-end; }
</style>
