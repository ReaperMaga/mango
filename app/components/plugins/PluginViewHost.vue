<script setup lang="ts">
import type { Component } from 'vue'
import type { PluginView } from '~/plugin-host/types'
import { report } from '~/plugin-host/registry'

/**
 * Shows UI a plugin hands in (`PluginView`): a Vue component, or a `mount(el, ctx)` that fills an
 * element and may return a cleanup. Used for tool windows, tabs, dialogs, settings pages and code
 * blocks. Anything that throws while mounting or rendering lands in the plugin's log and leaves a
 * quiet note here instead of breaking the app around it.
 *
 * A component gets `ctx` as a prop when it declares one (`props: ['ctx']`); every component can
 * also `inject('mango:ctx')`.
 */
const props = defineProps<{
  view: PluginView<any>
  ctx?: unknown
  pluginId: string
}>()

const { t } = useI18n()
const failed = ref<string | null>(null)
const el = ref<HTMLElement | null>(null)
let cleanup: (() => void) | null = null

provide('mango:ctx', computed(() => props.ctx))

const component = computed<Component | null>(() =>
  props.view && 'component' in props.view && props.view.component ? markRaw(props.view.component) : null)

/** `ctx` goes in as a prop only to a component that asks for it, so it never lands in the DOM as an attribute. */
const componentProps = computed(() => {
  const c = component.value as { props?: unknown } | null
  const declared = c?.props
  const wantsCtx = Array.isArray(declared) ? declared.includes('ctx') : !!declared && typeof declared === 'object' && 'ctx' in declared
  const own = props.view && 'component' in props.view ? props.view.props ?? {} : {}
  return wantsCtx ? { ...own, ctx: props.ctx } : own
})

function fail(e: unknown, where: string) {
  report(props.pluginId, e, where)
  failed.value = e instanceof Error ? e.message : String(e)
}

function unmount() {
  const fn = cleanup
  cleanup = null
  if (fn) {
    try { fn() } catch (e) { report(props.pluginId, e, 'view cleanup') }
  }
  if (el.value) el.value.replaceChildren()
}

function mount() {
  unmount()
  const v = props.view
  if (!v || !('mount' in v) || typeof v.mount !== 'function' || !el.value || failed.value) return
  try {
    const r = v.mount(el.value, props.ctx as never)
    if (typeof r === 'function') cleanup = r
  } catch (e) {
    fail(e, 'view mount')
  }
}

onMounted(mount)
watch(() => props.view, () => {
  failed.value = null
  void nextTick(mount)
})
onBeforeUnmount(unmount)

onErrorCaptured((e) => {
  fail(e, 'view')
  return false
})

function retry() {
  failed.value = null
  void nextTick(mount)
}
</script>

<template>
  <div class="pvh">
    <div v-if="failed" class="pvh__failed" role="status">
      <p class="pvh__msg">{{ t('plugins.view.failed', { error: failed }) }}</p>
      <button type="button" class="pvh__retry" @click="retry">{{ t('common.actions.retry') }}</button>
    </div>
    <component :is="component" v-else-if="component" v-bind="componentProps" />
    <div v-else ref="el" class="pvh__mount" />
  </div>
</template>

<style scoped>
.pvh {
  display: contents;
}
.pvh__mount {
  display: contents;
}
.pvh__failed {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
}
.pvh__msg {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--fg-muted);
  text-wrap: pretty;
}
.pvh__retry {
  font: inherit;
  font-size: var(--text-sm);
  color: var(--accent-ink);
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
}
.pvh__retry:hover { text-decoration: underline; }
.pvh__retry:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; border-radius: var(--radius-sm); }
</style>
