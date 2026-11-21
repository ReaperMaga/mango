/**
 * Focus timer: a work / break timer shown in the titlebar. Click it to start or pause; when a block ends
 * Mango shows a toast and a system notification and moves on to the next one.
 *
 * Time is kept as an end timestamp while running (not by counting ticks), so a throttled background
 * window or a reload does not make the clock drift. The state is saved in the plugin's storage, so a
 * running timer survives a restart.
 */

const STATE_KEY = 'state'

const pad = n => String(n).padStart(2, '0')
export const formatClock = ms => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
}

export function activate(mango) {
  const { ref, computed } = mango.vue

  const minutes = (key, fallback) => {
    const n = Number(mango.settings.get(key))
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  const length = phase => minutes(phase === 'work' ? 'workMinutes' : 'breakMinutes', phase === 'work' ? 25 : 5) * 60_000

  // phase: 'work' | 'break'. Running: endAt is set. Paused: remaining is set.
  const saved = (() => {
    try { return mango.storage.get(STATE_KEY) } catch { return undefined }
  })()
  const phase = ref(saved?.phase === 'break' ? 'break' : 'work')
  const endAt = ref(typeof saved?.endAt === 'number' ? saved.endAt : null)
  const remaining = ref(typeof saved?.remaining === 'number' ? saved.remaining : length(phase.value))
  const now = ref(Date.now())

  const running = computed(() => endAt.value !== null)
  const left = computed(() => (running.value ? endAt.value - now.value : remaining.value))
  // The length the current block started with: a block still at it has not been started yet.
  let blockLength = typeof saved?.blockLength === 'number' ? saved.blockLength : length(phase.value)
  const untouched = () => !running.value && remaining.value === blockLength

  const save = () => {
    try {
      mango.storage.set(STATE_KEY, { phase: phase.value, endAt: endAt.value, remaining: remaining.value, blockLength })
    } catch (e) {
      mango.log.warn('Could not save the timer:', e)
    }
  }

  const start = () => {
    if (running.value) return
    endAt.value = Date.now() + remaining.value
    now.value = Date.now()
    save()
  }
  const pause = () => {
    if (!running.value) return
    remaining.value = Math.max(0, endAt.value - Date.now())
    endAt.value = null
    save()
  }
  const reset = () => {
    endAt.value = null
    phase.value = 'work'
    blockLength = remaining.value = length('work')
    save()
  }
  const switchTo = (next, autoStart) => {
    phase.value = next
    endAt.value = null
    blockLength = remaining.value = length(next)
    if (autoStart) start()
    else save()
  }

  const finish = () => {
    const wasWork = phase.value === 'work'
    const next = wasWork ? 'break' : 'work'
    const autoStart = mango.settings.get('autoStart') === true
    switchTo(next, autoStart)
    const title = wasWork ? 'Time for a break' : 'Break is over'
    const body = wasWork
      ? `${minutes('breakMinutes', 5)} minute break${autoStart ? ' started' : ': click the timer to start it'}.`
      : `Next focus block: ${minutes('workMinutes', 25)} minutes${autoStart ? ', started' : ''}.`
    try {
      mango.ui.toast({
        title,
        body,
        kind: 'info',
        timeout: autoStart ? 5000 : 0,
        action: autoStart ? undefined : { label: wasWork ? 'Start break' : 'Start focus', run: start },
      })
      mango.ui.notify(title, body)
    } catch (e) {
      mango.log.warn('Could not announce the end of a block:', e)
    }
  }

  // One tick a second while running; idle timers cost nothing.
  const timer = setInterval(() => {
    if (!running.value) return
    now.value = Date.now()
    if (left.value <= 0) finish()
  }, 1000)
  mango.onDispose(() => {
    clearInterval(timer)
    // Pausing on disable keeps the remaining time honest if the plugin comes back later.
    if (running.value) pause()
  })

  // A timer that ran out while Mango was closed ends now.
  if (running.value && endAt.value <= Date.now()) finish()

  mango.ui.statusItems.register({
    id: 'timer',
    location: 'titlebar',
    icon: () => (phase.value === 'work' ? 'timer' : 'hourglass'),
    text: () => formatClock(left.value),
    tooltip: () => {
      const what = phase.value === 'work' ? 'Focus' : 'Break'
      if (running.value) return `${what}: ${formatClock(left.value)} left. Click to pause.`
      return untouched() ? `${what}: click to start.` : `${what} paused. Click to resume.`
    },
    onClick: () => (running.value ? pause() : start()),
  })

  mango.commands.register({
    id: 'toggle',
    title: 'Focus timer: start or pause',
    icon: 'timer',
    keywords: 'pomodoro',
    run: () => (running.value ? pause() : start()),
  })
  mango.commands.register({
    id: 'reset',
    title: 'Focus timer: reset',
    keywords: 'pomodoro',
    run: reset,
  })
  mango.commands.register({
    id: 'skip',
    title: 'Focus timer: skip to the next block',
    keywords: 'pomodoro break',
    run: () => switchTo(phase.value === 'work' ? 'break' : 'work', false),
  })

  // New lengths apply right away to a block that has not started yet.
  mango.settings.onChange(key => {
    if (key !== 'workMinutes' && key !== 'breakMinutes') return
    if (untouched()) {
      blockLength = remaining.value = length(phase.value)
      save()
    }
  })
}
