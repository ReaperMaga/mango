import { joinLinkOf, SCHEME_PREFIX } from '@/remote/shareLink'

/**
 * Links that open the app from outside. A share link, `mango://join/<payload>`, opens the Join
 * modal with that link filled in (`join/[payload]`); the payload is base64url, so it is safe as a
 * path segment. Expo Router would map the scheme's host to the first segment by itself; this
 * makes it explicit and tolerant of a differently-cased scheme or a trailing slash. Anything else
 * goes where it points. Never throws: a bad link lands on Home.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const link = joinLinkOf(path)
    if (link) return `/join/${link.slice(SCHEME_PREFIX.length).replace(/[/?#].*$/, '')}`
    return path
  } catch {
    return '/'
  }
}
