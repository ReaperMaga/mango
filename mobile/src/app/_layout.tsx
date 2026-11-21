// First: loading the envs store hands `backend` its env lookup, which every `env://` path needs.
import '@/state/envs'
import { useCallback, useEffect } from 'react'
import { Stack, ThemeProvider as NavigationThemeProvider, useRouter } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { navigationTheme, ThemeProvider, useAppearance, useTheme } from '@/theme'
import { startApp, useAppLifecycle, useNetworkWatch } from '@/screens/lifecycle'
import { useNotificationTaps } from '@/notify/taps'
import { useThreads } from '@/state/threads'

// The splash stays up until the saved appearance and its fonts are in, so nothing flashes.
SplashScreen.preventAutoHideAsync().catch(() => {})

/** A deep link straight into a modal (a share link) still has Home underneath to go back to. */
export const unstable_settings = { anchor: 'index' }

export default function RootLayout() {
  useAppLifecycle()
  useNetworkWatch()
  // A tapped notification opens its chat, once the saved chats are in.
  const router = useRouter()
  useNotificationTaps(useCallback((id: string) => {
    void startApp().then(() => {
      if (useThreads.getState().byId(id)) router.push({ pathname: '/chat/[id]', params: { id } })
    })
  }, [router]))
  return (
    <ThemeProvider>
      <Root />
    </ThemeProvider>
  )
}

function Root() {
  const t = useTheme()
  const { ready } = useAppearance()
  const go = ready
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
          headerTitleStyle: { ...t.fonts.semibold, color: t.colors.fg },
          headerLargeTitleStyle: { ...t.fonts.semibold, color: t.colors.fg },
          headerLargeStyle: { backgroundColor: t.colors.bgCanvas },
          headerLargeTitleShadowVisible: false,
          headerBackButtonDisplayMode: 'minimal',
          // iOS always centres it; the web preview would put it at the left, beside the back arrow.
          headerTitleAlign: 'center',
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Mango', headerLargeTitle: true }} />
        <Stack.Screen name="join/index" options={{ ...modal, title: 'Join an environment' }} />
        <Stack.Screen name="join/[payload]" options={{ ...modal, title: 'Join an environment' }} />
        <Stack.Screen name="add-server" options={{ ...modal, title: 'Add a server' }} />
        <Stack.Screen name="settings/index" options={{ title: 'Settings' }} />
      </Stack>
    </NavigationThemeProvider>
  )
}
