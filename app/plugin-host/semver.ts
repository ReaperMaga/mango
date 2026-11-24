/**
 * Just enough semver for `minAppVersion`: `1.2.3`, `v1.2`, `1.2.3-beta.1`. Plain TypeScript (tests/).
 */

import { t } from '../i18n/index.ts'

export interface Version { major: number; minor: number; patch: number; pre: string[] }

export function parseVersion(v: string): Version | null {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(v ?? '')
  if (!m) return null
  return { major: +m[1]!, minor: +(m[2] ?? 0), patch: +(m[3] ?? 0), pre: m[4] ? m[4].split('.') : [] }
}

/** -1, 0 or 1; null when either is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return null
  for (const k of ['major', 'minor', 'patch'] as const) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1
  // A pre-release sorts before its release.
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) return +p < +q ? -1 : 1
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

/**
 * What a dev build counts as: the working tree is ahead of the release it names, and carries the
 * plugins written for the next one (`plugins/`).
 */
export function devVersion(version: string): string {
  const v = parseVersion(version)
  return v ? `${v.major}.${v.minor}.${v.patch + 1}` : version
}

/**
 * Why a plugin cannot run on this app version, or null when it can (or names no minimum).
 * The app's own pre-release counts as its release (a dev build of the version it names).
 */
export function incompatibility(appVersion: string, minAppVersion: string | undefined | null): string | null {
  if (!minAppVersion) return null
  const min = parseVersion(minAppVersion)
  if (!min) return t('plugins.minInvalid', { version: minAppVersion })
  const app = parseVersion(appVersion)
  if (!app) return null
  const c = compareVersions(`${app.major}.${app.minor}.${app.patch}`, minAppVersion)
  return c !== null && c < 0 ? t('plugins.minVersion', { min: minAppVersion, version: appVersion }) : null
}
