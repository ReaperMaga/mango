import { useCallback, useState } from 'react'
import { View } from 'react-native'
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { baseName } from '~/utils/paths'
import { makeStyles } from '@/theme'
import { Text } from '@/ui'
import { ChatDiff } from '@/chat'
import { backend } from '@/remote'
import { messageOf } from '@/screens/names'

/** One changed file's diff, the whole screen, scrolling both ways (lines never wrap). */
export default function DiffScreen() {
  const s = useStyles()
  const { path = '', file = '' } = useLocalSearchParams<{ path: string; file: string }>()
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useFocusEffect(useCallback(() => {
    let alive = true
    backend.gitDiff(path, file).then(
      (d) => { if (alive) { setText(d); setError(null) } },
      (e) => { if (alive) setError(messageOf(e)) },
    )
    return () => { alive = false }
  }, [path, file]))

  const cut = file.lastIndexOf('/')
  return (
    <View style={s.screen}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={s.title} accessibilityRole="header">
              <Text variant="label" numberOfLines={1}>{baseName(file)}</Text>
              {cut > 0 ? <Text variant="monoSm" tone="subtle" numberOfLines={1} ellipsizeMode="head">{file.slice(0, cut)}</Text> : null}
            </View>
          ),
        }}
      />
      <ChatDiff text={error ? '' : text} error={error} fill />
    </View>
  )
}

const useStyles = makeStyles(t => ({
  screen: { flex: 1, backgroundColor: t.colors.bgInset },
  title: { alignItems: 'center', maxWidth: 240 },
}))
