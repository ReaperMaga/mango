<script setup lang="ts">
import type { Component } from 'vue'
import { Puzzle } from 'lucide-vue-next'
import type { PluginIcon } from '~/plugin-host/types'

/**
 * A plugin's icon (`PluginIcon`): a component, a lucide name in kebab-case (`git-branch`), or raw
 * `<svg>` markup. Follows `currentColor`; anything unknown shows the puzzle piece.
 */
const props = defineProps<{ icon?: PluginIcon | null }>()

let lucide: Promise<Record<string, unknown>> | null = null
const named = shallowRef<Component | null>(null)

const pascal = (s: string) => s.trim().replace(/(^|[-_\s]+)([a-z0-9])/gi, (_, __, c: string) => c.toUpperCase())

watch(() => props.icon, async (icon) => {
  named.value = null
  if (typeof icon !== 'string' || icon.trim().startsWith('<')) return
  lucide ??= import('lucide-vue-next') as unknown as Promise<Record<string, unknown>>
  const mod = await lucide
  const c = mod[pascal(icon)] ?? mod[`${pascal(icon)}Icon`]
  if (props.icon === icon) named.value = c ? markRaw(c as Component) : null
}, { immediate: true })

const svg = computed(() => (typeof props.icon === 'string' && props.icon.trim().startsWith('<svg') ? props.icon : null))
const component = computed<Component>(() =>
  props.icon && typeof props.icon === 'object' ? markRaw(props.icon as Component) : named.value ?? Puzzle)
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- a plugin's own icon markup (plugins are trusted code) -->
  <span v-if="svg" class="picon" aria-hidden="true" v-html="svg" />
  <component :is="component" v-else aria-hidden="true" />
</template>

<style scoped>
.picon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.picon :deep(svg) {
  width: 100%;
  height: 100%;
}
</style>
