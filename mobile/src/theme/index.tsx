import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AccessibilityInfo, Easing, StyleSheet, useColorScheme, type ImageStyle, type TextStyle, type ViewStyle } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Font from 'expo-font'
import type { Theme as NavigationTheme } from 'expo-router'
import { FONT_FILES } from './fontAssets'
import { buildFonts, familiesFor, type Fonts } from './fonts'
import { DEFAULT_LOOK, normalizeLook, sameFonts, type Look } from './look'
import {
  fontSizeFor, motion, paletteFor, radiusFor, typeFor,
  type Colors, type FontSizes, type Radii, type SchemeName, type Shadows, type TextStyleName, type TextStyleSpec,
} from './tokens'

export * from './tokens'
export * from './look'
export type { FontFace, Fonts } from './fonts'

/**
 * The theme a component reads. Like the desktop, components take every colour, font, size and
 * radius from here and have no theme branch of their own: dark and light, the colour scheme, the
 * fonts, the text size and the corners (Settings > Appearance) all arrive as one object.
 */
export interface Theme {
  /** Light or dark. */
  scheme: SchemeName
  dark: boolean
  look: Look
  /** Names this combination: styles built for a theme are kept under it (`makeStyles`). */
  key: string
  colors: Colors
  shadow: Shadows
  fonts: Fonts
  fontSize: FontSizes
  type: Record<TextStyleName, TextStyleSpec>
  radius: Radii
}

const built = new Map<string, Theme>()

function buildTheme(mode: SchemeName, look: Look): Theme {
  const key = [mode, look.scheme, look.fontUi, look.fontMono, look.textSize, look.corners].join('|')
  let t = built.get(key)
  if (!t) {
    const fonts = buildFonts(look.fontUi, look.fontMono)
    const fontSize = fontSizeFor(look.textSize)
    t = { scheme: mode, dark: mode === 'dark', look, key, ...paletteFor(look.scheme, mode), fonts, fontSize, type: typeFor(fonts, fontSize), radius: radiusFor(look.corners) }
    built.set(key, t)
  }
  return t
}

/** What the person chose in Settings: follow the phone, or keep one. */
export type Appearance = 'system' | 'dark' | 'light'

interface Ctx {
  theme: Theme
  appearance: Appearance
  setAppearance: (a: Appearance) => void
  look: Look
  /** Change some of the look (scheme, fonts, text size, corners, animations); new fonts are loaded first. */
  setLook: (patch: Partial<Look>) => Promise<void>
  /** Animations are off: the Animations setting, or the phone's Reduce Motion when that is left on System. */
  reduceMotion: boolean
  /** The saved choices are read and their fonts are loaded. */
  ready: boolean
}

const STORAGE_KEY = 'mango.appearance'
const LOOK_KEY = 'mango.look'
const ThemeContext = createContext<Ctx | null>(null)

/** Register the font files a look needs; a failure leaves the system font standing in. */
async function loadFonts(look: Look): Promise<void> {
  const files: Record<string, (typeof FONT_FILES)[string]> = {}
  for (const name of familiesFor(look.fontUi, look.fontMono)) {
    const file = FONT_FILES[name]
    if (file && !Font.isLoaded(name)) files[name] = file
  }
  if (Object.keys(files).length) await Font.loadAsync(files).catch(() => { /* the system font stands in */ })
}

/**
 * Follows the phone's appearance unless the person picked one (kept in AsyncStorage), and wears the
 * look they chose. `scheme` forces light or dark for a subtree (the gallery shows both side by
 * side); everything else stays the outer one's.
 */
