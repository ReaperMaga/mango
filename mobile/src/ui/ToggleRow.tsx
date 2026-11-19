import type { ReactNode } from 'react'
import { Switch } from 'react-native'
import { useTheme } from '@/theme'
import { ListRow } from './List'
import { haptic } from './haptics'

/** A list row with an on/off switch at the right: iOS's settings idiom, in Mango's accent. */
export function ToggleRow({ title, subtitle, leading, value, onChange, disabled }: {
  title: string
  subtitle?: string
  leading?: ReactNode
  value: boolean
  onChange: (on: boolean) => void
  disabled?: boolean
}) {
  const t = useTheme()
  return (
    <ListRow
      title={title}
      subtitle={subtitle}
      subtitleLines={2}
      leading={leading}
      disabled={disabled}
      trailing={(
        <Switch
          value={value}
          disabled={disabled}
          onValueChange={(on) => { haptic('select'); onChange(on) }}
          trackColor={{ false: t.colors.lineStrong, true: t.colors.accent }}
          ios_backgroundColor={t.colors.lineStrong}
          accessibilityLabel={title}
        />
      )}
    />
  )
}
