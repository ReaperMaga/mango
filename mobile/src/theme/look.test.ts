import { describe, expect, it } from 'vitest'
import { buildFonts, familiesFor } from './fonts'
import { DEFAULT_LOOK, lookSummary, normalizeLook, RADIUS_SCALE, SCHEMES, TEXT_SCALE } from './look'
import { generated } from './schemes.generated'
import { fontSizeFor, radiusFor, typeFor } from './tokens'

describe('normalizeLook', () => {
  it('is the default for nothing or junk', () => {
    expect(normalizeLook(null)).toEqual(DEFAULT_LOOK)
    expect(normalizeLook('x')).toEqual(DEFAULT_LOOK)
    expect(normalizeLook({ scheme: 'neon', fontUi: 'comic', textSize: 9 })).toEqual(DEFAULT_LOOK)
  })

  it('keeps valid choices and fills in the rest, so data from an older build loads', () => {
    expect(normalizeLook({ scheme: 'uchiha', corners: 'round' })).toEqual({ ...DEFAULT_LOOK, scheme: 'uchiha', corners: 'round' })
  })

  it('offers exactly the schemes that were generated', () => {
    expect(SCHEMES.map(s => s.value).sort()).toEqual(Object.keys(generated).sort())
  })
})

describe('scales', () => {
  it('follow the desktop', () => {
    expect(TEXT_SCALE).toEqual({ small: 0.92, default: 1, large: 1.08, xlarge: 1.16 })
    expect(RADIUS_SCALE).toEqual({ sharp: 0.4, default: 1, round: 1.5 })
  })

  it('size the text and the corners', () => {
    expect(fontSizeFor('default').body).toBe(16)
    expect(fontSizeFor('xlarge').body).toBeGreaterThan(fontSizeFor('large').body)
    expect(fontSizeFor('small').micro).toBeGreaterThanOrEqual(10)
    expect(radiusFor('default')).toEqual({ xs: 4, sm: 6, md: 8, lg: 12, pill: 999 })
    expect(radiusFor('sharp').lg).toBeLessThan(radiusFor('default').lg)
    expect(radiusFor('round').pill).toBe(999)
  })

  it('keep line heights in step with the size', () => {
    const big = typeFor(buildFonts('inter', 'jetbrains-mono'), fontSizeFor('xlarge'))
    const base = typeFor(buildFonts('inter', 'jetbrains-mono'), fontSizeFor('default'))
    expect(big.chat.lineHeight).toBeGreaterThan(base.chat.lineHeight)
    expect(big.chat.fontSize).toBeGreaterThan(base.chat.fontSize)
  })
})

describe('fonts', () => {
  it('name a file per weight for a custom font, and a weight for the system font', () => {
    const f = buildFonts('geist', 'fira-code')
    expect(f.semibold).toEqual({ fontFamily: 'Geist_600SemiBold' })
    expect(f.mono).toEqual({ fontFamily: 'FiraCode_400Regular' })
    const sys = buildFonts('system', 'system')
    expect(sys.semibold).toEqual({ fontWeight: '600' })
    expect(sys.mono.fontFamily).toBeTruthy()
  })

  it('keep the regular face for a font without an italic', () => {
    expect(buildFonts('manrope', 'jetbrains-mono').italic).toEqual({ fontFamily: 'Manrope_400Regular', fontStyle: 'italic' })
    expect(buildFonts('inter', 'jetbrains-mono').italic).toEqual({ fontFamily: 'Inter_400Regular_Italic' })
  })

  it('load only what is chosen', () => {
    expect(familiesFor('system', 'system')).toEqual([])
    expect(familiesFor('inter', 'system')).toHaveLength(5)
    expect(familiesFor('manrope', 'geist-mono')).toEqual(['Manrope_400Regular', 'Manrope_500Medium', 'Manrope_600SemiBold', 'Manrope_700Bold', 'GeistMono_400Regular', 'GeistMono_500Medium', 'GeistMono_600SemiBold'])
  })
})

describe('lookSummary', () => {
  it('names the scheme, and the text size when it is not the default', () => {
    expect(lookSummary(DEFAULT_LOOK)).toBe('Mango')
    expect(lookSummary({ ...DEFAULT_LOOK, scheme: 'blue', textSize: 'large' })).toBe('Blue · Large text')
  })
})
