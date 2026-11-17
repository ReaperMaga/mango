import { describe, expect, it } from 'vitest'
import type { AgentCommand } from '~/types/chat'
import { FALLBACK_COMMANDS, MANGO_COMMANDS, commandsFor, matchCommands, nameParts, pickedText, slashQuery } from '@/chat/commands'

const names = (list: { command: AgentCommand }[]) => list.map(m => m.command.name)

describe('slashQuery', () => {
  it('reads the name typed after a leading slash', () => {
    expect(slashQuery('/')).toBe('')
    expect(slashQuery('/Com')).toBe('com')
    expect(slashQuery('/gsap-skills:gsap.core')).toBe('gsap-skills:gsap.core')
  })
  it('does not apply once anything but a name is typed, or without a leading slash', () => {
    expect(slashQuery('')).toBeNull()
    expect(slashQuery('hello /compact')).toBeNull()
    expect(slashQuery(' /compact')).toBeNull()
    expect(slashQuery('/compact ')).toBeNull()
    expect(slashQuery('/compact\n')).toBeNull()
    expect(slashQuery('/a/b')).toBeNull()
  })
})

describe('commandsFor', () => {
  it("puts Mango's commands first, then the fallback list until the CLI has answered", () => {
    expect(commandsFor('claude').map(c => c.name)).toEqual([...MANGO_COMMANDS, ...FALLBACK_COMMANDS.claude].map(c => c.name))
    expect(commandsFor('codex', []).map(c => c.name)).toEqual([...MANGO_COMMANDS, ...FALLBACK_COMMANDS.codex].map(c => c.name))
  })
  it("uses the CLI's list when there is one, and a Mango name stays Mango's", () => {
    const live: AgentCommand[] = [{ name: 'clear', description: 'CLI clear' }, { name: 'deploy' }]
    const list = commandsFor('claude', live)
    expect(list.map(c => c.name)).toEqual(['clear', 'create-pr', 'deploy'])
    expect(list[0]!.mango).toBe(true)
  })
})

describe('matchCommands', () => {
  const all: AgentCommand[] = [
    { name: 'clear' },
    { name: 'create-pr' },
    { name: 'compact' },
    { name: 'code-review', aliases: ['review'] },
    { name: 'security-review' },
    { name: 'gsap-skills:gsap-core' },
    { name: 'usage', aliases: ['cost'] },
  ]

  it('lists everything for a bare slash, in order', () => {
    expect(matchCommands(all, '')).toEqual(all.map(command => ({ command, at: null })))
  })
  it('ranks name prefixes, then alias and plugin-tail prefixes, then matches inside the name', () => {
    expect(names(matchCommands(all, 'c'))).toEqual(['clear', 'create-pr', 'compact', 'code-review', 'usage', 'security-review', 'gsap-skills:gsap-core'])
    expect(names(matchCommands(all, 'rev'))).toEqual(['code-review', 'security-review'])
    expect(names(matchCommands(all, 'gsap-c'))).toEqual(['gsap-skills:gsap-core'])
    expect(names(matchCommands(all, 'cost'))).toEqual(['usage'])
  })
  it('ignores case and reports where the query sits in the name', () => {
    const [m] = matchCommands(all, 'VIEW')
    expect(m!.command.name).toBe('code-review')
    expect(m!.at).toBe(7)
    expect(matchCommands(all, 'cost')[0]!.at).toBeNull()
  })
  it('matches nothing for an unknown name', () => {
    expect(matchCommands(all, 'zzz')).toEqual([])
  })
})

describe('nameParts and pickedText', () => {
  it('splits the name around the hit', () => {
    expect(nameParts({ command: { name: 'code-review' }, at: 5 }, 'rev')).toEqual([
      { text: 'code-', hit: false },
      { text: 'rev', hit: true },
      { text: 'iew', hit: false },
    ])
    expect(nameParts({ command: { name: 'usage' }, at: null }, 'cost')).toEqual([{ text: 'usage', hit: false }])
  })
  it('fills in the name and a space, which closes the list', () => {
    const text = pickedText({ name: 'compact' })
    expect(text).toBe('/compact ')
    expect(slashQuery(text)).toBeNull()
  })
})
