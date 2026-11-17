import { describe, expect, it } from 'vitest'
import type { Attachment } from '~/types/chat'
import { agentInput, safeName } from './input'

const att = (id: string, name: string, kind: Attachment['kind']): Attachment =>
  ({ id, name, kind, path: `/home/agent/.local/share/mango/attachments/${id}/${name}`, mime: kind === 'image' ? 'image/png' : 'application/pdf', size: 3 })

describe('agentInput', () => {
  it('sends fitted pictures inline and names everything else by its path in the environment', () => {
    const shot = att('a1', 'shot.png', 'image')
    const big = att('a2', 'huge.png', 'image')
    const spec = att('a3', 'spec.pdf', 'file')
    const r = agentInput('  look at these  ', [shot, big, spec], a => (a.id === 'a1' ? { mime: 'image/png', data: 'AAAA' } : undefined))
    expect(r.images).toEqual([{ name: 'shot.png', path: shot.path, mime: 'image/png', data: 'AAAA' }])
    expect(r.prompt.startsWith('look at these\n\nThe user attached 2 files.')).toBe(true)
    expect(r.prompt).toContain(`- huge.png: ${big.path}`)
    expect(r.prompt).toContain(`- spec.pdf: ${spec.path}`)
  })

  it('is just the text without attachments', () => {
    expect(agentInput('hi', [], () => undefined)).toEqual({ prompt: 'hi', images: [] })
  })
})

describe('safeName', () => {
  it('keeps one harmless path segment', () => {
    expect(safeName('IMG_0001.JPG', 'x')).toBe('IMG_0001.JPG')
    expect(safeName('../../etc/passwd', 'x')).toBe('_.._etc_passwd')
    expect(safeName('.env', 'x')).toBe('env')
    expect(safeName('-rf', 'x')).toBe('rf')
    expect(safeName('a\nb', 'x')).toBe('a_b')
    expect(safeName('...', 'file-1')).toBe('file-1')
    const long = safeName(`${'a'.repeat(300)}.pdf`, 'x')
    expect(long.length).toBe(200)
    expect(long.endsWith('.pdf')).toBe(true)
  })
})
