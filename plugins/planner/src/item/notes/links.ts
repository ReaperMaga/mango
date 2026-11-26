import { safeUrl } from '../../model.ts'

/** The web address a link opens, or null: nothing else is ever opened. */
export const openable = (href: string): string | null => (/^\s*https?:\/\//i.test(href) ? safeUrl(href) : null)

/**
 * What a typed or pasted link points to: a web or mail address, or a path. Null for anything else (`javascript:` and
 * the like). A bare domain means https.
 */
export function linkTarget(text: string): string | null {
  const t = text.trim()
  if (!t || [...t].some(c => c.charCodeAt(0) <= 32)) return null
  if (/^https?:/i.test(t)) return openable(t) ? t : null
  if (/^mailto:[^@]+@[^@]+$/i.test(t)) return t
  if (/^[^@/:]+@[^@/:]+\.[^@/:]+$/.test(t)) return `mailto:${t}`
  if (/^localhost(:\d+)?([/?#]|$)/i.test(t)) return `http://${t}`
  // A file of the project looks like a domain too.
  const file = /^[\w-]+\.(md|txt|png|jpe?g|gif|svg|pdf|ts|js|vue|rs|py|json|html|css)$/i.test(t)
  // The port of an address without a scheme is no scheme.
  if (!file && /^[a-z\d-]+(\.[a-z\d-]+)+(:\d+)?([/?#]|$)/i.test(t)) return `https://${t}`
  return /^[a-z][a-z\d+.-]*:/i.test(t) ? null : t
}
