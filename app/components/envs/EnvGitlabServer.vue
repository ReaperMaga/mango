<script setup lang="ts">
import { GITHUB_COM, normalizeHost } from '~/utils/gitHosts'

/**
 * A self-managed GitLab server typed in place, for a glab sign-in inside an environment
 * (the sign-in menus offer gitlab.com and the servers Mango knows; this is "Another server…").
 * Emits the name cleaned up the way the backend stores it; the backend checks it again.
 */
const props = withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })
const emit = defineEmits<{ pick: [host: string]; cancel: [] }>()

const { t } = useI18n()
const id = useId()
const value = ref('')
const touched = ref(false)
const input = ref<HTMLInputElement | null>(null)

const problem = computed(() => {
  if (!value.value.trim()) return t('envs.gitlab.empty')
  const host = normalizeHost(value.value)
  if (!host) return t('envs.gitlab.invalid')
  if (host === GITHUB_COM) return t('envs.gitlab.github')
  return null
})

function submit() {
  touched.value = true
  const host = normalizeHost(value.value)
  if (problem.value || !host) return
  emit('pick', host)
}

onMounted(() => input.value?.focus())
</script>

<template>
  <form class="gls" :class="{ 'gls--compact': props.compact }" novalidate @submit.prevent="submit" @keydown.esc.stop="emit('cancel')">
    <UiField
      :label="t('envs.instance.gitlabServer')"
      :for="id"
      :error="touched ? problem : null"
      :hint="t('envs.gitlab.hint')"
    >
      <div class="gls__row">
        <input
          :id="id"
          ref="input"
          v-model="value"
          class="input gls__input"
          type="text"
          placeholder="gitlab.example.com"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          :aria-invalid="(touched && !!problem) || undefined"
        >
        <UiButton type="submit">{{ t('common.actions.signIn') }}</UiButton>
        <UiButton variant="ghost" @click="emit('cancel')">{{ t('common.actions.cancel') }}</UiButton>
      </div>
    </UiField>
  </form>
</template>

<style scoped>
.gls { max-width: 520px; }
.gls__row { display: flex; align-items: center; gap: var(--space-2); }
.gls__row .gls__input { flex: 1; min-width: 0; height: 30px; }
.gls--compact { max-width: none; }
</style>
