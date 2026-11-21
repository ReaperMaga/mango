<script setup lang="ts">
import { Marked } from 'marked'
import { h, render } from 'vue'
import type { Attachment } from '~/types/chat'
import { chatImage, localImagePath } from '~/utils/chatImages'
import { openImage } from '~/utils/imageViewer'
import { baseName } from '~/utils/paths'
import { useBrowser } from '~/stores/browser'
import { copyText } from '~/utils/clipboard'
import { reg as pluginReg, type Owned } from '~/plugin-host/registry'
import type { PluginCodeBlockRenderer } from '~/plugin-host/types'
import PluginViewHost from '~/components/plugins/PluginViewHost.vue'

/**
 * Renders agent markdown. Raw HTML in the source is escaped, never injected:
 * agent output is untrusted text. Pictures (`![alt](path)`) are shown only from
 * files on this computer, or inside the environment for a remote project, never fetched
 * from the web; `base` is the chat's project folder, for relative paths. A link to a dev server on this computer (localhost and the
 * like) opens in Mango's browser beside the chat; other links open as they always have.
 *
 * A fenced block in a language a plugin renders (`chat.codeBlocks`) becomes an empty placeholder;
 * once the reply has finished streaming the plugin's view is mounted into it and gets the code as
 * data (never as HTML).
 */
const props = defineProps<{ text: string; streaming?: boolean; base?: string | null; threadId?: string | null }>()

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

/** The pictures of the last render, in order, for the viewer. */
let shown: Attachment[] = []
/** Code blocks plugins render, of the last render, in order. */
let blocks: Array<{ code: string; language: string; renderer: Owned<PluginCodeBlockRenderer> }> = []

const md = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html({ text }) { return escape(text) },
    // A code block carries its own copy button; the click is handled once for the whole reply (see onClick).
    code({ text, lang }) {
      const name = (lang ?? '').trim().split(/\s+/)[0] ?? ''
      const renderer = name && !props.streaming ? pluginReg.codeBlocks.find(r => r.languages.includes(name.toLowerCase())) : undefined
      if (renderer) {
        const i = blocks.push({ code: text, language: name.toLowerCase(), renderer }) - 1
        return `<div class="md__plugin" data-plugin-block="${i}"></div>\n`
      }
      return `<div class="md__code"><button type="button" class="md__copy" data-copy aria-label="Copy code">Copy</button><pre><code${name ? ` class="language-${escape(name)}"` : ''}>${escape(text)}</code></pre></div>\n`
    },
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
  blocks = []
  // Read here so a renderer coming or going re-renders the reply.
  void pluginReg.codeBlocks.length
  return md.parse(props.text) as string
})

/* Plugin views into their placeholders, after each render (v-html replaced the old ones). */
const root = ref<HTMLElement | null>(null)
const appContext = getCurrentInstance()?.appContext ?? null
let filled: HTMLElement[] = []
function unmountBlocks() {
  for (const el of filled) render(null, el)
  filled = []
}
function mountBlocks() {
  unmountBlocks()
  for (const el of root.value?.querySelectorAll<HTMLElement>('[data-plugin-block]') ?? []) {
    const b = blocks[Number(el.dataset.pluginBlock)]
    if (!b) continue
    const vnode = h(PluginViewHost, { view: b.renderer.view, ctx: { code: b.code, language: b.language, threadId: props.threadId ?? '' }, pluginId: b.renderer.pluginId })
    vnode.appContext = appContext
    render(vnode, el)
    filled.push(el)
  }
}
watch(html, mountBlocks, { flush: 'post' })
onMounted(mountBlocks)
onBeforeUnmount(unmountBlocks)

function onClick(e: MouseEvent) {
  const copy = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-copy]')
  if (copy) {
    const code = copy.parentElement?.querySelector('code')?.textContent ?? ''
    void copyText(code).then((ok) => {
      if (!ok) return
      copy.textContent = 'Copied'
      setTimeout(() => { if (copy.isConnected) copy.textContent = 'Copy' }, 1600)
    })
    return
  }
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-img]')
  if (el) { openImage(shown, Number(el.dataset.img)); return }
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href]')
  if (a && e.button === 0 && useBrowser().openLink(a.href, props.base ?? null, props.threadId ?? null)) e.preventDefault()
}
</script>

<template>
  <div ref="root" class="md selectable" :class="{ 'is-streaming': streaming }" @click="onClick" v-html="html" />
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
.md :deep(.md__code) { position: relative; margin: 0 0 0.8em; }
.md :deep(.md__plugin) { margin: 0 0 0.8em; min-width: 0; }
.md :deep(.md__code pre) { margin: 0; }
.md :deep(.md__copy) {
  position: absolute;
  top: var(--space-1);
  right: var(--space-1);
  height: 22px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-xs);
  background: var(--bg-raised);
  border: 1px solid var(--line-soft);
  color: var(--fg-subtle);
  font-size: var(--text-xs);
  font-family: inherit;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.md :deep(.md__code:hover .md__copy), .md :deep(.md__copy:focus-visible) { opacity: 1; }
.md :deep(.md__copy:hover) { color: var(--fg); }
.md :deep(.md__copy:focus-visible) { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
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
