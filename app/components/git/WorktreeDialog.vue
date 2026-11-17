<script setup lang="ts">
import { Check, ChevronDown, CircleAlert, FolderGit2, GitBranch } from 'lucide-vue-next'
import type { MenuItem } from '~/types/ui'
import type { GitWorktree } from '~/types/ipc'
import { useWorkspace } from '~/stores/workspace'
import { useThreads } from '~/stores/threads'
import { useGit } from '~/stores/git'
import { baseName } from '~/utils/paths'
import { parseEnvPath } from '~/utils/envPath'
import { branchNameProblem, suggestBranch, worktreeName } from '~/utils/worktrees'

/**
 * "New chat in a worktree": the chat gets its own folder and branch (a linked git worktree beside
 * the repository), so it can work while the project's other chats do. Or pick a worktree that is
 * already there and start another chat in it.
 */
const ws = useWorkspace()
const threads = useThreads()
const git = useGit()

const open = computed(() => ws.dialog === 'worktree')
const project = computed(() => ws.activeProjectPath)
const status = computed(() => git.status(project.value))

const branch = ref('')
const from = ref<string | null>(null)
const touched = ref(false)
const busy = ref(false)
/** The existing worktree a chat is being started in (its row shows the spinner). */
const busyFolder = ref<string | null>(null)
const error = ref<string | null>(null)

const localBranches = computed(() => git.repo(project.value)?.branches?.local ?? [])
const worktrees = computed(() => git.worktrees(project.value))
/** Branches some worktree has checked out: git will not check them out a second time. */
const checkedOut = computed(() => new Set(worktrees.value.map(w => w.branch).filter((b): b is string => !!b)))
const linked = computed(() => worktrees.value.filter(w => !w.isCurrent))

const reason = (e: unknown) => (typeof e === 'string' ? e : e instanceof Error ? e.message : String(e)).trim().replace(/\.$/, '')

watch(open, async (isOpen) => {
  if (!isOpen || !project.value) return
  touched.value = false
  busy.value = false
  busyFolder.value = null
  error.value = null
  from.value = status.value?.branch ?? null
  branch.value = suggestBranch([...localBranches.value, ...checkedOut.value])
  // Fresh lists: a worktree or branch may have been made in a terminal since.
  await Promise.all([git.loadBranches(project.value), git.loadWorktrees(project.value)])
  if (!touched.value) branch.value = suggestBranch([...localBranches.value, ...checkedOut.value])
  from.value ??= status.value?.branch ?? null
}, { immediate: true })

const name = computed(() => branch.value.trim())
const nameError = computed(() => {
  const problem = branchNameProblem(name.value)
  if (problem) return problem
  if (checkedOut.value.has(name.value)) return `${name.value} is already checked out in a worktree; pick it from the list below`
  return null
})
/** An existing branch of that name is checked out into the new worktree instead of being created. */
const reuses = computed(() => !nameError.value && localBranches.value.includes(name.value))
const shownError = computed(() => (touched.value || name.value ? nameError.value : null))

const fromItems = computed<MenuItem[]>(() => localBranches.value.map(b => ({
  label: b,
  checked: b === from.value,
  hint: b === status.value?.branch ? 'Checked out in the project' : undefined,
  onSelect: () => { from.value = b },
})))

