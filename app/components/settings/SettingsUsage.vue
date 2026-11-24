<script setup lang="ts">
import { RefreshCw } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'
import { useUsage, useUsageUpdated } from '~/stores/usage'
import UsageList from '~/components/UsageList.vue'
import { remotePlace } from '~/composables/envProjects'

/** Settings > Agents > Usage: the plan limits and when each one resets. Reading spends no quota. */
const { t } = useI18n()
const ws = useWorkspace()
const usage = useUsage()
const updated = useUsageUpdated()

onMounted(() => { void usage.refreshReadable() })

/** A remote project's agents are its environment's: their plans are read there. */
const where = computed(() => remotePlace(ws.activeProjectPath)?.where ?? null)
</script>

<template>
  <div class="usage">
    <div class="usage__bar">
      <span class="usage__updated" aria-live="polite">
        <template v-if="where">{{ t('agents.usage.in', { where }) }}<template v-if="updated"> · </template></template>{{ updated }}
      </span>
      <UiButton size="sm" :loading="usage.loading" @click="usage.refreshReadable(true)">
        <RefreshCw v-if="!usage.loading" aria-hidden="true" />
        {{ t('common.actions.refresh') }}
      </UiButton>
    </div>
    <UsageList @sign-in="ws.agentsTab = 'agents'" />

    <p v-if="!usage.hasReset" class="usage__none">
      {{ t('agents.usage.noReset') }}
    </p>
  </div>
</template>

<style scoped>
.usage__bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 28px;
}
.usage__none {
  max-width: 62ch;
  margin: var(--space-4) 0 0;
  padding-top: var(--space-4);
  border-top: 1px solid var(--line-soft);
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  text-wrap: pretty;
}
.usage__updated { margin-right: auto; font-size: var(--text-xs); color: var(--fg-subtle); }
</style>
