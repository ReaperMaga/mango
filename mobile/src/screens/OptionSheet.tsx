import { ListRow, ListSection, Sheet, haptic } from '@/ui'

export interface Option<T extends string> {
  value: T
  label: string
  /** What choosing it means, in a sentence. */
  hint?: string
}

/** Pick one of a few options in a bottom sheet: a check marks the current one, a tap picks and closes. */
export function OptionSheet<T extends string>({ visible, title, options, value, onChange, onClose, footer }: {
  visible: boolean
  title: string
  options: ReadonlyArray<Option<T>>
  value: T
  onChange: (value: T) => void
  onClose: () => void
  footer?: string
}) {
  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      <ListSection footer={footer}>
        {options.map(o => (
          <ListRow
            key={o.value}
            title={o.label}
            subtitle={o.hint}
            subtitleLines={3}
            accessory={o.value === value ? 'check' : 'none'}
            onPress={() => { haptic('select'); onChange(o.value); onClose() }}
          />
        ))}
      </ListSection>
    </Sheet>
  )
}
