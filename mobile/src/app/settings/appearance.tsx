import { useState, type ReactNode } from 'react'
import { View } from 'react-native'
import { Monitor, Moon, Sun } from 'lucide-react-native'
import {
  CORNERS, labelOf, makeStyles, MONO_FONTS, MOTIONS, space, TEXT_SIZES, UI_FONTS, useAppearance,
  type Appearance, type Corners, type MonoFont, type MotionPref, type TextSize, type UiFont,
} from '@/theme'
import { ListRow, ListSection, Segmented, Text } from '@/ui'
import { OptionSheet } from '@/screens/OptionSheet'
import { SettingsPage } from '@/screens/settings/SettingsPage'
import { SchemePicker } from '@/screens/settings/SchemePicker'
import { LookPreview } from '@/screens/settings/LookPreview'

/**
 * Settings > Appearance: how Mango looks on this phone, with the desktop's own options (theme, color
 * scheme, interface and code fonts, text size, corners, animations). Every change applies at once.
 */
export default function AppearanceSettings() {
  const s = useStyles()
  const { appearance, setAppearance, look, setLook } = useAppearance()
  const [picking, setPicking] = useState<'ui' | 'mono' | null>(null)
  const close = () => setPicking(null)
  return (
    <SettingsPage id="appearance">
      <LookPreview />

      <Field title="Theme" footer="System follows your iPhone's light or dark setting.">
        <Segmented<Appearance>
          label="Theme"
          value={appearance}
          onChange={setAppearance}
          options={[
            { value: 'system', label: 'System', icon: Monitor },
            { value: 'dark', label: 'Dark', icon: Moon },
            { value: 'light', label: 'Light', icon: Sun },
          ]}
        />
      </Field>

      <Field title="Color scheme" footer="Tints the background and sets the accent color. Status colors stay the same.">
        <SchemePicker value={look.scheme} onChange={scheme => void setLook({ scheme })} />
      </Field>

      <ListSection footer="The interface font is for chats and settings; the code font for code, paths and branches.">
        <ListRow title="Interface font" detail={labelOf(UI_FONTS, look.fontUi)} onPress={() => setPicking('ui')} />
        <ListRow title="Code font" detail={labelOf(MONO_FONTS, look.fontMono)} onPress={() => setPicking('mono')} />
      </ListSection>

      <Field title="Text size" footer="Scales the text in Mango. iOS's own text size setting still applies on top.">
        <Segmented<TextSize> label="Text size" value={look.textSize} onChange={textSize => void setLook({ textSize })} options={TEXT_SIZES.map(o => (o.value === 'xlarge' ? { ...o, label: 'XL' } : o))} />
      </Field>

      <Field title="Corners" footer="How rounded buttons, cards and sheets are.">
        <Segmented<Corners> label="Corners" value={look.corners} onChange={corners => void setLook({ corners })} options={[...CORNERS]} />
      </Field>

      <Field title="Animations" footer="Reduced turns the movement off. System follows your iPhone's Reduce Motion setting.">
        <Segmented<MotionPref> label="Animations" value={look.motion} onChange={motion => void setLook({ motion })} options={[...MOTIONS]} />
      </Field>

      <OptionSheet<UiFont> visible={picking === 'ui'} title="Interface font" options={UI_FONTS} value={look.fontUi} onChange={fontUi => void setLook({ fontUi })} onClose={close} footer="System font is San Francisco." />
      <OptionSheet<MonoFont> visible={picking === 'mono'} title="Code font" options={MONO_FONTS} value={look.fontMono} onChange={fontMono => void setLook({ fontMono })} onClose={close} footer="System monospace is Menlo." />
    </SettingsPage>
  )
}

/** One setting: its name, the control, and a quiet line about it. */
function Field({ title, footer, children }: { title: string; footer?: string; children: ReactNode }) {
  const s = useStyles()
  return (
    <View style={s.field}>
      <Text variant="captionStrong" tone="subtle" accessibilityRole="header" style={s.fieldTitle}>{title}</Text>
      {children}
      {footer ? <Text variant="caption" tone="faint" style={s.fieldTitle}>{footer}</Text> : null}
    </View>
  )
}

const useStyles = makeStyles(() => ({
  field: { gap: 6 },
  fieldTitle: { paddingHorizontal: space[4] },
}))
