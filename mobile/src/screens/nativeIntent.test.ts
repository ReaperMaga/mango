import { describe, expect, it } from 'vitest'
import { redirectSystemPath } from '../app/+native-intent'

/** Share links opened from outside land on the Join modal with their payload; anything else passes through. */
describe('redirectSystemPath', () => {
  const at = (path: string) => redirectSystemPath({ path, initial: true })

  it('maps a share link to the join route', () => {
    expect(at('mango://join/eyJ2IjoxfQ')).toBe('/join/eyJ2IjoxfQ')
  })

  it('tolerates a differently-cased scheme, a trailing slash and a query', () => {
    expect(at('MANGO://join/abc_-123/')).toBe('/join/abc_-123')
    expect(at('mango://join/abc?utm=x')).toBe('/join/abc')
  })

  it('leaves other paths alone', () => {
    expect(at('/join/abc')).toBe('/join/abc')
    expect(at('/settings')).toBe('/settings')
    expect(at('mango://join/')).toBe('mango://join/')
  })
})
