<script setup lang="ts">
import { useData } from 'vitepress'
import type { ThemeConfig } from '../../config'

/** The version the docs describe, as `v0.1.0`, linked to its release page unless `plain`. */
defineProps<{ plain?: boolean }>()
const { theme } = useData<ThemeConfig>()
</script>

<template>
  <code v-if="plain">{{ theme.release.tag }}</code>
  <a v-else :href="theme.release.url"><code>{{ theme.release.tag }}</code></a>
</template>
