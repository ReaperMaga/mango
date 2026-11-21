/**
 * Turn chime: plays a short chime when an agent's turn ends. A finished turn rises (two bright notes),
 * a failed one falls (two low, softer notes). The tones are synthesised with WebAudio, so the plugin
 * ships no audio files.
 */

/** [frequency Hz, start s, length s] per note. */
const DONE = [[659.25, 0, 0.32], [987.77, 0.11, 0.5]] // E5, B5
const FAILED = [[392.0, 0, 0.3], [293.66, 0.14, 0.5]] // G4, D4

/** Several chats ending together chime once. */
const QUIET_MS = 1500

export function activate(mango) {
  let ctx = null
  let lastAt = 0

  const audio = () => {
    const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext
    if (!Ctor) return null
    ctx ??= new Ctor()
    return ctx
  }

  const play = async (ok) => {
    const volume = Math.min(100, Math.max(0, Number(mango.settings.get('volume') ?? 40))) / 100
    if (!volume) return
    const ac = audio()
    if (!ac) return
    // A context made without a user gesture may start suspended.
    if (ac.state === 'suspended') await ac.resume()

    const out = ac.createGain()
    out.gain.value = volume * (ok ? 0.35 : 0.3)
    out.connect(ac.destination)

    const t0 = ac.currentTime + 0.02
    for (const [freq, start, length] of ok ? DONE : FAILED) {
      const osc = ac.createOscillator()
      const env = ac.createGain()
      osc.type = ok ? 'sine' : 'triangle'
      osc.frequency.value = freq
      // A quick attack and an exponential tail, so it reads as a bell and does not click.
      env.gain.setValueAtTime(0.0001, t0 + start)
      env.gain.exponentialRampToValueAtTime(1, t0 + start + 0.012)
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + start + length)
      osc.connect(env).connect(out)
      osc.start(t0 + start)
      osc.stop(t0 + start + length + 0.05)
    }
    // Let go of the output once the last note is gone.
    setTimeout(() => out.disconnect(), 1200)
  }

  const shouldPlay = (threadId) => {
    const when = mango.settings.get('when') ?? 'unfocused'
    if (when === 'off') return false
    // Sub-agents end turns inside a running chat: only the chat itself counts.
    const thread = mango.chat.get(threadId)
    if (thread?.parentId) return false
    if (when === 'always') return true
    return document.visibilityState === 'hidden' || !document.hasFocus()
  }

  mango.chat.onTurnEnd((threadId, ok) => {
    try {
      if (!shouldPlay(threadId)) return
      const now = Date.now()
      if (now - lastAt < QUIET_MS) return
      lastAt = now
      play(ok).catch(e => mango.log.warn('Could not play the chime:', e))
    } catch (e) {
      mango.log.warn('Could not play the chime:', e)
    }
  })

  mango.commands.register({
    id: 'test',
    title: 'Turn chime: play both chimes',
    icon: 'bell-ring',
    keywords: 'sound test',
    run: async () => {
      try {
        await play(true)
        setTimeout(() => play(false).catch(() => {}), 900)
      } catch (e) {
        mango.ui.toast({ title: 'Could not play the chime', body: e instanceof Error ? e.message : String(e), kind: 'error' })
      }
    },
  })

  mango.onDispose(() => {
    ctx?.close().catch(() => {})
    ctx = null
  })
}
