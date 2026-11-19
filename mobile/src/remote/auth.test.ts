import { describe, expect, it } from 'vitest'
import { AUTH_SCRIPT, parseAuthOutput, parseClaude, parseCodex } from './auth'

const empty = (agent: 'claude' | 'codex') => ({ agent, installed: true, loggedIn: false, account: null, plan: null, organization: null, method: null, detail: null })

describe('parseClaude', () => {
  it('reads the JSON the CLI prints', () => {
    const a = empty('claude')
    parseClaude('{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c","subscriptionType":"max"}', a)
    expect(a).toMatchObject({ loggedIn: true, account: 'a@b.c', plan: 'max', method: 'claude.ai', organization: null })
  })

  it('drops a personal organization name and keeps a real one', () => {
    const a = empty('claude')
    parseClaude('{"loggedIn":true,"email":"a@b.c","orgName":"a@b.c\'s Organization"}', a)
    expect(a.organization).toBeNull()
    parseClaude('{"loggedIn":true,"email":"a@b.c","orgName":"Acme"}', a)
    expect(a.organization).toBe('Acme')
  })

  it('falls back to a sentence', () => {
    const a = empty('claude')
    parseClaude('Not logged in\n', a)
    expect(a).toMatchObject({ loggedIn: false, detail: 'Not logged in' })
  })
})

describe('parseCodex', () => {
  it('reads how it signed in', () => {
    const a = empty('codex')
    parseCodex(true, 'Logged in using ChatGPT\n', a)
    expect(a).toMatchObject({ loggedIn: true, method: 'ChatGPT' })
  })

  it('is signed out on a non-zero exit even when the words say otherwise', () => {
    const a = empty('codex')
    parseCodex(false, 'Not logged in\n', a)
    expect(a.loggedIn).toBe(false)
    parseCodex(false, 'Logged in using ChatGPT', a)
    expect(a.loggedIn).toBe(false)
  })
})

describe('parseAuthOutput', () => {
  it('lists both agents, with what each said', () => {
    const out = [
      '@@claude', '{"loggedIn":true,"email":"a@b.c","subscriptionType":"pro"}', '@@exit 0',
      '@@codex', 'Not logged in', '@@exit 1', '',
    ].join('\n')
    const [claude, codex] = parseAuthOutput(out)
    expect(claude).toMatchObject({ agent: "claude", installed: true, loggedIn: true, plan: "pro" })
    expect(codex).toMatchObject({ agent: 'codex', installed: true, loggedIn: false, detail: 'Not logged in' })
  })

  it('marks an agent that printed nothing as not installed', () => {
    const [claude, codex] = parseAuthOutput('@@codex\nLogged in using ChatGPT\n@@exit 0\n')
    expect(claude).toMatchObject({ agent: 'claude', installed: false })
    expect(codex).toMatchObject({ installed: true, loggedIn: true, method: 'ChatGPT' })
    expect(parseAuthOutput('').every(a => !a.installed)).toBe(true)
  })

  it('never lets output that looks like a marker fake an agent', () => {
    const [claude] = parseAuthOutput('@@claude\n@@exit 0 extra\n@@codex 3\n@@exit 0\n')
    expect(claude?.installed).toBe(true)
  })

  it('has a script that only runs the CLIs\' status commands', () => {
    expect(AUTH_SCRIPT).toContain('claude auth status')
    expect(AUTH_SCRIPT).toContain('codex login status')
    expect(AUTH_SCRIPT).not.toMatch(/auth\.json|credentials/)
  })
})
