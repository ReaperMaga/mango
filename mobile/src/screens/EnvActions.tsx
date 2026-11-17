import { useEffect, useState } from 'react'
import { View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Copy, KeyRound, RefreshCw, Trash2 } from 'lucide-react-native'
import { ssh } from '@/ssh'
import { makeStyles, radius, space, useTheme } from '@/theme'
import { Banner, Button, ButtonRow, ListRow, ListSection, Sheet, Text, TextField, haptic } from '@/ui'
import { useEnvs } from '@/state/envs'
import { connectionText, messageOf } from './names'

/**
 * What can be done to a saved environment, in one sheet (the env screen's "more" button and
 * Settings): rename it, check its connection, see this phone's key for a server again, remove it.
 * Removing asks twice: it deletes this phone's key for it, and a joined env needs a new link after.
 */
export function EnvActions({ envId, visible, onClose, onRemoved }: {
  envId: string
  visible: boolean
  onClose: () => void
  onRemoved?: () => void
}) {
  const t = useTheme()
  const s = useStyles()
  const env = useEnvs(st => st.envs.find(e => e.id === envId) ?? null)
  const status = useEnvs(st => st.status[envId])
  const [name, setName] = useState(env?.name ?? '')
  const [nameError, setNameError] = useState<string | null>(null)
  const [publicKey, setPublicKey] = useState<string | null>(null)
  const [keyError, setKeyError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [armed, setArmed] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)

  // Each opening starts clean: the current name, nothing armed.
  useEffect(() => {
    if (!visible) return
    setName(env?.name ?? '')
    setNameError(null)
    setArmed(false)
    setRemoveError(null)
    setPublicKey(null)
    setKeyError(null)
    setCopied(false)
  }, [visible]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!env) return null
  const conn = connectionText(status)
  const renamed = name.trim() !== env.name && !!name.trim()

  const saveName = async () => {
    try {
      await useEnvs.getState().rename(env.id, name)
      setNameError(null)
      haptic('success')
    } catch (e) {
      setNameError(messageOf(e))
    }
  }

  const showKey = async () => {
    try {
      const line = await ssh.publicKey(env.endpoint.keyId)
      if (!line) throw new Error("This phone's key for the server is missing. Remove the server and add it again.")
      setPublicKey(line)
    } catch (e) {
      setKeyError(messageOf(e))
    }
  }

  const remove = async () => {
    setRemoving(true)
    try {
      await useEnvs.getState().remove(env.id)
      haptic('success')
      onClose()
      onRemoved?.()
    } catch (e) {
      setRemoveError(messageOf(e))
    } finally {
      setRemoving(false)
    }
  }

  return (
    <Sheet visible={visible} onClose={onClose} title={env.name}>
      <View style={s.body}>
        <View style={s.rename}>
          <TextField
            label="Name"
            value={name}
            onChangeText={(v) => { setName(v); setNameError(null) }}
            onSubmitEditing={() => { if (renamed) void saveName() }}
            returnKeyType="done"
            autoCorrect={false}
            error={nameError}
            style={s.flex}
          />
          <Button label="Save" size="sm" disabled={!renamed} onPress={saveName} style={s.save} />
        </View>

        <ListSection>
          <ListRow
            title="Check connection"
            subtitle={conn.text}
            subtitleTone={conn.tone}
            leading={<RefreshCw size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />}
            accessory="none"
            disabled={status?.state === 'checking'}
            onPress={() => { void useEnvs.getState().check(env.id).catch(() => {}) }}
          />
          {env.server
            ? (
                <ListRow
                  title="This phone's key"
                  subtitle="The line to put in the server's authorized_keys"
                  leading={<KeyRound size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />}
                  accessory="none"
                  onPress={showKey}
                />
              )
            : null}
          <ListRow
            title="Remove"
            destructive
            leading={<Trash2 size={20} strokeWidth={1.75} color={t.colors.ripeErrorFg} />}
            accessory="none"
            onPress={() => { haptic('warning'); setArmed(true) }}
          />
        </ListSection>

        {keyError ? <Banner tone="error" message={keyError} /> : null}
        {publicKey
          ? (
              <View style={s.keyBlock}>
                <View style={s.well}><Text variant="mono" selectable>{publicKey}</Text></View>
                <Button
                  label={copied ? 'Copied' : 'Copy'}
                  icon={Copy}
                  size="sm"
                  onPress={() => { void Clipboard.setStringAsync(publicKey).then(() => { setCopied(true); haptic('success') }) }}
                />
              </View>
            )
          : null}

        {armed
          ? (
              <View style={s.confirm} accessibilityLiveRegion="polite">
                <Text variant="label" tone="error">Remove {env.name} from this phone?</Text>
                <Text variant="bodySm" tone="muted">
                  {env.joined
                    ? 'This phone forgets the environment and its key. Its chats stay in the environment; to come back you need a new share link.'
                    : 'This phone forgets the server and deletes its key for it. Take the key out of the server\'s authorized_keys as well.'}
                </Text>
                {removeError ? <Text variant="caption" tone="error" accessibilityRole="alert">{removeError}</Text> : null}
                <ButtonRow>
                  <Button label="Keep it" variant="ghost" size="sm" onPress={() => setArmed(false)} />
                  <Button label="Remove" variant="danger" size="sm" loading={removing} onPress={remove} />
                </ButtonRow>
              </View>
            )
          : null}
      </View>
    </Sheet>
  )
}

const useStyles = makeStyles(t => ({
  body: { gap: space[5] },
  flex: { flex: 1 },
  rename: { flexDirection: 'row', alignItems: 'flex-start', gap: space[2] },
  save: { marginTop: 26, minHeight: 44 },
  keyBlock: { gap: space[2], alignItems: 'flex-start' },
  well: { alignSelf: 'stretch', padding: space[3], borderRadius: radius.md, borderWidth: 1, borderColor: t.colors.line, backgroundColor: t.colors.bgInset },
  confirm: { gap: space[2], padding: space[3], borderRadius: radius.md, borderWidth: 1, borderColor: t.colors.errorLine, backgroundColor: t.colors.errorWash },
}))