/** Where the folder will be: `<parent>/<repo>.worktrees/<branch with / as ->`, as the backend names it. */
const preview = computed(() => {
  const s = status.value
  const main = s?.mainRoot ?? s?.root ?? null
  const leaf = (name.value || 'branch').replace(/\//g, '-')
  if (!main) return null
  const loc = parseEnvPath(project.value)
  const tidy = (p: string) => (loc ? p : p.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~'))
  const repoDir = main.replace(/[\\/]+$/, '')
  const cut = Math.max(repoDir.lastIndexOf('/'), repoDir.lastIndexOf('\\'))
  const sep = repoDir.includes('\\') && !repoDir.includes('/') ? '\\' : '/'
  return { base: `${tidy(repoDir.slice(0, cut + 1))}${baseName(repoDir)}.worktrees${sep}`, leaf }
})

const usersOf = (w: GitWorktree) => threads.threads.filter(t => t.worktree === w.path && !t.parentId && !t.archived).length

function close() {
  if (busy.value) return
  if (ws.dialog === 'worktree') ws.dialog = null
}

async function submit() {
  touched.value = true
  error.value = null
  if (nameError.value || busy.value || !project.value) return
  busy.value = true
  try {
    await threads.createInWorktree(project.value, {
      branch: name.value,
      from: reuses.value ? null : from.value,
      create: !reuses.value,
    })
    ws.dialog = null
  } catch (e) {
    error.value = reason(e)
  } finally {
    busy.value = false
  }
}

async function continueIn(w: GitWorktree) {
  if (busy.value || !project.value) return
  busy.value = true
  busyFolder.value = w.path
  error.value = null
  try {
    await threads.createInWorktree(project.value, { existing: w.path })
    ws.dialog = null
  } catch (e) {
    error.value = reason(e)
  } finally {
    busy.value = false
    busyFolder.value = null
  }
}
</script>

<template>
  <UiDialog :open="open" title="New chat in a worktree" :width="500" :dismissible="!busy" @close="close">
    <form id="worktree-form" class="wt" novalidate @submit.prevent="submit">
      <p class="wt__lede">
        The chat gets its own folder on its own branch, so it can work while other chats do. The project folder is left as it is.
      </p>

      <UiField
        label="Branch"
        for="wt-branch"
        :error="shownError"
        :hint="reuses ? `${name} exists: the worktree checks it out` : undefined"
      >
        <input
          id="wt-branch"
          v-model="branch"
          class="input wt__mono"
          type="text"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          :disabled="busy"
          :aria-invalid="!!shownError || undefined"
          @input="touched = true"
        >
      </UiField>

      <UiField v-if="!reuses" label="Start from" for="wt-from">
        <UiMenu :items="fromItems" placement="bottom-start" :width="300" label="Start from branch">
          <template #default="{ toggle, open: menuOpen }">
            <button
              id="wt-from"
              type="button"
              class="wt__select"
              :class="{ 'is-open': menuOpen }"
              :disabled="busy || !fromItems.length"
              aria-haspopup="menu"
              :aria-expanded="menuOpen"
              @click="toggle"
            >
              <GitBranch aria-hidden="true" />
              <span class="wt__select-text">{{ from ?? 'Current commit' }}</span>
              <ChevronDown class="wt__chev" aria-hidden="true" />
            </button>
          </template>
        </UiMenu>
      </UiField>

      <p v-if="preview" class="wt__preview" aria-live="polite">
        <FolderGit2 aria-hidden="true" />
        <span class="wt__preview-path selectable" :title="preview.base + preview.leaf">
          <span class="wt__preview-inner"><span class="wt__preview-base">{{ preview.base }}</span><span class="wt__preview-leaf">{{ preview.leaf }}</span></span>
        </span>
      </p>

      <p v-if="error" class="wt__error" role="alert">
        <CircleAlert aria-hidden="true" />
        <span class="selectable">Couldn't start the chat in a worktree. {{ error }}.</span>
      </p>

      <section v-if="linked.length" class="wt__existing" aria-labelledby="wt-existing">
        <h3 id="wt-existing" class="wt__existing-title">Or continue in a worktree that is already there</h3>
        <ul class="wt__list" role="list">
          <li v-for="w in linked" :key="w.path" class="wt__row">
            <FolderGit2 class="wt__row-icon" aria-hidden="true" />
            <span class="wt__row-text">
              <span class="wt__row-name" :title="w.path">{{ worktreeName(w.path) }}</span>
              <span class="wt__row-meta">
                <span class="wt__mono-sm">{{ w.branch ?? (w.head ? `${w.head} (detached)` : 'detached') }}</span>
                <template v-if="w.prunable"> · folder is gone</template>
                <template v-else-if="usersOf(w)"> · {{ usersOf(w) }} chat{{ usersOf(w) === 1 ? '' : 's' }}</template>
              </span>
            </span>
            <UiButton
              size="sm"
              :loading="busyFolder === w.path"
              :disabled="busy || w.prunable"
              @click="continueIn(w)"
            >
              New chat here
            </UiButton>
          </li>
        </ul>
      </section>
    </form>

    <template #footer>
      <UiButton variant="ghost" :disabled="busy" @click="close">Cancel</UiButton>
      <UiButton variant="primary" type="submit" form="worktree-form" :loading="busy && !busyFolder" :disabled="busy && !!busyFolder">
        <Check v-if="!busy" />{{ busy && !busyFolder ? 'Creating…' : 'Create worktree' }}
      </UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.wt { display: grid; }
.wt__lede {
  margin: 0 0 var(--space-4);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--fg-muted);
}
.wt .input.wt__mono { font-family: var(--font-mono); font-size: var(--text-xs); }
.wt .input:disabled { color: var(--fg-muted); cursor: default; }

.wt__select {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  height: 32px;
  padding: 0 var(--space-2) 0 var(--space-3);
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  color: var(--fg);
  text-align: left;
  transition: border-color var(--dur-fast) var(--ease-out);
}
.wt__select:hover:not(:disabled), .wt__select.is-open { border-color: var(--line-strong); }
.wt__select:disabled { opacity: 0.55; }
.wt__select svg { width: 14px; height: 14px; flex: none; stroke-width: 1.75; color: var(--fg-subtle); }
.wt__select .wt__chev { width: 13px; height: 13px; color: var(--fg-faint); }
.wt__select-text {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.wt__preview {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-5) 0 0;
  padding: var(--space-2) var(--space-3);
  background: var(--bg-inset);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
}
.wt__preview :deep(svg) { width: 14px; height: 14px; stroke-width: 1.75; color: var(--fg-subtle); flex: none; }
.wt__preview-path {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}
.wt__preview-inner { direction: ltr; unicode-bidi: isolate; }
.wt__preview-base { color: var(--fg-subtle); }
.wt__preview-leaf { color: var(--fg); font-weight: 600; }

.wt__error {
  display: flex;
  gap: var(--space-2);
  margin: var(--space-3) 0 0;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--ripe-error-fg);
}
.wt__error :deep(svg) { width: 15px; height: 15px; margin-top: 2px; flex: none; }
.wt__error span { color: var(--fg); }

.wt__existing { margin-top: var(--space-6); }
.wt__existing-title {
  margin: 0 0 var(--space-2);
  font-size: var(--text-xs);
  font-weight: 560;
  color: var(--fg-muted);
}
.wt__list { display: grid; margin: 0; padding: 0; list-style: none; }
.wt__row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 44px;
  padding: var(--space-1) 0;
}
.wt__row + .wt__row { border-top: 1px solid var(--line-soft); }
.wt__row-icon { width: 15px; height: 15px; flex: none; stroke-width: 1.75; color: var(--fg-subtle); }
.wt__row-text { flex: 1; min-width: 0; display: grid; }
.wt__row-name {
  font-size: var(--text-sm);
  font-weight: 560;
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wt__row-meta {
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wt__mono-sm { font-family: var(--font-mono); font-size: var(--text-2xs); }
</style>
