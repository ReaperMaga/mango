<script setup lang="ts">
import { ChevronRight, ExternalLink } from 'lucide-vue-next'
import { Marked } from 'marked'
import changelogSource from '~~/docs/changelog.md?raw'
import { openExternal } from '~/composables/useBackend'
import { parseChangelog } from '~/utils/changelog'
import { releaseUrl, RELEASES_URL } from '~/utils/releases'
import { safeHtml } from '~/utils/safeHtml'
import SettingsSection from './SettingsSection.vue'

/**
 * Settings > Changelog: what changed in each version, newest first, from the same file as the
 * docs site (`docs/changelog.md`, baked into the build). The version you run is marked; the
 * newest entry starts open, the rest fold away.
 */
const build = useBuildInfo()
const releases = parseChangelog(changelogSource)

/** The file is ours, but the text still goes through the allow-list before `v-html`. */
const md = new Marked({ gfm: true, renderer: { html: ({ text }) => text } })
const inline = (text: string) => safeHtml(md.parseInline(text) as string)

const open = reactive(new Set<string>(releases.slice(0, 1).map(r => r.version)))
const toggle = (v: string) => { if (!open.delete(v)) open.add(v) }

const isCurrent = (v: string) => v === build.version
const isReleased = (v: string) => /^\d/.test(v)

/** Links in an entry open in the browser, never inside Mango's window. */
function onClick(e: MouseEvent) {
  const a = (e.target as HTMLElement | null)?.closest('a')
  if (!a) return
  e.preventDefault()
  const href = a.getAttribute('href') ?? ''
  if (/^https:\/\//i.test(href)) void openExternal(href)
}
</script>

<template>
  <SettingsSection title="Changelog" description="What changed in each version of Mango.">
    <ol class="log" role="list" @click="onClick">
      <li v-for="r in releases" :key="r.version" class="log__release">
        <h3 class="log__head">
          <button type="button" class="log__toggle" :aria-expanded="open.has(r.version)" @click="toggle(r.version)">
            <ChevronRight class="log__caret" :class="{ 'is-open': open.has(r.version) }" aria-hidden="true" />
            <span class="log__version tabular">{{ r.version }}</span>
            <span v-if="isCurrent(r.version)" class="log__tag is-current">Installed</span>
          </button>
          <button
            v-if="isReleased(r.version)"
            type="button"
            class="log__link"
            :title="`Release ${r.version} on GitHub`"
            @click="openExternal(releaseUrl(r.version))"
          >
            <ExternalLink aria-hidden="true" /><span class="sr-only">Release {{ r.version }} on GitHub</span>
          </button>
        </h3>

        <div v-show="open.has(r.version)" class="log__body">
          <p v-for="(p, i) in r.intro" :key="i" class="log__intro" v-html="inline(p)" />
          <section v-for="(g, gi) in r.groups" :key="gi" class="log__group">
            <h4 v-if="g.title" class="log__group-title">{{ g.title }}</h4>
            <ul class="log__items">
              <li v-for="(it, ii) in g.items" :key="ii" v-html="inline(it)" />
            </ul>
          </section>
        </div>
      </li>
    </ol>
    <p class="log__all">
      Installers for every version are on
      <a :href="RELEASES_URL" class="log__a" @click.prevent="openExternal(RELEASES_URL)">GitHub releases</a>.
    </p>
  </SettingsSection>
</template>

<style scoped>
.log { list-style: none; margin: 0; padding: 0; }
.log__release { padding: var(--space-3) 0; border-top: 1px solid var(--line-soft); }
.log__release:first-child { border-top: 0; padding-top: 0; }

.log__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); margin: 0; min-height: 28px; }
.log__toggle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
  height: 28px;
  text-align: left;
  border-radius: var(--radius-sm);
}
.log__toggle:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.log__caret { width: 14px; height: 14px; flex: none; color: var(--fg-subtle); transition: transform var(--dur-fast) var(--ease-out); }
.log__caret.is-open { transform: rotate(90deg); }
.log__version { font-size: var(--text-md); font-weight: 600; color: var(--fg); }
.log__tag { font-size: var(--text-xs); color: var(--fg-subtle); }
.log__tag.is-current { color: var(--accent-ink); font-weight: 560; }
.log__link {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  flex: none;
  color: var(--fg-faint);
  border-radius: var(--radius-xs);
  transition: color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
.log__link:hover { color: var(--fg); background: var(--bg-hover); }
.log__link:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.log__link svg { width: 13px; height: 13px; stroke-width: 1.75; }

.log__body { padding: var(--space-1) 0 var(--space-2) calc(14px + var(--space-2)); max-width: 68ch; }
.log__intro { margin: var(--space-1) 0 var(--space-2); font-size: var(--text-sm); color: var(--fg-muted); text-wrap: pretty; }
.log__group { margin-top: var(--space-3); }
.log__group:first-child { margin-top: var(--space-1); }
.log__group-title { margin: 0 0 var(--space-1); font-size: var(--text-sm); font-weight: 560; color: var(--fg); }
.log__items { margin: 0; padding-left: var(--space-4); display: grid; gap: var(--space-1); font-size: var(--text-sm); line-height: var(--leading-normal); color: var(--fg-muted); }
.log__items li::marker { color: var(--fg-faint); }
.log__items :deep(strong) { font-weight: 560; color: var(--fg); }
.log__items :deep(code), .log__intro :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.92em;
  padding: 0 4px;
  border-radius: var(--radius-xs);
  background: var(--bg-inset);
  color: var(--fg);
}
.log__items :deep(a), .log__intro :deep(a) { color: var(--accent-ink); text-underline-offset: 2px; }

.log__all { margin: var(--space-5) 0 0; font-size: var(--text-xs); color: var(--fg-subtle); }
.log__a { color: var(--accent-ink); text-underline-offset: 2px; }
.log__a:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; border-radius: var(--radius-xs); }

.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>
