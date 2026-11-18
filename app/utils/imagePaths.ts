/**
 * Where a picture in an agent's reply (`![alt](href)`) points. Plain TypeScript, shared with the
 * phone app (`mobile/src/chat/chatImages.ts`), so both show the same pictures from the same markdown.
 */

/**
 * The local file a markdown image points at; null for web addresses, data URLs and anything
 * else that is not a plain path. Takes `file://` URLs, Windows and POSIX absolute paths, and
 * relative paths (resolved against the chat's project folder by the backend).
 */
export function localImagePath(href: string): string | null {
  let h = href.trim()
  if (!h) return null
  if (/^file:/i.test(h)) {
    try {
      const u = new URL(h)
      let p = decodeURIComponent(u.pathname)
      if (/^\/[a-z]:\//i.test(p)) p = p.slice(1)
      return u.host ? `//${u.host}${p}` : p
    } catch {
      return null
    }
  }
  try { h = decodeURIComponent(h) } catch { /* keep it as written */ }
  if (/^[a-z]:[\\/]/i.test(h)) return h
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//')) return null
  return h
}
