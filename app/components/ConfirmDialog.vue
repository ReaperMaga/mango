<script setup lang="ts">
import { useWorkspace } from '~/stores/workspace'

/** The yes/no question `ws.confirmThen` raises before a chat is archived or deleted (Settings > Preferences turns it off). */
const ws = useWorkspace()

function close() {
  ws.confirm = null
}
function accept() {
  const ask = ws.confirm
  ws.confirm = null
  ask?.run()
}
</script>

<template>
  <UiDialog :open="!!ws.confirm" :title="ws.confirm?.title ?? ''" :width="420" @close="close">
    <p v-if="ws.confirm" class="cd__body">{{ ws.confirm.body }}</p>
    <template #footer>
      <UiButton variant="ghost" data-autofocus @click="close">Cancel</UiButton>
      <UiButton :variant="ws.confirm?.danger ? 'danger' : 'primary'" @click="accept">{{ ws.confirm?.label }}</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.cd__body {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--fg-muted);
  text-wrap: pretty;
}
</style>
