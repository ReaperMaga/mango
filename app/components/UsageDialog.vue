<script setup lang="ts">
import { RefreshCw } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'
import { useUsage, useUsageUpdated } from '~/stores/usage'

/**
 * Usage limits of every agent's plan: the 5-hour and weekly windows (and any per-model
 * limit) as each CLI reports them, with when each starts over. Reading spends no quota.
 */
const ws = useWorkspace()
const usage = useUsage()
const updated = useUsageUpdated()

const open = computed(() => ws.dialog === 'usage')
const close = () => { if (ws.dialog === 'usage') ws.dialog = null }

watch(open, (o) => { if (o) void usage.refreshReadable() }, { immediate: true })
const refresh = () => usage.refreshReadable(true)

function signIn() {
  close()
  ws.openSettings('agents', 'agents')
}
</script>

<template>
  <UiDialog :open="open" title="Usage limits" :width="580" @close="close">
    <p class="use__lede">How much of each plan's allowance is used, as Claude Code and Codex report it. Checking spends none of it.</p>

    <UsageList @sign-in="signIn" />

    <template #footer>
      <span class="use__updated" aria-live="polite">{{ updated }}</span>
      <UiButton :loading="usage.loading" @click="refresh">
        <RefreshCw v-if="!usage.loading" aria-hidden="true" />
        Refresh
      </UiButton>
      <UiButton variant="primary" data-autofocus @click="close">Done</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.use__lede {
  margin: 0 0 var(--space-2);
  max-width: 62ch;
  font-size: var(--text-sm);
  color: var(--fg-subtle);
}
.use__updated { margin-right: auto; font-size: var(--text-xs); color: var(--fg-subtle); }
</style>
