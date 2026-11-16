/**
 * Browsers open in the main pane as tabs next to chats, diffs and files. The id
 * carries the project and the browser's own id (the one its native webview is
 * labelled with, see `browser_open`). Not saved: a page does not survive a restart.
 */
const PREFIX = 'browser\u0001'

export const browserTabId = (projectPath: string, browserId: string) => `${PREFIX}${projectPath}\u0001${browserId}`

export const isBrowserTab = (id: string | null | undefined): id is string => !!id && id.startsWith(PREFIX)

export function parseBrowserTab(id: string | null | undefined) {
  if (!isBrowserTab(id)) return null
  const [, projectPath = '', browserId = ''] = id.split('\u0001')
  return { projectPath, browserId }
}

/** Hosts that mean "this computer": a dev server's page opens in Mango's browser, not the system's. */
const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\]|[\w-]+(?:\.[\w-]+)*\.localhost)$/i

/** An http(s) URL of a server on this computer (localhost, 127.x, 0.0.0.0, [::1], *.localhost). */
export function isLocalDevUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOST.test(u.hostname)
  } catch {
    return false
  }
}

/**
 * What the user typed in the address bar, as a URL the browser loads, or null when it is not an
 * address (Mango does not search the web). `localhost:3000`, `127.0.0.1:8080/x`, `0.0.0.0:5173`,
 * `[::1]:3000` (and other IPv4 addresses) get `http://`; something with a dot and no spaces gets `https://`.
 */
export function normalizeAddress(input: string): string | null {
  const text = input.trim()
  if (!text) return null
  if (/^about:blank$/i.test(text)) return 'about:blank'
  if (/^https?:\/\//i.test(text)) return valid(text)
  // Another scheme (file:, javascript:, data:, mailto:): the browser does not load those.
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text)) return null
  if (/\s/.test(text)) return null
  const host = /^(\[[^\]]*\]|[^/:?#]+)/.exec(text)?.[1] ?? ''
  // This computer, or another on the network by its IP: dev servers there speak plain http.
  if (LOCAL_HOST.test(host) || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return valid(`http://${text}`)
  if (host.includes('.')) return valid(`https://${text}`)
  return null
}

function valid(url: string): string | null {
  try {
    const u = new URL(url)
    return u.hostname || u.protocol === 'about:' ? u.href : null
  } catch {
    return null
  }
}

/** A short name for a page with no title yet: its host (and port), or the URL. */
export function hostOf(url: string): string {
  try {
    const u = new URL(url)
    return u.host || url
  } catch {
    return url
  }
}

export const isBlank = (url: string | null | undefined) => !url || url === 'about:blank'
