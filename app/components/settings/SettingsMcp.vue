<script setup lang="ts">
import SettingsSection from './SettingsSection.vue'
import McpServerList from './McpServerList.vue'

/**
 * Settings > MCP servers: the tool servers every chat on this computer is offered. A project's own
 * are under Projects. The agents' own settings (Claude Code's ~/.claude.json and .mcp.json, Codex's
 * config.toml) keep working beside these.
 */
</script>

<template>
  <SettingsSection
    title="MCP servers"
    description="Tool servers your agents can use in chats, in every project on this computer. A server is started for each chat that uses it, and changes apply from the next message."
  >
    <McpServerList :project="null" />
    <p class="foot">
      Servers in Claude Code's own settings (<code>~/.claude.json</code>, a project's <code>.mcp.json</code>) and in Codex's
      <code>config.toml</code> keep working. A server here with the same name takes their place in Mango's chats.
      Remote projects don't get these: add servers to the project itself under Projects, and they run inside its environment.
    </p>
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
