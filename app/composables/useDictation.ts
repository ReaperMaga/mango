import { useVoice } from '~/stores/voice'
import { t } from '~/i18n'

/**
 * Records the microphone and turns it into text with the voice store.
 *
 * Audio is captured at the device's own rate through an AudioWorklet, then
 * resampled to Whisper's 16 kHz mono by an OfflineAudioContext when recording
 * stops. Nothing is sent anywhere: the backend transcribes on this computer.
 */

export type DictationPhase = 'idle' | 'starting' | 'recording' | 'transcribing'

/** Recordings stop on their own after this long (the backend accepts up to 10 minutes). */
const MAX_SECONDS = 5 * 60
const TARGET_RATE = 16_000

const TAP = `
class MangoTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) this.port.postMessage(ch.slice(0))
    return true
  }
}
registerProcessor('mango-tap', MangoTap)
`
let tapUrl: string | null = null

function micError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return t('chat.dictation.notAllowed')
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return t('chat.dictation.notFound')
  if (name === 'NotReadableError') return t('chat.dictation.inUse')
  if (!navigator.mediaDevices?.getUserMedia) return t('chat.dictation.unsupported')
  return t('chat.dictation.failed', { error: e instanceof Error ? e.message : String(e) })
}

/** How often a running recording is transcribed again to show words as they are said. */
const LIVE_EVERY_MS = 1500
/** A live pass needs this much new speech; the text before it is kept and the buffer starts over past the cap. */
const LIVE_MIN_SECONDS = 0.6
const SEGMENT_SECONDS = 25

/**
 * `onText` gets the finished text once recording stops. `onLive` gets the text
 * so far while it runs (and `null` when the recording is thrown away), so the
 * words appear as they are said instead of after the last one.
 */
