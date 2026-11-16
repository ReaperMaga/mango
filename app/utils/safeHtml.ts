/**
 * Cleans HTML from outside (a pull request's description as GitHub renders it) down to an
 * allow-list of plain document markup before it is shown with `v-html`. Whatever GitHub already
 * did, this text was written by someone else: no scripts, styles, handlers, frames or forms
 * survive, links and pictures must be https, and unknown elements leave only their content.
 */

const KEEP = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 'del', 's', 'ins', 'mark',
  'small', 'sub', 'sup', 'kbd', 'code', 'pre', 'samp', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'a', 'img',
  'picture', 'source', 'video', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'details', 'summary', 'span',
  'div', 'input', 'abbr', 'figure', 'figcaption',
])

/** Dropped with everything inside them. */
const DROP = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'button', 'select',
  'textarea', 'link', 'meta', 'base', 'svg', 'math', 'template', 'noscript', 'audio', 'canvas', 'head', 'title',
])

const ATTRS: Record<string, string[]> = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  source: ['srcset', 'media', 'type'],
  video: ['src', 'poster', 'width', 'height'],
  th: ['align', 'colspan', 'rowspan'],
  td: ['align', 'colspan', 'rowspan'],
  ol: ['start', 'type'],
  li: ['value'],
  details: ['open'],
  input: ['type', 'checked', 'disabled'],
  abbr: ['title'],
}

const isWebUrl = (v: string) => /^https:\/\//i.test(v.trim())
const isImageData = (v: string) => /^data:image\/(png|jpe?g|gif|webp|svg\+xml)[;,]/i.test(v.trim())
const isLink = (v: string) => /^(https?:|mailto:)/i.test(v.trim())

function cleanAttr(tag: string, name: string, value: string): string | null {
  switch (name) {
    case 'href': return isLink(value) ? value.trim() : null
    case 'src':
    case 'poster': return isWebUrl(value) || (tag === 'img' && isImageData(value)) ? value.trim() : null
    case 'srcset': return value.split(',').every(c => isWebUrl(c.trim().split(/\s+/)[0] ?? '')) ? value : null
    case 'width':
    case 'height':
    case 'colspan':
    case 'rowspan':
    case 'start':
    case 'value': return /^\d{1,5}%?$/.test(value.trim()) ? value.trim() : null
    case 'type': return tag === 'input' ? (value === 'checkbox' ? value : null) : /^[\w/+.-]{1,40}$/.test(value) ? value : null
    case 'align': return /^(left|right|center)$/i.test(value) ? value : null
    default: return value
  }
}

function clean(node: Node) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === Node.COMMENT_NODE) { child.remove(); continue }
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const el = child as Element
    const tag = el.tagName.toLowerCase()
    if (DROP.has(tag)) { el.remove(); continue }
    clean(el)
    if (!KEEP.has(tag) || (tag === 'input' && el.getAttribute('type') !== 'checkbox')) {
      el.replaceWith(...el.childNodes)
      continue
    }
    const allowed = ATTRS[tag] ?? []
    for (const attr of [...el.attributes]) {
      const value = allowed.includes(attr.name) ? cleanAttr(tag, attr.name, attr.value) : null
      if (value === null) el.removeAttribute(attr.name)
      else if (value !== attr.value) el.setAttribute(attr.name, value)
    }
    if (tag === 'a' && el.hasAttribute('href')) {
      el.setAttribute('target', '_blank')
      el.setAttribute('rel', 'noopener noreferrer')
    }
    if (tag === 'img') {
      if (!el.hasAttribute('src')) { el.remove(); continue }
      el.setAttribute('loading', 'lazy')
      el.setAttribute('referrerpolicy', 'no-referrer')
    }
    if (tag === 'video') {
      if (!el.hasAttribute('src')) { el.replaceWith(...el.childNodes); continue }
      el.setAttribute('controls', '')
      el.setAttribute('preload', 'metadata')
    }
    if (tag === 'input') el.setAttribute('disabled', '')
  }
}

/** `html` with only safe markup left, as a string for `v-html`. */
export function safeHtml(html: string): string {
  if (!html.trim()) return ''
  // A parsed document is inert: nothing in it loads or runs until it is put on the page.
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html')
  clean(doc.body)
  return doc.body.innerHTML
}
