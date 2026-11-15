<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 18 })
</script>

<template>
  <svg class="mark" :width="size" :height="size" viewBox="0 0 64 64" role="img" aria-label="Mango">
    <rect width="64" height="64" rx="15" class="mark__bg" />
    <path class="mark__m" d="M18 44V21.5h4.6l9.4 13 9.4-13H46V44h-5.4V30.4L32 42.2l-8.6-11.8V44Z" />
  </svg>
</template>

<style scoped>
.mark { display: block; flex: none; }
.mark__bg { fill: var(--accent); }
.mark__m { fill: var(--accent-fg); }
</style>
