<script setup lang="ts">
import { computed } from 'vue'
import { useData } from 'vitepress'
import type { ThemeConfig } from '../../config'

/** Every installer of the current release, one row each, with a direct download link. */
const props = defineProps<{ platform?: 'Windows' | 'Linux' }>()
const { theme } = useData<ThemeConfig>()
const release = computed(() => theme.value.release)
const assets = computed(() => release.value.assets.filter(a => !props.platform || a.platform === props.platform))
</script>

<template>
  <table class="downloads">
    <thead>
      <tr>
        <th>Platform</th>
        <th>Format</th>
        <th>File</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="a in assets" :key="a.id">
        <td>{{ a.platform }}</td>
        <td>
          {{ a.format }}
          <span v-if="a.recommended" class="downloads__tag">Recommended</span>
          <span v-if="a.note" class="downloads__note">{{ a.note }}</span>
        </td>
        <td><a :href="a.url" class="downloads__file"><code>{{ a.file }}</code></a></td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.downloads td { vertical-align: top; }
.downloads__tag {
  margin-left: 6px;
  padding: 1px 6px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 4px;
  font-size: 12px;
  color: var(--vp-c-brand-1);
  white-space: nowrap;
}
.downloads__note {
  display: block;
  font-size: 13px;
  color: var(--vp-c-text-2);
}
.downloads__file { white-space: nowrap; }
</style>
