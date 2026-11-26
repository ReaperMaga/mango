import { describe, expect, it } from 'vitest'
import { repoWebUrl, validRef, webUrl } from './forge'

const gl = { provider: 'gitlab' as const, kind: 'pr' as const, host: 'gitlab.com', owner: 'acme/apps', repo: 'app', number: 12 }
const gh = { kind: 'pr' as const, host: 'github.com', owner: 'acme', repo: 'shop', number: 7 }

describe('links on either forge', () => {
  it('checks every part, and builds the page from them', () => {
    expect(validRef(gl)).toBe(true)
    expect(validRef(gh)).toBe(true)
    expect(validRef({ ...gl, owner: 'a;b' })).toBe(false)
    expect(validRef({ ...gl, host: 'javascript:' })).toBe(false)
    expect(validRef({ ...gh, host: 'gitlab.com' })).toBe(false)
    expect(webUrl(gl)).toBe('https://gitlab.com/acme/apps/app/-/merge_requests/12')
    expect(webUrl({ ...gl, kind: 'issue', number: 3 })).toBe('https://gitlab.com/acme/apps/app/-/issues/3')
    expect(webUrl(gh)).toBe('https://github.com/acme/shop/pull/7')
    expect(webUrl({ ...gl, repo: '..' })).toBeNull()
    expect(repoWebUrl({ provider: 'gitlab', host: 'git.corp.io:8443', owner: 'a/b', repo: 'c' })).toBe('https://git.corp.io:8443/a/b/c')
    expect(repoWebUrl({ provider: 'github', host: 'acme.ghe.com', owner: 'a', repo: 'c' })).toBeNull()
  })
})
