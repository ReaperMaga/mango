<script setup lang="ts">
import { CircleAlert, Info } from 'lucide-vue-next'
import { shareDay, shareExpired, useEnvironments } from '~/stores/environments'
import type { EnvJoinPreview } from '~/types/ipc'

/**
 * Join an environment someone shared: paste their link (or arrive here from a
 * `mango://join/…` deep link, already filled in), see what it is before
 * anything is saved, optionally name it, and join. Mango then connects straight
 * into that one environment; no server of the user's own is involved.
 */
const envs = useEnvironments()

const open = computed(() => envs.dialog?.kind === 'join')
const raw = ref('')
const name = ref('')
const preview = ref<EnvJoinPreview | null>(null)
const previewError = ref<string | null>(null)
const checking = ref(false)
const joining = ref(false)
const joinError = ref<string | null>(null)

/** Chat apps and mail wrap long lines: whitespace is never part of a link. */
const link = computed(() => raw.value.replace(/\s+/g, ''))

/** The field grows with the link (to six lines), so its start, mango://join/, stays in view. */
const linkRows = computed(() => Math.min(6, Math.max(3, Math.ceil(raw.value.length / 64))))
function showStart(e: ClipboardEvent) {
  const el = e.target as HTMLTextAreaElement
  nextTick(() => { el.scrollTop = 0 })
}

watch(open, (o) => {
  if (!o) return
  raw.value = envs.dialog?.kind === 'join' ? envs.dialog.link : ''
  name.value = ''
  preview.value = null
  previewError.value = null
  joinError.value = null
  joining.value = false
  if (raw.value) check()
}, { immediate: true })

/* ---------- read the link as it is pasted or typed ---------- */

const PREFIX = 'mango://join/'
let seq = 0
let debounce: ReturnType<typeof setTimeout> | undefined
async function check() {
  clearTimeout(debounce)
  const l = link.value
  const mine = ++seq
  joinError.value = null
  // Nothing yet, or still typing the start of one: nothing to say.
  if (!l || (l.length <= PREFIX.length && PREFIX.startsWith(l))) {
    preview.value = null
    previewError.value = null
    checking.value = false
    return
  }
  if (!l.startsWith(PREFIX)) {
    preview.value = null
    previewError.value = `That isn't a Mango share link. Share links start with ${PREFIX}`
    checking.value = false
    return
  }
  checking.value = true
  try {
    const p = await envs.joinPreview(l)
    if (mine !== seq) return
    preview.value = p
    previewError.value = null
  } catch (e) {
    if (mine !== seq) return
    preview.value = null
    previewError.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (mine === seq) checking.value = false
  }
}
watch(link, () => {
  if (!open.value) return
  clearTimeout(debounce)
  debounce = setTimeout(check, 250)
})
onBeforeUnmount(() => clearTimeout(debounce))

const expired = computed(() => !!preview.value && shareExpired(preview.value.expiresAt))
const canJoin = computed(() => !!preview.value && !expired.value && !checking.value && !joining.value)

async function submit() {
  if (!canJoin.value) return
  joining.value = true
  joinError.value = null
  try {
    await envs.join(link.value, name.value.trim() || null)
    envs.dialog = null
  } catch (e) {
    joinError.value = (e instanceof Error ? e.message : String(e)).replace(/\.$/, '')
  } finally {
    joining.value = false
  }
}

function close() {
  if (!joining.value) envs.dialog = null
}
</script>

