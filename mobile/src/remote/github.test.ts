import { describe, expect, it } from 'vitest'
import { ghFailure, ghItemArgv, ghWebUrl, parseGhItem, validGhOwner, validGhRepo, type GhRef } from './github'
import { line } from './shell'

const ref = (over: Partial<GhRef> = {}): GhRef => ({ kind: 'pr', host: 'github.com', owner: 'acme', repo: 'shop-api', number: 128, ...over })

describe('github references', () => {
  it('accepts real owners and repositories only', () => {
    expect(validGhOwner('acme')).toBe(true)
    expect(validGhOwner('a-b-9')).toBe(true)
    expect(validGhOwner('-acme')).toBe(false)
    expect(validGhOwner('acme;rm')).toBe(false)
    expect(validGhOwner('a'.repeat(40))).toBe(false)
    expect(validGhRepo('shop.api_v2-x')).toBe(true)
    expect(validGhRepo('..')).toBe(false)
    expect(validGhRepo('a/b')).toBe(false)
    expect(validGhRepo('$(id)')).toBe(false)
  })

  it('builds the web address from the parts, on github.com only', () => {
    expect(ghWebUrl(ref())).toBe('https://github.com/acme/shop-api/pull/128')
    expect(ghWebUrl(ref({ kind: 'issue', number: 7 }))).toBe('https://github.com/acme/shop-api/issues/7')
    expect(ghWebUrl(ref({ host: 'GitHub.com' }))).toBe('https://github.com/acme/shop-api/pull/128')
    expect(ghWebUrl(ref({ host: 'evil.example' }))).toBeNull()
    expect(ghWebUrl(ref({ owner: 'javascript:' }))).toBeNull()
    expect(ghWebUrl(ref({ number: 0 }))).toBeNull()
    expect(ghWebUrl(ref({ number: 1.5 }))).toBeNull()
  })

  it('reads one item with gh api, every value quoted', () => {
    const argv = ghItemArgv(ref())
    expect(argv.slice(0, 5)).toEqual(['gh', 'api', '--hostname', 'github.com', 'repos/acme/shop-api/issues/128'])
    expect(line(argv)).toContain("'{title, state, state_reason, draft, merged_at: .pull_request.merged_at, pr: (.pull_request != null)}'")
    expect(() => ghItemArgv(ref({ repo: 'x;reboot' }))).toThrow(/github.com/)
    expect(() => ghItemArgv(ref({ host: 'gitlab.com' }))).toThrow()
  })
})

describe('parseGhItem', () => {
  const out = (v: object) => `${JSON.stringify(v)}\n`
  it('tells pull request states apart', () => {
    expect(parseGhItem(out({ title: 'A', state: 'open', draft: false, merged_at: null, pr: true }))).toEqual({ kind: 'pr', title: 'A', state: 'open', stateReason: null })
    expect(parseGhItem(out({ title: 'A', state: 'open', draft: true, merged_at: null, pr: true }))?.state).toBe('draft')
    expect(parseGhItem(out({ title: 'A', state: 'closed', draft: false, merged_at: '2026-11-01T10:00:00Z', pr: true }))?.state).toBe('merged')
    expect(parseGhItem(out({ title: 'A', state: 'closed', draft: false, merged_at: null, pr: true }))?.state).toBe('closed')
  })
  it('reads issues with their reason', () => {
    expect(parseGhItem(out({ title: 'B', state: 'closed', state_reason: 'NOT_PLANNED', draft: null, merged_at: null, pr: false })))
      .toEqual({ kind: 'issue', title: 'B', state: 'closed', stateReason: 'not_planned' })
  })
  it('refuses anything else', () => {
    expect(parseGhItem('')).toBeNull()
    expect(parseGhItem('not json')).toBeNull()
    expect(parseGhItem(out({ state: 'open' }))).toBeNull()
    expect(parseGhItem(out({ title: 'C', state: 'weird' }))).toBeNull()
  })
})

describe('ghFailure', () => {
  it('says what to do when gh is missing or signed out', () => {
    expect(ghFailure('dev', ref(), 127, 'bash: line 1: gh: command not found')).toMatch(/not installed in dev/)
    expect(ghFailure('dev', ref(), 2, 'sh: 1: gh: not found\n')).toMatch(/not installed in dev/)
    expect(ghFailure('dev', ref(), 4, 'To get started with GitHub CLI, please run:  gh auth login')).toMatch(/not signed in/)
    expect(ghFailure('dev', ref(), 1, 'gh: Bad credentials (HTTP 401)')).toMatch(/not signed in/)
    expect(ghFailure('dev', ref(), 1, 'gh: Not Found (HTTP 404)')).toMatch(/acme\/shop-api#128/)
    expect(ghFailure('dev', ref(), 1, 'error connecting to api.github.com\n')).toBe('Could not read from GitHub: error connecting to api.github.com')
    expect(ghFailure('dev', ref(), null, '')).toMatch(/interrupted/)
  })
})
