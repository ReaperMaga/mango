<script setup lang="ts">
import type { PropertyType } from '../model.ts'
import Icon from './Icon.vue'
import { PROPERTY_ICONS } from './propertyIcons.ts'

defineProps<{ type: PropertyType }>()
</script>

<template>
  <Icon :name="PROPERTY_ICONS[type]" />
</template>
