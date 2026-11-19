import type { MonoFont, UiFont } from './look'

/**
 * Font faces by name. A face is what goes into a style: a custom font is one file per weight, so
 * it is named by family and carries no weight; the system font is one family at several weights.
 * Which files exist is `fontAssets.ts` (native and web only: it loads the .ttf files).
 */
export interface FontFace {
  fontFamily?: string
  fontWeight?: '400' | '500' | '600' | '700'
  fontStyle?: 'italic'
}

export interface Fonts {
  regular: FontFace
  medium: FontFace
  semibold: FontFace
  bold: FontFace
  /** Emphasis in agent prose. */
  italic: FontFace
  mono: FontFace
  monoMedium: FontFace
  monoSemibold: FontFace
}

/** The family names the .ttf files are registered under (`@expo-google-fonts/*` calls them these). */
interface Family { regular: string; medium: string; semibold: string; bold: string; italic: string | null }

const SANS: Record<Exclude<UiFont, 'system'>, Family> = {
  inter: { regular: 'Inter_400Regular', medium: 'Inter_500Medium', semibold: 'Inter_600SemiBold', bold: 'Inter_700Bold', italic: 'Inter_400Regular_Italic' },
  geist: { regular: 'Geist_400Regular', medium: 'Geist_500Medium', semibold: 'Geist_600SemiBold', bold: 'Geist_700Bold', italic: 'Geist_400Regular_Italic' },
  'dm-sans': { regular: 'DMSans_400Regular', medium: 'DMSans_500Medium', semibold: 'DMSans_600SemiBold', bold: 'DMSans_700Bold', italic: 'DMSans_400Regular_Italic' },
  manrope: { regular: 'Manrope_400Regular', medium: 'Manrope_500Medium', semibold: 'Manrope_600SemiBold', bold: 'Manrope_700Bold', italic: null },
}

const MONO: Record<Exclude<MonoFont, 'system'>, { regular: string; medium: string; semibold: string }> = {
  'jetbrains-mono': { regular: 'JetBrainsMono_400Regular', medium: 'JetBrainsMono_500Medium', semibold: 'JetBrainsMono_600SemiBold' },
  'fira-code': { regular: 'FiraCode_400Regular', medium: 'FiraCode_500Medium', semibold: 'FiraCode_600SemiBold' },
  'source-code-pro': { regular: 'SourceCodePro_400Regular', medium: 'SourceCodePro_500Medium', semibold: 'SourceCodePro_600SemiBold' },
  'geist-mono': { regular: 'GeistMono_400Regular', medium: 'GeistMono_500Medium', semibold: 'GeistMono_600SemiBold' },
}

/** The phone's own monospace: Menlo on iOS (a browser falls back to its own). */
const SYSTEM_MONO = typeof document !== 'undefined' ? 'ui-monospace, Menlo, Consolas, monospace' : 'Menlo'

/** The family names a choice needs loaded (none for the system fonts). */
export function familiesFor(ui: UiFont, mono: MonoFont): string[] {
  const out: string[] = []
  if (ui !== 'system') {
    const f = SANS[ui]
    out.push(f.regular, f.medium, f.semibold, f.bold)
    if (f.italic) out.push(f.italic)
  }
  if (mono !== 'system') out.push(...Object.values(MONO[mono]))
  return out
}

export function buildFonts(ui: UiFont, mono: MonoFont): Fonts {
  const sans: Pick<Fonts, 'regular' | 'medium' | 'semibold' | 'bold' | 'italic'> = ui === 'system'
    ? {
        regular: { fontWeight: '400' },
        medium: { fontWeight: '500' },
        semibold: { fontWeight: '600' },
        bold: { fontWeight: '700' },
        italic: { fontWeight: '400', fontStyle: 'italic' },
      }
    : (() => {
        const f = SANS[ui]
        return {
          regular: { fontFamily: f.regular },
          medium: { fontFamily: f.medium },
          semibold: { fontFamily: f.semibold },
          bold: { fontFamily: f.bold },
          // A font without an italic keeps its regular face; the style asks the system to slant it where it can.
          italic: f.italic ? { fontFamily: f.italic } : { fontFamily: f.regular, fontStyle: 'italic' as const },
        }
      })()
  const code: Pick<Fonts, 'mono' | 'monoMedium' | 'monoSemibold'> = mono === 'system'
    ? {
        mono: { fontFamily: SYSTEM_MONO, fontWeight: '400' },
        monoMedium: { fontFamily: SYSTEM_MONO, fontWeight: '500' },
        monoSemibold: { fontFamily: SYSTEM_MONO, fontWeight: '600' },
      }
    : (() => {
        const f = MONO[mono]
        return { mono: { fontFamily: f.regular }, monoMedium: { fontFamily: f.medium }, monoSemibold: { fontFamily: f.semibold } }
      })()
  return { ...sans, ...code }
}
