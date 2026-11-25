<script lang="ts">
import { SquareKanban } from 'lucide-vue-next'

/** Names that draw at once: icons that sit in Mango's chrome from the start. */
const AT_ONCE: Record<string, unknown> = { 'square-kanban': SquareKanban }

/** The whole library, loaded with the first other name. */
let all: Record<string, unknown> | null = null
let loading: Promise<Record<string, unknown>> | null = null
const loadAll = () => (loading ??= (import('lucide-vue-next') as unknown as Promise<Record<string, unknown>>).then(m => (all = m)))
</script>

<script setup lang="ts">
import type { Component } from 'vue'
import { Puzzle } from 'lucide-vue-next'
import type { PluginIcon } from '~/plugin-host/types'

/**
 * A plugin's icon (`PluginIcon`): a component, a lucide name in kebab-case (`git-branch`), or raw
 * `<svg>` markup. Follows `currentColor`; anything unknown shows the puzzle piece
 * (and a name that is still loading, nothing).
 */
const props = defineProps<{ icon?: PluginIcon | null }>()

const named = shallowRef<Component | null>(null)
const pending = ref(false)

const pascal = (s: string) => s.trim().replace(/(^|[-_\s]+)([a-z0-9])/gi, (_, __, c: string) => c.toUpperCase())

function find(icon: string) {
  const c = AT_ONCE[icon] ?? all?.[pascal(icon)] ?? all?.[`${pascal(icon)}Icon`]
  named.value = c ? markRaw(c as Component) : null
}

watch(() => props.icon, async (icon) => {
  named.value = null
  pending.value = false
  if (typeof icon !== 'string' || icon.trim().startsWith('<')) return
  find(icon)
  if (named.value || all) return
  pending.value = true
  try { await loadAll() } catch { loading = null }
  if (props.icon !== icon) return
  find(icon)
  pending.value = false
}, { immediate: true })

/**
 * Markup becomes an `<svg>` of its own, like lucide's: the styles a place gives its icons (size,
 * stroke, colour) then reach it. The template element is inert while it is read.
 */
const svg = computed(() => {
  if (typeof props.icon !== 'string' || !props.icon.trim().startsWith('<svg')) return null
  const box = document.createElement('template')
  box.innerHTML = props.icon.trim()
  const root = box.content.firstElementChild
  if (!root) return null
  const attrs: Record<string, string> = { width: '24', height: '24' }
  for (const { name, value } of root.attributes) if (/^[A-Za-z][\w:.-]*$/.test(name) && !name.startsWith('xmlns')) attrs[name] = value
  return { attrs, body: root.innerHTML }
})
const component = computed<Component>(() =>
  // A component is an object, or a function (lucide's are).
  props.icon && typeof props.icon !== 'string' ? markRaw(props.icon as Component) : named.value ?? Puzzle)
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- a plugin's own icon markup (plugins are trusted code) -->
  <svg v-if="svg" v-bind="svg.attrs" aria-hidden="true" v-html="svg.body" />
  <svg v-else-if="pending" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" />
  <component :is="component" v-else aria-hidden="true" />
</template>
