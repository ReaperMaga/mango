import { View } from 'react-native'
import { makeStyles, space } from '@/theme'
import { Button, ButtonRow, Text } from '@/ui'

/**
 * An in-sheet question before something is changed ("Delete this chat?"): a sentence of what
 * happens, a way back and the action. Not a dialog: the sheet it sits in stays where it is.
 */
export function ConfirmBox({ title, message, keepLabel = 'Keep it', actionLabel, danger = true, onKeep, onConfirm }: {
  title: string
  message: string
  keepLabel?: string
  actionLabel: string
  /** Deleting is danger; archiving only asks. */
  danger?: boolean
  onKeep: () => void
  onConfirm: () => void
}) {
  const s = useStyles()
  return (
    <View style={[s.box, danger && s.danger]} accessibilityLiveRegion="polite">
      <Text variant="label" tone={danger ? 'error' : 'fg'}>{title}</Text>
      <Text variant="bodySm" tone="muted">{message}</Text>
      <ButtonRow>
        <Button label={keepLabel} variant="ghost" size="sm" onPress={onKeep} />
        <Button label={actionLabel} variant={danger ? 'danger' : 'primary'} size="sm" onPress={onConfirm} />
      </ButtonRow>
    </View>
  )
}

const useStyles = makeStyles(t => ({
  box: { gap: space[2], padding: space[3], borderRadius: t.radius.md, borderWidth: 1, borderColor: t.colors.line },
  danger: { borderColor: t.colors.errorLine, backgroundColor: t.colors.errorWash },
}))
