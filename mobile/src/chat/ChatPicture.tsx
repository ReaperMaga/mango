import { useEffect, useState } from 'react'
import { Image, Modal, Pressable, ScrollView, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { X } from 'lucide-react-native'
import { makeStyles, space } from '@/theme'
import { IconButton, Text } from '@/ui'
import { pictures, usePicture } from './usePicture'

/** Tallest a picture stands in the chat column; tap it for the whole thing. */
const MAX_HEIGHT = 360

export interface ChatPictureProps {
  /** The chat's folder in the environment (an `env://` path): relative paths are found there. */
  base: string
  /** The file inside the environment, as the reply names it. */
  path: string
  /** The markdown's alt text; the file name when empty. */
  name: string
}

/**
 * A picture from the agent's reply (a screenshot it took, say), read from the environment through
 * `backend.chatImage`, as the desktop's `ChatMarkdown.vue` does: framed on the Inset Well, capped in
 * height, and opened full screen on tap. While it loads, or when it cannot be shown, its name in
 * quiet ink stands in; tapping a failed one tries again.
 */
export function ChatPicture({ base, path, name }: ChatPictureProps) {
  const s = useStyles()
  const state = usePicture(base, path)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [width, setWidth] = useState(0)
  const [open, setOpen] = useState(false)
  const uri = state.status === 'ready' ? state.uri : null
  useEffect(() => {
    if (!uri) return
    let live = true
    Image.getSize(uri, (w, h) => { if (live && w && h) setNatural({ w, h }) }, () => {})
    return () => { live = false }
  }, [uri])

  if (state.status === 'loading') {
    return <Text variant="bodySm" tone="subtle" style={s.note} accessibilityLabel={`Loading picture: ${name}`}>{name}</Text>
  }
  if (state.status === 'error') {
    return (
      <Pressable onPress={() => pictures.retry(base, path)} accessibilityRole="button" accessibilityLabel={`${name}: picture not found`} accessibilityHint={`${state.error}. Tap to try again.`} hitSlop={8}>
        <Text variant="bodySm" tone="faint" style={s.note}>{name}: picture not found</Text>
      </Pressable>
    )
  }

  // As wide as the column allows (never wider than the picture itself), then capped in height.
  let size: { width: number; height: number } | null = null
  if (natural && width) {
    let w = Math.min(width, natural.w)
    let h = (w * natural.h) / natural.w
    if (h > MAX_HEIGHT) { h = MAX_HEIGHT; w = (h * natural.w) / natural.h }
    size = { width: Math.round(w), height: Math.round(h) }
  }

  return (
    <View onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width - 2)} style={s.column}>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="imagebutton"
        accessibilityLabel={`Open picture: ${name}`}
        style={({ pressed }) => [s.frame, pressed && s.pressed]}
      >
        <Image
          source={{ uri: state.uri }}
          accessibilityIgnoresInvertColors
          resizeMode="contain"
          style={size ?? s.sizing}
        />
      </Pressable>
      {open ? <PictureViewer uri={state.uri} name={name} onClose={() => setOpen(false)} /> : null}
    </View>
  )
}

/** The picture full screen on the App ground: pinch to zoom, the close button in the top corner. */
function PictureViewer({ uri, name, onClose }: { uri: string; name: string; onClose: () => void }) {
  const s = useStyles()
  const insets = useSafeAreaInsets()
  const { width, height } = useWindowDimensions()
  return (
    <Modal visible animationType="fade" presentationStyle="fullScreen" onRequestClose={onClose} statusBarTranslucent>
      <View style={s.viewer}>
        <ScrollView
          maximumZoomScale={4}
          minimumZoomScale={1}
          centerContent
          bouncesZoom
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={s.viewerContent}
        >
          <Image
            source={{ uri }}
            accessibilityLabel={name}
            accessibilityIgnoresInvertColors
            resizeMode="contain"
            style={{ width, height: height - insets.top - insets.bottom, marginTop: insets.top }}
          />
        </ScrollView>
        <View style={[s.viewerBar, { top: insets.top + space[2] }]}>
          <IconButton icon={X} label="Close picture" onPress={onClose} style={s.close} />
        </View>
      </View>
    </Modal>
  )
}

const useStyles = makeStyles(t => ({
  note: { marginVertical: space[1] },
  column: { alignSelf: 'stretch', marginTop: space[1], marginBottom: space[3] },
  frame: {
    alignSelf: 'flex-start',
    overflow: 'hidden',
    backgroundColor: t.colors.bgInset,
    borderWidth: 1,
    borderColor: t.colors.lineSoft,
    borderRadius: t.radius.md,
    borderCurve: 'continuous',
  },
  pressed: { borderColor: t.colors.lineStrong, opacity: 0.9 },
  // Before the picture has told its size: a placeholder of a common screenshot shape.
  sizing: { width: 240, height: 160 },
  viewer: { flex: 1, backgroundColor: t.colors.bgApp },
  viewerContent: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  viewerBar: { position: 'absolute', right: space[3] },
  close: { backgroundColor: t.colors.bgRaised },
}))
