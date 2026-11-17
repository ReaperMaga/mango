import type { ReactNode } from 'react'
import { Platform, Pressable, RefreshControl, ScrollView, type StyleProp, type ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { makeStyles, space, touch, useTheme } from '@/theme'
import { Text } from '@/ui'

/**
 * A screen's scrolling body: canvas ground, 16pt sides, 24pt between sections, room for the home
 * indicator. `contentInsetAdjustmentBehavior` lets an iOS large title collapse as it scrolls.
 */
export function ScreenScroll({ children, refreshing, onRefresh, raised, style }: {
  children: ReactNode
  /** Pull to refresh, when given. */
  refreshing?: boolean
  onRefresh?: () => void
  /** On a modal's Raised ground. */
  raised?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const t = useTheme()
  const s = useStyles()
  const insets = useSafeAreaInsets()
  return (
    <ScrollView
      style={[s.screen, raised && s.raised]}
      // On iOS the automatic inset adjustment already clears the home indicator.
      contentContainerStyle={[s.content, { paddingBottom: (Platform.OS === 'ios' ? 0 : insets.bottom) + space[8] }, style]}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      refreshControl={onRefresh
        ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={t.colors.fgSubtle} colors={[t.colors.accent]} />
        : undefined}
    >
      {children}
    </ScrollView>
  )
}

/** A text button in a navigation bar ("Cancel", "Done"): Mango Ink, 44pt tall. */
export function HeaderButton({ label, onPress, strong, disabled }: { label: string; onPress: () => void; strong?: boolean; disabled?: boolean }) {
  const s = useStyles()
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [s.headerButton, (pressed || disabled) && s.dim]}
    >
      <Text variant={strong ? 'label' : 'bodySm'} tone="accent" maxFontSizeMultiplier={1.3}>{label}</Text>
    </Pressable>
  )
}

const useStyles = makeStyles(t => ({
  screen: { flex: 1, backgroundColor: t.colors.bgCanvas },
  raised: { backgroundColor: t.colors.bgRaised },
  content: { paddingHorizontal: space[4], paddingTop: space[3], gap: space[6] },
  headerButton: { minHeight: touch.min, justifyContent: 'center', paddingHorizontal: space[2] },
  dim: { opacity: 0.55 },
}))
