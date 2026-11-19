import { useEffect, useRef, type ReactNode } from 'react'
import { Pressable, ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { makeStyles, space } from '@/theme'
import { Text, haptic } from '@/ui'
import { ScreenScroll } from '@/screens/Screen'
import { SETTINGS_SECTIONS, settingsHref, type SettingsId } from './sections'

/**
 * One settings category: the tab strip to jump to another category, and the category's own scrolling
 * page below it. The strip replaces the screen instead of stacking a new one, so the back button
 * (and the back swipe) always return to the Settings list in one step.
 */
export function SettingsPage({ id, children, refreshing, onRefresh }: {
  id: SettingsId
  children: ReactNode
  refreshing?: boolean
  onRefresh?: () => void
}) {
  const label = SETTINGS_SECTIONS.find(s => s.id === id)?.label ?? 'Settings'
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: label }} />
      <SettingsTabs current={id} />
      <ScreenScroll refreshing={refreshing} onRefresh={onRefresh}>{children}</ScreenScroll>
    </View>
  )
}

/** A strip of every category; the current one is marked and kept in view. */
function SettingsTabs({ current }: { current: SettingsId }) {
  const s = useStyles()
  const router = useRouter()
  const scroller = useRef<ScrollViewInstance>(null)
  const spots = useRef(new Map<SettingsId, { x: number; w: number }>())
  const width = useRef(0)

  const center = (id: SettingsId, animated: boolean) => {
    const at = spots.current.get(id)
    if (!at || !width.current) return
    scroller.current?.scrollTo({ x: Math.max(0, at.x + at.w / 2 - width.current / 2), animated })
  }
  useEffect(() => { center(current, false) }, [current])

  return (
    <View style={s.bar} accessibilityRole="tablist">
      <ScrollView
        ref={scroller}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.strip}
        onLayout={(e) => { width.current = e.nativeEvent.layout.width; center(current, false) }}
        keyboardShouldPersistTaps="handled"
      >
        {SETTINGS_SECTIONS.map((sec) => {
          const on = sec.id === current
          return (
            <Pressable
              key={sec.id}
              onLayout={(e) => { spots.current.set(sec.id, { x: e.nativeEvent.layout.x, w: e.nativeEvent.layout.width }); if (on) center(sec.id, false) }}
              onPress={() => {
                if (on) return
                haptic('select')
                router.replace(settingsHref(sec.id))
              }}
              hitSlop={{ top: 6, bottom: 6 }}
              accessibilityRole="tab"
              accessibilityLabel={sec.label}
              accessibilityState={{ selected: on }}
              style={({ pressed }) => [s.tab, on && s.tabOn, pressed && !on && s.tabPressed]}
            >
              <Text variant={on ? 'label' : 'bodySm'} tone={on ? 'accent' : 'muted'} maxFontSizeMultiplier={1.2}>{sec.label}</Text>
            </Pressable>
          )
        })}
      </ScrollView>
    </View>
  )
}

const useStyles = makeStyles(t => ({
  bar: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.colors.line, backgroundColor: t.colors.bgCanvas },
  strip: { paddingHorizontal: space[4], paddingVertical: space[2], gap: space[2] },
  tab: { minHeight: 34, justifyContent: 'center', paddingHorizontal: space[3], borderRadius: t.radius.pill },
  tabOn: { backgroundColor: t.colors.accentSoft },
  tabPressed: { backgroundColor: t.colors.bgActive },
}))
