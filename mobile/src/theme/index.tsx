import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AccessibilityInfo, Easing, StyleSheet, useColorScheme, type ImageStyle, type TextStyle, type ViewStyle } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useFonts } from 'expo-font'
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular'
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium'
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold'
import { Inter_700Bold } from '@expo-google-fonts/inter/700Bold'
import { Inter_400Regular_Italic } from '@expo-google-fonts/inter/400Regular_Italic'
import { JetBrainsMono_400Regular } from '@expo-google-fonts/jetbrains-mono/400Regular'
import { JetBrainsMono_500Medium } from '@expo-google-fonts/jetbrains-mono/500Medium'
import { JetBrainsMono_600SemiBold } from '@expo-google-fonts/jetbrains-mono/600SemiBold'
import type { Theme as NavigationTheme } from 'expo-router'
import { fonts, motion, palettes, type Colors, type SchemeName, type Shadows } from './tokens'

export * from './tokens'

/**
 * The theme a component reads. Like the desktop, components take every colour from here and have
 * no theme branch of their own: dark and light differ only in `colors` and `shadow`.
 */
export interface Theme {
  scheme: SchemeName
  dark: boolean
  colors: Colors
  shadow: Shadows
}

const themes: Record<SchemeName, Theme> = {
  dark: { scheme: 'dark', dark: true, ...palettes.dark },
  light: { scheme: 'light', dark: false, ...palettes.light },
}

/** What the person chose in Settings: follow the phone, or keep one. */
export type Appearance = 'system' | 'dark' | 'light'

interface Ctx {
  theme: Theme
  appearance: Appearance
  setAppearance: (a: Appearance) => void
  /** The saved choice has been read; until then the theme follows the system. */
  ready: boolean
}

const STORAGE_KEY = 'mango.appearance'
const ThemeContext = createContext<Ctx | null>(null)

/**
 * Follows the phone's appearance unless the person picked one (kept in AsyncStorage). `scheme`
 * forces a theme for a subtree (the gallery shows both side by side); the choice stays the outer one's.
 */
export function ThemeProvider({ children, scheme }: { children: ReactNode; scheme?: SchemeName }) {
  const outer = useContext(ThemeContext)
  const system = useColorScheme()
  const [appearance, setChoice] = useState<Appearance>('system')
  const [ready, setReady] = useState(!!outer)

  useEffect(() => {
    if (outer) return
    let alive = true
    AsyncStorage.getItem(STORAGE_KEY)
      .then((v) => { if (alive && (v === 'dark' || v === 'light' || v === 'system')) setChoice(v) })
      .catch(() => { /* unreadable storage: follow the system */ })
      .finally(() => { if (alive) setReady(true) })
    return () => { alive = false }
  }, [outer])

  const setAppearance = useCallback((a: Appearance) => {
    setChoice(a)
    AsyncStorage.setItem(STORAGE_KEY, a).catch(() => { /* kept for this session only */ })
  }, [])

  const value = useMemo<Ctx>(() => {
    if (outer) return scheme ? { ...outer, theme: themes[scheme] } : outer
    const resolved: SchemeName = scheme ?? (appearance === 'system' ? (system === 'light' ? 'light' : 'dark') : appearance)
    return { theme: themes[resolved], appearance, setAppearance, ready }
  }, [outer, scheme, appearance, system, setAppearance, ready])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

function useCtx(): Ctx {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('Wrap the app in <ThemeProvider> (src/theme) before using the theme.')
  return ctx
}

export const useTheme = (): Theme => useCtx().theme

/** The appearance choice, for Settings: `appearance`, `setAppearance`, and `ready` once the saved one is read. */
export function useAppearance() {
  const { appearance, setAppearance, ready, theme } = useCtx()
  return { appearance, setAppearance, ready, scheme: theme.scheme }
}

/**
 * `StyleSheet.create` per theme, built once per theme and shared by every instance:
 * `const useStyles = makeStyles(t => ({ row: { backgroundColor: t.colors.bgPanel } }))`.
 */
export type NamedStyles = Record<string, ViewStyle | TextStyle | ImageStyle>

export function makeStyles<T extends NamedStyles>(build: (t: Theme) => T): () => T {
  const cache = new Map<SchemeName, T>()
  return function useStyles() {
    const t = useTheme()
    let s = cache.get(t.scheme)
    if (!s) {
      s = StyleSheet.create(build(t))
      cache.set(t.scheme, s)
    }
    return s
  }
}

/** Loads Inter and JetBrains Mono. True once they are ready (or failed: the system font stands in). */
export function useMangoFonts(): boolean {
  const [loaded, error] = useFonts({
    [fonts.regular]: Inter_400Regular,
    [fonts.medium]: Inter_500Medium,
    [fonts.semibold]: Inter_600SemiBold,
    [fonts.bold]: Inter_700Bold,
    [fonts.italic]: Inter_400Regular_Italic,
    [fonts.mono]: JetBrainsMono_400Regular,
    [fonts.monoMedium]: JetBrainsMono_500Medium,
    [fonts.monoSemibold]: JetBrainsMono_600SemiBold,
  })
  return loaded || !!error
}

/** The system's Reduce Motion: ripening, breathing and the working dots hold still under it. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    let alive = true
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (alive) setReduced(v) }).catch(() => {})
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced)
    return () => { alive = false; sub.remove() }
  }, [])
  return reduced
}

/** `--ease-out` and `--ease-in-out` for `Animated.timing`. */
export const easeOut = Easing.bezier(...motion.easeOut)
export const easeInOut = Easing.bezier(...motion.easeInOut)

/** The theme for expo-router's `ThemeProvider`, so headers, the stack's ground and the back button match. */
export function navigationTheme(t: Theme): NavigationTheme {
  return {
    dark: t.dark,
    colors: {
      primary: t.colors.accentInk,
      background: t.colors.bgCanvas,
      card: t.colors.bgCanvas,
      text: t.colors.fg,
      border: t.colors.lineSoft,
      notification: t.colors.ripeWaiting,
    },
    fonts: {
      regular: { fontFamily: fonts.regular, fontWeight: '400' },
      medium: { fontFamily: fonts.medium, fontWeight: '500' },
      bold: { fontFamily: fonts.semibold, fontWeight: '600' },
      heavy: { fontFamily: fonts.bold, fontWeight: '700' },
    },
  }
}
