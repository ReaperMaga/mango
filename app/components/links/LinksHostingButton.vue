<script setup lang="ts">
import { Settings } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'

/**
 * Under an error from the GitHub or GitLab CLI that points at Settings > Git hosting (not installed,
 * not signed in, a GitLab server Mango does not know yet): the way there, one click away.
 */
const props = defineProps<{ error: string | null | undefined }>()
const shown = computed(() => !!props.error && /Git hosting/i.test(props.error))
</script>

<template>
  <UiButton v-if="shown" size="sm" variant="ghost" class="hosting" @click="useWorkspace().openSettings('hosting')">
    <Settings aria-hidden="true" />Open Git hosting settings
  </UiButton>
</template>

<style scoped>
.hosting { align-self: flex-start; justify-self: start; }
</style>