export function ThemeProvider({ children, scheme }: { children: ReactNode; scheme?: SchemeName }) {
  const outer = useContext(ThemeContext)
  const system = useColorScheme()
  const [appearance, setChoice] = useState<Appearance>('system')
  const [look, setLookState] = useState<Look>(DEFAULT_LOOK)
  const [systemReduced, setSystemReduced] = useState(false)
  const [ready, setReady] = useState(!!outer)
  const latest = useRef(0)

  useEffect(() => {
    if (outer) return
    let alive = true
    Promise.all([AsyncStorage.getItem(STORAGE_KEY).catch(() => null), AsyncStorage.getItem(LOOK_KEY).catch(() => null)])
      .then(async ([mode, savedLook]) => {
        let saved = DEFAULT_LOOK
        try { saved = normalizeLook(savedLook ? JSON.parse(savedLook) : null) } catch { /* unreadable: the default look */ }
        await loadFonts(saved)
        if (!alive) return
        if (mode === 'dark' || mode === 'light' || mode === 'system') setChoice(mode)
        setLookState(saved)
      })
      .finally(() => { if (alive) setReady(true) })
    return () => { alive = false }
  }, [outer])

  useEffect(() => {
    if (outer) return
    let alive = true
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (alive) setSystemReduced(v) }).catch(() => {})
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setSystemReduced)
    return () => { alive = false; sub.remove() }
  }, [outer])

  const setAppearance = useCallback((a: Appearance) => {
    setChoice(a)
    AsyncStorage.setItem(STORAGE_KEY, a).catch(() => { /* kept for this session only */ })
  }, [])

  const setLook = useCallback(async (patch: Partial<Look>) => {
    const next = normalizeLook({ ...look, ...patch })
    const run = ++latest.current
    // New fonts are in before they are asked for, so no text flashes in the system font.
    if (!sameFonts(look, next)) await loadFonts(next)
    if (run !== latest.current) return
    setLookState(next)
    AsyncStorage.setItem(LOOK_KEY, JSON.stringify(next)).catch(() => { /* kept for this session only */ })
  }, [look])

  const value = useMemo<Ctx>(() => {
    if (outer) return scheme ? { ...outer, theme: buildTheme(scheme, outer.look) } : outer
    const mode: SchemeName = scheme ?? (appearance === 'system' ? (system === 'light' ? 'light' : 'dark') : appearance)
    const reduceMotion = look.motion === 'reduced' || (look.motion === 'system' && systemReduced)
    return { theme: buildTheme(mode, look), appearance, setAppearance, look, setLook, reduceMotion, ready }
  }, [outer, scheme, appearance, system, setAppearance, look, setLook, systemReduced, ready])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

function useCtx(): Ctx {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('Wrap the app in <ThemeProvider> (src/theme) before using the theme.')
  return ctx
}

export const useTheme = (): Theme => useCtx().theme

/** The appearance choices, for Settings: light or dark, the look, and `ready` once the saved ones are read. */
export function useAppearance() {
  const { appearance, setAppearance, look, setLook, ready, theme } = useCtx()
  return { appearance, setAppearance, look, setLook, ready, scheme: theme.scheme }
}

/**
 * `StyleSheet.create` per theme, built once per theme and shared by every instance:
 * `const useStyles = makeStyles(t => ({ row: { backgroundColor: t.colors.bgPanel } }))`.
 */
export type NamedStyles = Record<string, ViewStyle | TextStyle | ImageStyle>

export function makeStyles<T extends NamedStyles>(build: (t: Theme) => T): () => T {
  const cache = new Map<string, T>()
  return function useStyles() {
    const t = useTheme()
    let s = cache.get(t.key)
    if (!s) {
      s = StyleSheet.create(build(t))
      cache.set(t.key, s)
    }
    return s
  }
}

/** Animations are off: ripening, breathing and the working dots hold still (Settings > Appearance > Animations, or the phone's Reduce Motion). */
export function useReducedMotion(): boolean {
  return useCtx().reduceMotion
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
      regular: { fontFamily: t.fonts.regular.fontFamily ?? 'System', fontWeight: '400' },
      medium: { fontFamily: t.fonts.medium.fontFamily ?? 'System', fontWeight: '500' },
      bold: { fontFamily: t.fonts.semibold.fontFamily ?? 'System', fontWeight: '600' },
      heavy: { fontFamily: t.fonts.bold.fontFamily ?? 'System', fontWeight: '700' },
    },
  }
}
