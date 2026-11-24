<script setup lang="ts">
import SettingsSection from './SettingsSection.vue'
import McpServerList from './McpServerList.vue'

/**
 * Settings > MCP servers: the tool servers every chat on this computer is offered. A project's own
 * are under Projects. The agents' own settings (Claude Code's ~/.claude.json and .mcp.json, Codex's
 * config.toml) keep working beside these.
 */
const { t } = useI18n()
</script>

<template>
  <SettingsSection
    :title="t('settings.nav.mcp')"
    :description="t('settings.mcp.description')"
  >
    <McpServerList :project="null" />
    <i18n-t keypath="settings.mcp.foot" tag="p" scope="global" class="foot">
      <template #claudeJson><code>~/.claude.json</code></template>
      <template #mcpJson><code>.mcp.json</code></template>
      <template #configToml><code>config.toml</code></template>
    </i18n-t>
  </SettingsSection>
</template>

<style scoped>
.foot {
  margin: var(--space-6) 0 0;
  max-width: 64ch;
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  text-wrap: pretty;
}
.foot code { font-size: var(--text-xs); color: var(--fg-muted); }
</style>
