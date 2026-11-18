<script setup lang="ts">
import { Marked } from 'marked'
import type { Attachment } from '~/types/chat'
import { chatImage, localImagePath } from '~/utils/chatImages'
import { openImage } from '~/utils/imageViewer'
import { baseName } from '~/utils/paths'
import { useBrowser } from '~/stores/browser'

/**
 * Renders agent markdown. Raw HTML in the source is escaped, never injected:
 * agent output is untrusted text. Pictures (`![alt](path)`) are shown only from
 * files on this computer, or inside the environment for a remote project, never fetched
 * from the web; `base` is the chat's project folder, for relative paths. A link to a dev server on this computer (localhost and the
 * like) opens in Mango's browser beside the chat; other links open as they always have.
 */
const props = defineProps<{ text: string; streaming?: boolean; base?: string | null; threadId?: string | null }>()

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

/** The pictures of the last render, in order, for the viewer. */
let shown: Attachment[] = []

const md = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html({ text }) { return escape(text) },
    link({ href, text }) {
      const safe = /^(https?:|mailto:)/i.test(href) ? href : '#'
      return `<a href="${escape(safe)}" target="_blank" rel="noopener noreferrer">${text}</a>`
    },
    image({ href, text }) {
      const path = localImagePath(href)
      if (!path) return escape(text)
      const name = text.trim() || baseName(path)
      const s = chatImage(path, props.base ?? null)
      if (s.status === 'loading') return `<span class="md__img-note">${escape(name)}</span>`
      if (s.status === 'error') return `<span class="md__img-note is-error" title="${escape(s.error)}">${escape(name)}: picture not found</span>`
      const i = shown.push({ id: `md-img-${shown.length}`, name, path, mime: s.mime, size: s.size, kind: 'image', thumb: s.url }) - 1
      return `<button type="button" class="md__img" data-img="${i}" aria-label="Open picture: ${escape(name)}"><img src="${escape(s.url)}" alt="${escape(text)}"></button>`
    },
  },
})

const html = computed(() => {
  shown = []
  return md.parse(props.text) as string
})

function onClick(e: MouseEvent) {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-img]')
  if (el) { openImage(shown, Number(el.dataset.img)); return }
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href]')
  if (a && e.button === 0 && useBrowser().openLink(a.href, props.base ?? null, props.threadId ?? null)) e.preventDefault()
}
</script>

<template>
  <div class="md selectable" :class="{ 'is-streaming': streaming }" @click="onClick" v-html="html" />
</template>

<style scoped>
.md { font-size: var(--text-md); line-height: var(--leading-chat); color: var(--fg); overflow-wrap: anywhere; }
.md :deep(> *:first-child) { margin-top: 0; }
.md :deep(> *:last-child) { margin-bottom: 0; }
.md :deep(p) { margin: 0 0 0.7em; }
.md :deep(ul), .md :deep(ol) { margin: 0 0 0.8em; padding-left: 1.3em; }
.md :deep(li) { margin: 0.2em 0; }
.md :deep(li::marker) { color: var(--fg-faint); }
.md :deep(h1), .md :deep(h2), .md :deep(h3) { font-size: var(--text-lg); font-weight: 640; margin: 1.2em 0 0.4em; letter-spacing: -0.01em; }
.md :deep(strong) { font-weight: 640; }
.md :deep(code) {
  font-size: 0.88em;
  padding: 0.1em 0.38em;
  border-radius: var(--radius-xs);
  background: var(--bg-hover);
  border: 1px solid var(--line-soft);
}
.md :deep(pre) {
  margin: 0 0 0.8em;
  padding: var(--space-3) var(--space-4);
  background: var(--bg-inset);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  overflow-x: auto;
  font-size: var(--text-sm);
  line-height: 1.55;
}
.md :deep(pre code) { padding: 0; border: 0; background: none; font-size: inherit; }
.md :deep(blockquote) { margin: 0 0 0.8em; padding-left: var(--space-3); border-left: 1px solid var(--line-strong); color: var(--fg-muted); }
.md :deep(a) { color: var(--accent-ink); }
.md :deep(hr) { border: 0; height: 1px; background: var(--line-soft); margin: 1.2em 0; }
.md :deep(table) { border-collapse: collapse; margin: 0 0 0.8em; font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
.md :deep(th), .md :deep(td) { padding: 4px 10px; border-bottom: 1px solid var(--line-soft); text-align: left; }
.md :deep(th) { color: var(--fg-muted); font-weight: 600; }

/* A picture from the agent: framed on the inset ground, capped in height, opens full size on click. */
.md :deep(.md__img) {
  display: block;
  max-width: 100%;
  margin: 0.3em 0 0.7em;
  padding: 0;
  overflow: hidden;
  background: var(--bg-inset);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  cursor: zoom-in;
  transition: border-color var(--dur-fast) var(--ease-out);
}
.md :deep(.md__img:hover) { border-color: var(--line-strong); }
.md :deep(.md__img:focus-visible) { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.md :deep(.md__img img) { display: block; max-width: 100%; max-height: 420px; height: auto; object-fit: contain; }
/* While it loads, or when it cannot be shown: its name in quiet ink. */
.md :deep(.md__img-note) { color: var(--fg-subtle); font-size: var(--text-sm); }
.md :deep(.md__img-note.is-error) { color: var(--fg-faint); }

.md.is-streaming :deep(> *:last-child)::after {
  content: '';
  display: inline-block;
  width: 7px;
  height: 1.05em;
  margin-left: 2px;
  vertical-align: -0.15em;
  border-radius: 1px;
  background: var(--accent);
  animation: caret 1s steps(2) infinite;
}
@keyframes caret { 50% { opacity: 0; } }
</style>
