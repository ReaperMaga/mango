// First: loading the envs store hands `backend` its env lookup, which every `env://` path needs.
import '@/state/envs'
import { useEffect } from 'react'
import { Stack, ThemeProvider as NavigationThemeProvider } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { fonts, navigationTheme, ThemeProvider, useAppearance, useMangoFonts, useTheme } from '@/theme'
import { useAppLifecycle, useNetworkWatch } from '@/screens/lifecycle'

// The splash stays up until the fonts and the saved appearance are in, so nothing flashes.
SplashScreen.preventAutoHideAsync().catch(() => {})

/** A deep link straight into a modal (a share link) still has Home underneath to go back to. */
export const unstable_settings = { anchor: 'index' }

export default function RootLayout() {
  const fontsReady = useMangoFonts()
  useAppLifecycle()
  useNetworkWatch()
  return (
    <ThemeProvider>
      <Root fontsReady={fontsReady} />
    </ThemeProvider>
  )
}

function Root({ fontsReady }: { fontsReady: boolean }) {
  const t = useTheme()
  const { ready } = useAppearance()
  const go = fontsReady && ready
  useEffect(() => {
    if (go) SplashScreen.hideAsync().catch(() => {})
  }, [go])
  if (!go) return null

  // Modals float: the Raised ground, as the desktop's dialogs.
  const modal = {
    presentation: 'modal' as const,
    contentStyle: { backgroundColor: t.colors.bgRaised },
    headerStyle: { backgroundColor: t.colors.bgRaised },
  }

  return (
    <NavigationThemeProvider value={navigationTheme(t)}>
      <StatusBar style={t.dark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          contentStyle: { backgroundColor: t.colors.bgCanvas },
          headerStyle: { backgroundColor: t.colors.bgCanvas },
          headerShadowVisible: false,
          headerTintColor: t.colors.accentInk,
          headerTitleStyle: { fontFamily: fonts.semibold, color: t.colors.fg },
          headerLargeTitleStyle: { fontFamily: fonts.semibold, color: t.colors.fg },
          headerLargeStyle: { backgroundColor: t.colors.bgCanvas },
          headerLargeTitleShadowVisible: false,
          headerBackButtonDisplayMode: 'minimal',
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Mango', headerLargeTitle: true }} />
        <Stack.Screen name="join/index" options={{ ...modal, title: 'Join an environment' }} />
        <Stack.Screen name="join/[payload]" options={{ ...modal, title: 'Join an environment' }} />
        <Stack.Screen name="add-server" options={{ ...modal, title: 'Add a server' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
      </Stack>
    </NavigationThemeProvider>
  )
}