export function useDictation(onText: (text: string) => void, onLive?: (text: string | null) => void) {
  const voice = useVoice()
  const phase = ref<DictationPhase>('idle')
  /** 0..1, smoothed loudness for a level meter. */
  const level = ref(0)
  const seconds = ref(0)
  const error = ref<string | null>(null)

  let stream: MediaStream | null = null
  let ctx: AudioContext | null = null
  let node: AudioWorkletNode | null = null
  let chunks: Float32Array[] = []
  let rate = 48_000
  let startedAt = 0
  let ticker: ReturnType<typeof setInterval> | undefined
  /** Bumped by cancel/stop so a start that is still awaiting the mic can tell it was abandoned. */
  let session = 0
  /** Text of earlier segments of this recording, already final. */
  let committed = ''
  let liveTimer: ReturnType<typeof setTimeout> | undefined
  let liveBusy = false

  const join = (a: string, b: string) => [a, b].filter(Boolean).join(' ')

  function scheduleLive(mine: number) {
    clearTimeout(liveTimer)
    liveTimer = setTimeout(() => void liveStep(mine), LIVE_EVERY_MS)
  }

  /** Transcribes what has been said so far and shows it; never overlaps itself. */
  async function liveStep(mine: number) {
    if (mine !== session || phase.value !== 'recording') return
    const count = chunks.length
    const samples = chunks.reduce((n, c, i) => (i < count ? n + c.length : n), 0)
    if (liveBusy || samples / rate < LIVE_MIN_SECONDS) { scheduleLive(mine); return }
    liveBusy = true
    try {
      const pcm = await toPcm16(chunks.slice(0, count), rate)
      const { text } = await voice.transcribe(pcm)
      if (mine !== session || phase.value !== 'recording') return
      const tail = text.trim()
      onLive?.(join(committed, tail))
      if (samples / rate > SEGMENT_SECONDS && tail) {
        committed = join(committed, tail)
        chunks.splice(0, count)
      }
    } catch {
      // The final pass reports real problems; a missed live pass costs nothing.
    } finally {
      liveBusy = false
      if (mine === session && phase.value === 'recording') scheduleLive(mine)
    }
  }

  async function start() {
    if (phase.value !== 'idle') return
    error.value = null
    const mine = ++session
    phase.value = 'starting'
    try {
      const s = await openMic(voice.micId)
      if (mine !== session) { s.getTracks().forEach(track => track.stop()); return }
      stream = s
      ctx = new AudioContext()
      rate = ctx.sampleRate
      tapUrl ??= URL.createObjectURL(new Blob([TAP], { type: 'text/javascript' }))
      await ctx.audioWorklet.addModule(tapUrl)
      if (mine !== session) { release(); return }
      const source = ctx.createMediaStreamSource(s)
      node = new AudioWorkletNode(ctx, 'mango-tap')
      chunks = []
      committed = ''
      node.port.onmessage = (e: MessageEvent<Float32Array>) => {
        chunks.push(e.data)
        let sum = 0
        for (const x of e.data) sum += x * x
        const rms = Math.sqrt(sum / e.data.length)
        // Speech sits around 0.02–0.2 RMS; map it onto 0..1 and fall back slowly.
        const target = Math.min(1, rms * 6)
        level.value = target > level.value ? target : level.value * 0.85 + target * 0.15
      }
      source.connect(node)
      startedAt = performance.now()
      seconds.value = 0
      ticker = setInterval(() => {
        seconds.value = Math.floor((performance.now() - startedAt) / 1000)
        if (seconds.value >= MAX_SECONDS) void stop()
      }, 250)
      phase.value = 'recording'
      scheduleLive(mine)
    } catch (e) {
      release()
      if (mine === session) {
        error.value = micError(e)
        phase.value = 'idle'
      }
    }
  }

  function release() {
    clearTimeout(liveTimer)
    clearInterval(ticker)
    ticker = undefined
    if (node) node.port.onmessage = null
    node?.disconnect()
    node = null
    stream?.getTracks().forEach(track => track.stop())
    stream = null
    void ctx?.close().catch(() => {})
    ctx = null
    level.value = 0
  }

  /** Stop and throw the recording away. */
  function cancel() {
    session++
    release()
    chunks = []
    if (committed || phase.value === 'recording' || phase.value === 'starting') onLive?.(null)
    committed = ''
    if (phase.value !== 'transcribing') phase.value = 'idle'
  }

  /** Stop recording and transcribe what was said. */
  async function stop() {
    if (phase.value === 'starting') { cancel(); return }
    if (phase.value !== 'recording') return
    const mine = ++session
    const recorded = chunks
    const sourceRate = rate
    const before = committed
    chunks = []
    release()
    phase.value = 'transcribing'
    try {
      const pcm = await toPcm16(recorded, sourceRate)
      // Under a quarter second there is nothing to hear: keep what was already said.
      const tail = pcm.length < TARGET_RATE / 4 ? '' : (await voice.transcribe(pcm)).text.trim()
      const full = join(before, tail)
      if (mine !== session) return
      if (full) onText(full)
      else onLive?.(null)
    } catch (e) {
      if (mine === session) {
        error.value = e instanceof Error ? e.message : String(e)
        if (before) onText(before)
        else onLive?.(null)
      }
    } finally {
      if (mine === session) phase.value = 'idle'
    }
  }

  function toggle() {
    if (phase.value === 'recording' || phase.value === 'starting') void stop()
    else if (phase.value === 'idle') void start()
  }

  onBeforeUnmount(cancel)

  return { phase, level, seconds, error, start, stop, cancel, toggle }
}

/** The chosen microphone, or the system default when it is unplugged or none was chosen. */
async function openMic(deviceId: string | null): Promise<MediaStream> {
  const base = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: deviceId } } })
    } catch (e) {
      const name = e instanceof DOMException ? e.name : ''
      if (name !== 'OverconstrainedError' && name !== 'NotFoundError') throw e
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: base })
}

/** Joins the captured chunks and resamples them to 16 kHz 16-bit PCM. */
async function toPcm16(chunks: Float32Array[], rate: number): Promise<Int16Array> {
  const length = chunks.reduce((n, c) => n + c.length, 0)
  if (!length) return new Int16Array(0)
  const joined = new Float32Array(length)
  let at = 0
  for (const c of chunks) { joined.set(c, at); at += c.length }

  let mono = joined
  if (rate !== TARGET_RATE) {
    const frames = Math.ceil(length * TARGET_RATE / rate)
    const offline = new OfflineAudioContext(1, frames, TARGET_RATE)
    const buf = offline.createBuffer(1, length, rate)
    buf.copyToChannel(joined, 0)
    const src = offline.createBufferSource()
    src.buffer = buf
    src.connect(offline.destination)
    src.start()
    mono = (await offline.startRendering()).getChannelData(0)
  }
  const out = new Int16Array(mono.length)
  for (let i = 0; i < mono.length; i++) {
    const s = Math.max(-1, Math.min(1, mono[i]!))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}
