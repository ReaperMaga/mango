import { useState, type ComponentRef, type Ref } from 'react'
import { Platform, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native'
import { fonts, fontSize, makeStyles, radius, space, touch, useTheme } from '@/theme'
import { Text } from './Text'

export interface TextFieldProps extends Omit<TextInputProps, 'style'> {
  /** Above the control, in muted ink. Also its accessibility label. */
  label?: string
  /** One line under the control. Replaced by `error` when there is one. */
  hint?: string
  error?: string | null
  /** Hosts, paths, keys and branches are machine text: mono. */
  mono?: boolean
  style?: StyleProp<ViewStyle>
  ref?: Ref<ComponentRef<typeof TextInput>>
}

/**
 * The desktop's field (`UiField` + input): label over control over one line of hint, 6pt apart.
 * The control is the Inset Well with a `line` border; focus turns the border to Mango Line with
 * the 3pt Mango Wash halo, and the caret is Ripe Mango. An error takes a 60% error border and
 * replaces the hint with the message.
 */
export function TextField({ label, hint, error, mono, style, multiline, onFocus, onBlur, ref, ...input }: TextFieldProps) {
  const t = useTheme()
  const s = useStyles()
  const [focused, setFocused] = useState(false)
  return (
    <View style={[s.field, style]}>
      {label ? <Text variant="captionStrong" tone="muted">{label}</Text> : null}
      <TextInput
        ref={ref}
        accessibilityLabel={label}
        placeholderTextColor={t.colors.fgFaint}
        selectionColor={t.colors.accent}
        cursorColor={t.colors.accent}
        keyboardAppearance={t.dark ? 'dark' : 'light'}
        maxFontSizeMultiplier={1.6}
        multiline={multiline}
        {...input}
        onFocus={(e) => { setFocused(true); onFocus?.(e) }}
        onBlur={(e) => { setFocused(false); onBlur?.(e) }}
        style={[s.input, Platform.OS === 'web' && s.web, mono && s.mono, multiline && s.multi, focused && s.focused, !!error && s.invalid]}
      />
      {error
        ? <Text variant="caption" tone="error" accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</Text>
        : hint ? <Text variant="caption" tone="subtle">{hint}</Text> : null}
    </View>
  )
}

const useStyles = makeStyles(t => ({
  field: { gap: 6 },
  input: {
    minHeight: touch.min,
    paddingHorizontal: space[3],
    paddingVertical: 10,
    borderRadius: radius.sm,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: t.colors.line,
    backgroundColor: t.colors.bgInset,
    color: t.colors.fg,
    fontFamily: fonts.regular,
    fontSize: fontSize.body,
  },
  /** The browser's own focus outline: the border and halo above already show focus. */
  web: { outlineStyle: 'solid', outlineWidth: 0 },
  mono: { fontFamily: fonts.mono, fontSize: fontSize.code },
  multi: { minHeight: 96, textAlignVertical: 'top', paddingTop: space[3] },
  focused: { borderColor: t.colors.accentLine, boxShadow: `0px 0px 0px 3px ${t.colors.accentSoft}` },
  invalid: { borderColor: t.colors.errorLineStrong },
}))