<template>
  <UiDialog :open="open" title="Join a shared environment" :width="520" :dismissible="!joining" @close="close">
    <form id="env-join-form" class="jn" novalidate @submit.prevent="submit">
      <p class="jn__lede">
        Someone shared one of their environments with you. Paste the link they sent: Mango connects straight into that
        environment, with no server of your own.
      </p>

      <UiField label="Link" for="jn-link" :error="previewError">
        <textarea
          id="jn-link"
          v-model="raw"
          class="input jn__link"
          :rows="linkRows"
          placeholder="mango://join/…"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          :disabled="joining"
          :aria-invalid="!!previewError || undefined"
          @keydown.enter.exact.prevent="submit"
          @paste="showStart"
        />
      </UiField>

      <!-- what the link leads to, before anything is saved -->
      <div v-if="checking && !preview" class="jn__checking" role="status">
        <span class="ring" aria-hidden="true" />Reading the link…
      </div>
      <div v-else-if="preview" class="jn__preview" :class="{ 'is-expired': expired }" role="status">
        <p class="jn__name">{{ preview.instance }}</p>
        <dl class="jn__facts">
          <div class="jn__fact">
            <dt>Shared from</dt>
            <dd class="jn__mono selectable">{{ preview.sharedFrom }}</dd>
          </div>
          <div class="jn__fact">
            <dt>Connects to</dt>
            <dd class="jn__mono selectable">{{ preview.endpoint }}</dd>
          </div>
          <div class="jn__fact">
            <dt>Access ends</dt>
            <dd v-if="expired" class="jn__expired">Expired {{ shareDay(preview.expiresAt!) }}</dd>
            <dd v-else class="tabular">{{ preview.expiresAt ? shareDay(preview.expiresAt) : 'When the owner revokes it' }}</dd>
          </div>
        </dl>
        <p v-if="expired" class="jn__note">
          Access through this link has ended. Ask whoever shared it for a new one.
        </p>
        <p v-else-if="preview.alreadyJoined" class="jn__note">
          <Info aria-hidden="true" />You already have this; joining again replaces its key.
        </p>
      </div>

      <UiField
        v-if="preview && !expired"
        label="Name"
        for="jn-name"
        :hint="`How it's listed in Mango. Defaults to ${preview.instance}.`"
      >
        <input
          id="jn-name"
          v-model="name"
          class="input"
          type="text"
          :placeholder="preview.instance"
          autocomplete="off"
          spellcheck="false"
          :disabled="joining"
        >
      </UiField>

      <p v-if="joinError" class="jn__error" role="alert">
        <CircleAlert aria-hidden="true" />
        <span class="selectable">Couldn't join it. {{ joinError }}.</span>
      </p>
    </form>

    <template #footer>
      <UiButton variant="ghost" :disabled="joining" @click="close">Cancel</UiButton>
      <UiButton variant="primary" type="submit" form="env-join-form" :loading="joining" :disabled="!canJoin && !joining">Join</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.jn { display: grid; gap: var(--space-4); }
.jn__lede { margin: 0; font-size: var(--text-sm); color: var(--fg-subtle); text-wrap: pretty; }
.jn :deep(.field + .field) { margin-top: 0; }
.jn .input.jn__link {
  height: auto;
  min-height: 72px;
  padding: var(--space-2) var(--space-3);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  line-height: var(--leading-normal);
  word-break: break-all;
  resize: none;
}

.jn__checking {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--fg-subtle);
}

.jn__preview {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
}
.jn__preview.is-expired { border-color: color-mix(in oklch, var(--ripe-waiting) 45%, transparent); }
.jn__name {
  margin: 0;
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.jn__facts { display: grid; gap: 2px; margin: 0; }
.jn__fact { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: var(--space-2); font-size: var(--text-sm); }
.jn__fact dt { color: var(--fg-subtle); }
.jn__fact dd { margin: 0; min-width: 0; color: var(--fg-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.jn__fact dd.jn__mono { font-family: var(--font-mono); font-size: var(--text-xs); }
.jn__fact dd.jn__expired { font-weight: 560; color: var(--ripe-waiting-fg); }
.jn__note {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: var(--space-1) 0 0;
  font-size: var(--text-xs);
  color: var(--fg-muted);
  text-wrap: pretty;
}
.jn__note :deep(svg) { flex: none; width: 13px; height: 13px; margin-top: 1px; stroke-width: 1.85; color: var(--fg-subtle); }

.jn__error {
  display: flex;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--ripe-error);
}
.jn__error :deep(svg) { width: 15px; height: 15px; margin-top: 2px; flex: none; }
.jn__error span { color: var(--fg); }

.ring {
  flex: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.75px solid var(--fg-subtle);
  border-right-color: transparent;
  animation: jn-turn 0.7s linear infinite;
}
@keyframes jn-turn { to { transform: rotate(360deg); } }
</style>
