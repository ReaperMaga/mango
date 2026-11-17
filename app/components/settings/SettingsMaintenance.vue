<script setup lang="ts">
import SettingsSection from './SettingsSection.vue'
import SettingsAbout from './SettingsAbout.vue'
import SettingsUpdates from './SettingsUpdates.vue'
</script>

<template>
  <SettingsSection title="Maintenance" description="Keep Mango up to date, and see which version you are running.">
    <div class="maintenance">
      <SettingsUpdates />
      <SettingsAbout />
    </div>
  </SettingsSection>
</template>

<style scoped>
/* Updates leaves room above it for the groups it follows elsewhere; here it is first. */
.maintenance :deep(.updates) { margin-top: 0; }
</style>
