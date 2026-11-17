import { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import { Copy } from 'lucide-react-native'
import { makeStyles, radius, space } from '@/theme'
import { Banner, Button, Text, TextField, haptic } from '@/ui'
import { ListGround } from '@/ui/List'
import { useEnvs, type ServerDraft } from '@/state/envs'
import { HeaderButton, ScreenScroll } from '@/screens/Screen'
import { messageOf } from '@/screens/names'

/**
 * Adding a server by hand, in two steps. First where it is; Mango then makes this phone's own key
 * for it and reads the key the server presents. Nothing is saved until the person has put this
 * phone's key on the server and compared the server's fingerprint: then "Trust and add".
 */
export default function AddServer() {
  const s = useStyles()
  const router = useRouter()
  const [name, setName] = useState('')
  const [dest, setDest] = useState('')
  const [port, setPort] = useState('')
  const [remote, setRemote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<ServerDraft | null>(null)
  const [copied, setCopied] = useState(false)

  // A draft left behind (Cancel, a swipe down) takes its new key with it.
  const pending = useRef<ServerDraft | null>(null)
  useEffect(() => () => { if (pending.current) void useEnvs.getState().cancelServer(pending.current) }, [])

  const portNumber = port.trim() ? Number(port.trim()) : null

  const next = async () => {
    setBusy(true)
    setError(null)
    try {
      const d = await useEnvs.getState().addServer({ name, ssh: dest, port: portNumber, incusRemote: remote })
      pending.current = d
      setDraft(d)
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  const back = async () => {
    if (pending.current) await useEnvs.getState().cancelServer(pending.current)
    pending.current = null
    setDraft(null)
    setCopied(false)
  }

  const trust = async () => {
    if (!draft) return
    setBusy(true)
    setError(null)
    try {
      const env = await useEnvs.getState().trustServer(draft)
      pending.current = null
      haptic('success')
      void useEnvs.getState().refresh(env.id)
      router.back()
      router.push({ pathname: '/env/[id]', params: { id: env.id } })
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  const user = draft?.env.endpoint.user ?? ''
  const host = draft?.env.endpoint.host ?? ''

  return (
    <ListGround.Provider value="raised">
      <Stack.Screen options={{ headerLeft: () => <HeaderButton label="Cancel" onPress={() => router.back()} /> }} />
      <ScreenScroll raised>
        {!draft
          ? (
              <>
                <Text variant="bodySm" tone="muted">
                  A server you reach over SSH that runs Incus, as on the desktop. Mango makes a key for it that lives only on this phone.
                </Text>
                <View style={s.fields}>
                  <TextField
                    label="SSH destination"
                    value={dest}
                    onChangeText={setDest}
                    placeholder="ops@203.0.113.10"
                    mono
                    autoCapitalize="none"
                    autoCorrect={false}
                    spellCheck={false}
                    keyboardType="email-address"
                    textContentType="URL"
                    hint="user@host, as you would type it after ssh."
                  />
                  <TextField
                    label="Port"
                    value={port}
                    onChangeText={v => setPort(v.replace(/[^0-9]/g, ''))}
                    placeholder="22"
                    keyboardType="number-pad"
                    maxLength={5}
                  />
                  <TextField label="Name" value={name} onChangeText={setName} placeholder={dest.split('@').pop() || 'forge'} hint="Shown in your list. Leave it empty to use the host." />
                  <TextField
                    label="Incus remote"
                    value={remote}
                    onChangeText={setRemote}
                    placeholder="Default"
                    mono
                    autoCapitalize="none"
                    autoCorrect={false}
                    hint="Only when the instances are on another remote of the server's Incus."
                  />
                </View>
                {error ? <Banner tone="error" title="Could not reach the server" message={error} /> : null}
                <Button label={busy ? 'Connecting…' : 'Continue'} variant="primary" size="lg" block loading={busy} disabled={!dest.trim()} onPress={next} />
              </>
            )
          : (
              <>
                <View style={s.step}>
                  <Text variant="title" accessibilityRole="header">Give the server this phone's key</Text>
                  <Text variant="bodySm" tone="muted">
                    Add this line to <Text variant="mono" tone="fg">~/.ssh/authorized_keys</Text> of <Text variant="mono" tone="fg">{user}</Text> on {host}.
                  </Text>
                  <View style={s.well}><Text variant="mono" selectable>{draft.publicKey}</Text></View>
                  <Button
                    label={copied ? 'Copied' : 'Copy key'}
                    icon={Copy}
                    size="sm"
                    onPress={() => { void Clipboard.setStringAsync(draft.publicKey).then(() => { setCopied(true); haptic('success') }) }}
                  />
                </View>

                <View style={s.step}>
                  <Text variant="title" accessibilityRole="header">Check the server's fingerprint</Text>
                  <Text variant="bodySm" tone="muted">
                    {host} answered with this host key. Trust it only if it matches what the server itself prints for:
                  </Text>
                  <View style={s.well}><Text variant="mono" tone="muted" selectable>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</Text></View>
                  <View style={[s.well, s.print]}>
                    <Text variant="caption" tone="subtle">{draft.hostKey.type}</Text>
                    <Text variant="mono" selectable style={s.fingerprint}>{draft.hostKey.fingerprint}</Text>
                  </View>
                </View>

                {error ? <Banner tone="error" message={error} /> : null}
                <View style={s.buttons}>
                  <Button label="Trust and add" variant="primary" size="lg" block loading={busy} onPress={trust} />
                  <Button label="Back" variant="ghost" block onPress={back} />
                </View>
              </>
            )}
      </ScreenScroll>
    </ListGround.Provider>
  )
}

const useStyles = makeStyles(t => ({
  fields: { gap: space[4] },
  step: { gap: space[2], alignItems: 'flex-start' },
  well: {
    alignSelf: 'stretch',
    padding: space[3],
    borderRadius: radius.md,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: t.colors.line,
    backgroundColor: t.colors.bgInset,
  },
  print: { gap: 2 },
  fingerprint: { color: t.colors.fg },
  buttons: { gap: space[2] },
}))
