/**
 * Cleans HTML from outside (a pull request's description as GitHub or GitLab renders it) down to an
 * allow-list of plain document markup before it is shown with `v-html`. Whatever the forge already
 * did, this text was written by someone else: no scripts, styles, handlers, frames or forms
 * survive, links and pictures must be https, and unknown elements leave only their content.
 *
 * GitLab writes its own links and uploads from the server's root (`/group/project/-/issues/1`,
 * `/uploads/…`): with a `base` (`https://gitlab.example.com`) those are read against it; without one
 * they are dropped. Nothing is ever left relative to Mango's own page.
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

/** `value` read against `base` when it starts at the server's root (`/…`, never `//host`); otherwise as it is. */
function resolve(value: string, base: string | null): string {
  const v = value.trim()
  if (!base || !v.startsWith('/') || v.startsWith('//')) return value
  try { return new URL(v, base).href } catch { return value }
}

function cleanAttr(tag: string, name: string, raw: string, base: string | null): string | null {
  const value = name === 'href' || name === 'src' || name === 'poster' ? resolve(raw, base) : raw
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

function clean(node: Node, base: string | null) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === Node.COMMENT_NODE) { child.remove(); continue }
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const el = child as Element
    const tag = el.tagName.toLowerCase()
    if (DROP.has(tag)) { el.remove(); continue }
    clean(el, base)
    if (!KEEP.has(tag) || (tag === 'input' && el.getAttribute('type') !== 'checkbox')) {
      el.replaceWith(...el.childNodes)
      continue
    }
    // GitLab draws pictures lazily: a placeholder in `src`, the picture itself in `data-src`.
    if (tag === 'img' && el.getAttribute('data-src')) el.setAttribute('src', el.getAttribute('data-src')!)
    const allowed = ATTRS[tag] ?? []
    for (const attr of [...el.attributes]) {
      const value = allowed.includes(attr.name) ? cleanAttr(tag, attr.name, attr.value, base) : null
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

/** The forge's address as an origin (`https://host`), or null for anything else. */
function originOf(base: string | null | undefined): string | null {
  if (!base) return null
  try {
    const u = new URL(base)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null
  } catch { return null }
}

/**
 * `html` with only safe markup left, as a string for `v-html`. `base`, the forge's own address
 * (`https://host`), is what links and pictures from the server's root are read against.
 */
export function safeHtml(html: string, base?: string | null): string {
  if (!html.trim()) return ''
  const origin = originOf(base)
  // A parsed document is inert: nothing in it loads or runs until it is put on the page.
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html')
  clean(doc.body, origin)
  return doc.body.innerHTML
}
