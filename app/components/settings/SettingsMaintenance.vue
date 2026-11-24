<script setup lang="ts">
import SettingsSection from './SettingsSection.vue'
import SettingsAbout from './SettingsAbout.vue'
import SettingsUpdates from './SettingsUpdates.vue'

const { t } = useI18n()
</script>

<template>
  <SettingsSection :title="t('settings.nav.maintenance')" :description="t('settings.maintenance')">
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
