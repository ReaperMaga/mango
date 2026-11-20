import { useEffect, useMemo, useRef, useState } from 'react'
import { Linking, Platform, View } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { CameraView, useCameraPermissions } from 'expo-camera'
import * as Clipboard from 'expo-clipboard'
import { ClipboardPaste, QrCode, ScanLine } from 'lucide-react-native'
import { makeStyles, space, useTheme } from '@/theme'
import { Banner, Button, ListRow, ListSection, Spinner, Text, TextField, haptic } from '@/ui'
import { ListGround } from '@/ui/List'
import { joinLinkOf } from '@/remote/shareLink'
import { syncEnv } from '@/remote/chatSync'
import { useEnvs } from '@/state/envs'
import { HeaderButton, ScreenScroll } from './Screen'
import { expiryText, messageOf } from './names'

/**
 * Joining an environment someone shared: scan the QR code Mango shows on the computer, or paste
 * its `mango://join/…` link (a deep link lands here with it filled in). The link is read before
 * anything is saved, so the person sees what they are joining (the environment, who shared it,
 * where it connects, until when) and can name it; then "Join" saves it with the link's key.
 */
export function JoinScreen({ initialLink, scan = false }: { initialLink?: string; scan?: boolean }) {
  const s = useStyles()
  const router = useRouter()
  const envs = useEnvs(st => st.envs)
  const [link, setLink] = useState(initialLink ?? '')
  const [name, setName] = useState('')
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)
  const [pasteNote, setPasteNote] = useState<string | null>(null)
  const [camera, setCamera] = useState(scan && !initialLink)

  // What the link would join, or why it can't be read. Recomputed as the saved list changes ("already joined").
  const read = useMemo(() => {
    if (!link.trim()) return null
    try {
      return { preview: useEnvs.getState().previewLink(link), error: null }
    } catch (e) {
      return { preview: null, error: messageOf(e) }
    }
  }, [link, envs]) // eslint-disable-line react-hooks/exhaustive-deps
  const preview = read?.preview ?? null
  const expired = preview?.expiresAt != null && preview.expiresAt <= Date.now()

  const paste = async (quiet: boolean) => {
    try {
      const text = (await Clipboard.getStringAsync()).trim()
      const found = joinLinkOf(text)
      if (found) { setLink(found); setPasteNote(null); setCamera(false) }
      else if (!quiet) setPasteNote("The clipboard doesn't hold a Mango share link. Copy the whole line that starts with mango://join/.")
    } catch {
      if (!quiet) setPasteNote("Mango couldn't read the clipboard. Paste the link into the field instead.")
    }
  }

  // Opened to paste: take a share link straight from the clipboard when there is one.
  useEffect(() => {
    if (initialLink || scan) return
    void Clipboard.hasStringAsync().then((has) => { if (has) void paste(true) }, () => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const join = async () => {
    setJoining(true)
    setJoinError(null)
    try {
      const env = await useEnvs.getState().join(link, name)
      haptic('success')
      // Connect and pull its chats in the background while the env screen opens.
      void useEnvs.getState().refresh(env.id)
      if (env.joined) void syncEnv({ hostId: env.id, instance: env.joined.instance }).catch(() => {})
      router.back()
      router.push({ pathname: '/env/[id]', params: { id: env.id } })
    } catch (e) {
      setJoinError(messageOf(e))
      haptic('warning')
    } finally {
      setJoining(false)
    }
  }

  return (
    <ListGround.Provider value="raised">
      <Stack.Screen options={{ headerLeft: () => <HeaderButton label="Cancel" onPress={() => router.back()} /> }} />
      <ScreenScroll raised>
        {preview
          ? (
              <>
                <ListSection title="You're joining">
                  <ListRow title="Environment" trailing={<Value text={preview.instance} />} />
                  <ListRow title="Shared from" trailing={<Value text={preview.sharedFrom || 'Not named'} />} />
                  <ListRow title="Address" trailing={<Value text={preview.endpoint} mono />} />
                  <ListRow title="Access" trailing={<Value text={expiryText(preview.expiresAt)} tone={expired ? 'error' : 'muted'} />} />
                </ListSection>
                {expired
                  ? <Banner tone="error" message={`This link has expired. Ask ${preview.sharedFrom || 'whoever shared it'} for a new one.`} />
                  : preview.alreadyJoined
                    ? <Banner message="This phone joined this share before. Joining again refreshes its access." />
                    : null}
                <TextField
                  label="Name on this phone"
                  value={name}
                  onChangeText={setName}
                  placeholder={preview.instance}
                  hint="Leave it empty to use the environment's own name."
                  autoCorrect={false}
                  returnKeyType="join"
                  onSubmitEditing={() => { if (!expired) void join() }}
                />
                {joinError ? <Banner tone="error" title="Could not join" message={joinError} /> : null}
                <View style={s.buttons}>
                  <Button label="Join" variant="primary" size="lg" block loading={joining} disabled={expired} onPress={join} />
                  <Button label="Use a different link" variant="ghost" block onPress={() => { setLink(''); setJoinError(null) }} />
                </View>
              </>
            )
          : (
              <>
                <Scanner
                  active={camera}
                  onStart={() => setCamera(true)}
                  onScanned={(data) => { setLink(data); setCamera(false); haptic('success') }}
                />
                <View style={s.paste}>
                  <TextField
                    label="Or paste the share link"
                    value={link}
                    onChangeText={(v) => { setLink(v); setPasteNote(null) }}
                    placeholder="mango://join/…"
                    mono
                    multiline
                    autoCapitalize="none"
                    autoCorrect={false}
                    spellCheck={false}
                    error={read?.error ?? pasteNote}
                    hint="Mango on your computer gives you this link when you share an environment."
                  />
                  <Button label="Paste" icon={ClipboardPaste} size="sm" onPress={() => paste(false)} />
                </View>
              </>
            )}
      </ScreenScroll>
    </ListGround.Provider>
  )
}

function Value({ text, mono, tone = 'muted' }: { text: string; mono?: boolean; tone?: 'muted' | 'error' }) {
  const s = useStyles()
  return <Text variant={mono ? 'mono' : 'bodySm'} tone={tone} numberOfLines={1} ellipsizeMode="middle" selectable style={s.value}>{text}</Text>
}

/**
 * The QR scanner: off until asked for (the camera prompt comes only when the person wants it),
 * then the camera with the permission's every state handled. A code that isn't a share link is
 * named, and scanning goes on.
 */
function Scanner({ active, onStart, onScanned }: { active: boolean; onStart: () => void; onScanned: (link: string) => void }) {
  const t = useTheme()
  const s = useStyles()
  const [permission, request] = useCameraPermissions()
  const [note, setNote] = useState<string | null>(null)
  const busy = useRef(false)

  useEffect(() => {
    if (active && permission && !permission.granted && permission.canAskAgain) void request()
  }, [active, permission?.granted]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!active) {
    return (
      <View style={[s.frame, s.idle]}>
        <QrCode size={32} strokeWidth={1.5} color={t.colors.fgFaint} />
        <Text variant="bodySm" tone="subtle" style={s.center}>Scan the code Mango shows when you share an environment.</Text>
        <Button label="Scan share code" variant="primary" icon={ScanLine} onPress={onStart} style={s.centered} />
      </View>
    )
  }

  if (!permission) {
    return <View style={[s.frame, s.idle]}><Spinner size={18} label="Starting the camera" /></View>
  }

  if (!permission.granted) {
    return (
      <View style={[s.frame, s.idle]}>
        <Text variant="label" style={s.center}>Mango needs the camera to scan a code</Text>
        <Text variant="bodySm" tone="subtle" style={s.center}>
          {permission.canAskAgain ? 'It is used only while this screen is open.' : 'Camera access is off for Mango. Turn it on in Settings, or paste the link below.'}
        </Text>
        {permission.canAskAgain || Platform.OS === 'web'
          ? <Button label="Allow camera" variant="primary" onPress={() => { void request() }} style={s.centered} />
          : <Button label="Open Settings" onPress={() => { void Linking.openSettings() }} style={s.centered} />}
      </View>
    )
  }

  return (
    <View style={s.cameraWrap}>
      <View style={[s.frame, s.square]}>
        <CameraView
          style={s.camera}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            if (busy.current) return
            const found = joinLinkOf(data)
            if (found) { busy.current = true; onScanned(found); return }
            setNote("That code isn't a Mango share code. Scan the one Mango shows when you share an environment.")
          }}
          onMountError={e => setNote(`The camera could not start: ${e.message}`)}
        />
      </View>
      <Text variant="caption" tone={note ? 'error' : 'subtle'} style={s.center} accessibilityLiveRegion="polite">
        {note ?? 'Point the camera at the code on your computer.'}
      </Text>
    </View>
  )
}

const useStyles = makeStyles(t => ({
  buttons: { gap: space[2] },
  paste: { gap: space[2], alignItems: 'flex-start' },
  value: { flexShrink: 1, maxWidth: 210, textAlign: 'right' },
  cameraWrap: { gap: space[2] },
  frame: {
    width: '100%',
    borderRadius: t.radius.lg,
    borderCurve: 'continuous',
    overflow: 'hidden',
    backgroundColor: t.colors.bgInset,
    borderWidth: 1,
    borderColor: t.colors.line,
  },
  /** The live camera: a square viewfinder. */
  square: { aspectRatio: 1, maxHeight: 340, alignSelf: 'center' },
  /** Before the camera starts: a compact panel that asks for it. */
  idle: { alignItems: 'center', justifyContent: 'center', gap: space[3], paddingVertical: space[8], paddingHorizontal: space[6] },
  centered: { alignSelf: 'center' },
  camera: { flex: 1 },
  center: { textAlign: 'center' },
}))
