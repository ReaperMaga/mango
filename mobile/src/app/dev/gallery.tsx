import { Redirect, Stack, useLocalSearchParams } from 'expo-router'
import { ThemeProvider } from '@/theme'
import { Gallery } from '@/dev/Gallery'

/** Every component with sample data, for design work in development builds only. */
export default function GalleryRoute() {
  // `?scheme=dark|light` pins a theme and `?sheet=1` opens the sample sheet, for screenshots of the web preview.
  const { scheme, sheet } = useLocalSearchParams<{ scheme?: string; sheet?: string }>()
  if (!__DEV__) return <Redirect href="/" />
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <ThemeProvider scheme={scheme === 'dark' || scheme === 'light' ? scheme : undefined}>
        <Gallery sheetOpen={sheet === '1'} />
      </ThemeProvider>
    </>
  )
}
