<script setup lang="ts">
/** One settings section: its heading, a sentence of context, then the controls. */
defineProps<{ title: string; description?: string }>()
const id = useId()
</script>

<template>
  <section class="sec" :aria-labelledby="id">
    <header class="sec__head">
      <h2 :id="id" class="sec__title">{{ title }}</h2>
      <p v-if="description" class="sec__desc">{{ description }}</p>
    </header>
    <slot />
  </section>
</template>

<style scoped>
.sec__head { margin-bottom: var(--space-5); }
.sec__title {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: 620;
  letter-spacing: -0.015em;
  line-height: var(--leading-tight);
}
.sec__desc {
  margin: var(--space-2) 0 0;
  max-width: 62ch;
  font-size: var(--text-sm);
  color: var(--fg-subtle);
  text-wrap: pretty;
}
</style>
