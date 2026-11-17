import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Animated, Modal, PanResponder, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { X } from 'lucide-react-native'
import { easeOut, makeStyles, motion, radius, space, useReducedMotion, useTheme } from '@/theme'
import { Text } from './Text'
import { IconButton } from './IconButton'
import { ListGround } from './List'

export interface SheetProps {
  visible: boolean
  /** Called on the close button, a tap on the scrim, a swipe down, or the system back gesture. */
  onClose: () => void
  title?: string
  /** Something at the right of the title row, before the close button (a Done button). */
  action?: ReactNode
  /**
   * `auto` (the default): a bottom sheet as tall as its content (up to 90% of the screen), for
   * pickers and short tasks. `large`: iOS's own page sheet, for longer tasks; elsewhere the same
   * bottom sheet at full height.
   */
  size?: 'auto' | 'large'
  /** Content scrolls inside the sheet when it runs tall; pass false for content with its own list. */
  scroll?: boolean
  children: ReactNode
}

/**
 * Mango's floating layer on the phone, where the desktop uses menus and dialogs: Raised ground,
 * 12pt top corners, the Pop shadow over the scrim. It rises over 220ms on the decelerating ease
 * and follows a downward drag. No new native dependency: React Native's Modal and Animated.
 */
export function Sheet(props: SheetProps) {
  if (props.size === 'large' && Platform.OS === 'ios') return <PageSheet {...props} />
  return <BottomSheet {...props} />
}

function PageSheet({ visible, onClose, title, action, scroll = true, children }: SheetProps) {
  const s = useStyles()
  const insets = useSafeAreaInsets()
  return (
    <ListGround.Provider value="raised">
      <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose} allowSwipeDismissal>
        <View style={s.page}>
          <Head title={title} action={action} onClose={onClose} />
          {scroll
            ? <ScrollView contentContainerStyle={[s.body, { paddingBottom: insets.bottom + space[4] }]} keyboardShouldPersistTaps="handled">{children}</ScrollView>
            : <View style={[s.fill, { paddingBottom: insets.bottom }]}>{children}</View>}
        </View>
      </Modal>
    </ListGround.Provider>
  )
}

function BottomSheet({ visible, onClose, title, action, size = 'auto', scroll = true, children }: SheetProps) {
  const t = useTheme()
  const s = useStyles()
  const insets = useSafeAreaInsets()
  const { height } = useWindowDimensions()
  const reduced = useReducedMotion()
  const [shown, setShown] = useState(visible)
  const y = useRef(new Animated.Value(height)).current
  const fade = useRef(new Animated.Value(0)).current

  useEffect(() => {
    const d = reduced ? 0 : motion.med
    if (visible) {
      setShown(true)
      y.setValue(height)
      Animated.parallel([
        Animated.timing(y, { toValue: 0, duration: d, easing: easeOut, useNativeDriver: true }),
        Animated.timing(fade, { toValue: 1, duration: d, easing: easeOut, useNativeDriver: true }),
      ]).start()
    } else if (shown) {
      Animated.parallel([
        Animated.timing(y, { toValue: height, duration: d, easing: easeOut, useNativeDriver: true }),
        Animated.timing(fade, { toValue: 0, duration: d, easing: easeOut, useNativeDriver: true }),
      ]).start(() => setShown(false))
    }
    // `shown` is what this effect produces, not an input to it.
  }, [visible, reduced, height, y, fade])

  const closeRef = useRef(onClose)
  closeRef.current = onClose
  // Dragging the head pulls the sheet down; far enough (or fast enough) closes it.
  const drag = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => g.dy > 4 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderMove: (_, g) => y.setValue(Math.max(0, g.dy)),
    onPanResponderRelease: (_, g) => {
      if (g.dy > 120 || g.vy > 1) closeRef.current()
      else Animated.timing(y, { toValue: 0, duration: motion.fast, easing: easeOut, useNativeDriver: true }).start()
    },
  })).current

  if (!shown) return null
  const maxHeight = size === 'large' ? height - insets.top - space[2] : height * 0.9

  return (
    <ListGround.Provider value="raised">
      <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: t.colors.scrim, opacity: fade }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
        </Animated.View>
        <View style={s.dock} pointerEvents="box-none">
          <Animated.View
            accessibilityViewIsModal
            style={[s.sheet, { maxHeight, transform: [{ translateY: y }] }, size === 'large' && { height: maxHeight }]}
          >
            <View {...drag.panHandlers}>
              <View style={s.grab}><View style={s.handle} /></View>
              <Head title={title} action={action} onClose={onClose} />
            </View>
            {scroll
              ? (
                  <ScrollView
                    style={s.scroll}
                    contentContainerStyle={[s.body, { paddingBottom: insets.bottom + space[4] }]}
                    keyboardShouldPersistTaps="handled"
                    bounces={false}
                  >
                    {children}
                  </ScrollView>
                )
              : <View style={[s.fill, { paddingBottom: insets.bottom }]}>{children}</View>}
          </Animated.View>
        </View>
      </Modal>
    </ListGround.Provider>
  )
}

function Head({ title, action, onClose }: { title?: string; action?: ReactNode; onClose: () => void }) {
  const s = useStyles()
  return (
    <View style={s.head}>
      <Text variant="title" numberOfLines={1} style={s.title} accessibilityRole="header">{title ?? ''}</Text>
      {action}
      <IconButton icon={X} label="Close" size="sm" onPress={onClose} />
    </View>
  )
}

const useStyles = makeStyles(t => ({
  dock: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: t.colors.bgRaised,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: 0,
    borderColor: t.colors.line,
    boxShadow: t.shadow.pop,
    overflow: 'hidden',
  },
  page: { flex: 1, backgroundColor: t.colors.bgRaised },
  grab: { alignItems: 'center', paddingTop: space[2], paddingBottom: 2 },
  handle: { width: 36, height: 5, borderRadius: radius.pill, backgroundColor: t.colors.lineStrong },
  head: { flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: 48, paddingLeft: space[5], paddingRight: space[3] },
  title: { flex: 1 },
  scroll: { flexGrow: 0 },
  body: { paddingHorizontal: space[4], paddingTop: space[1] },
  fill: { flex: 1 },
}))
