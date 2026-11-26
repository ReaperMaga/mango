import { describe, expect, it } from 'vitest'
import { DEFAULT_PREFS, modeForProject, modeLabel, normalizePrefs } from './prefsModel'

describe('normalizePrefs', () => {
  it('gives the defaults for nothing, junk or a first run', () => {
    expect(normalizePrefs(null)).toEqual(DEFAULT_PREFS)
    expect(normalizePrefs('x')).toEqual(DEFAULT_PREFS)
    expect(normalizePrefs({})).toEqual(DEFAULT_PREFS)
  })

  it('keeps notifications off until the person turns them on, but the rest of them on', () => {
    const n = normalizePrefs({}).notify
    expect(n.enabled).toBe(false)
    expect([n.needsYou, n.done, n.failed, n.preview]).toEqual([true, true, true, true])
    expect(normalizePrefs({ notify: { enabled: true, sound: true } }).notify).toMatchObject({ enabled: true, sound: true })
  })

  it('keeps valid choices and drops invalid ones', () => {
    const p = normalizePrefs({ homeView: 'latest', toolCalls: 'zen', defaultMode: 'auto', defaultAgent: 'codex', followUp: 'steer', confirmArchive: true, confirmDelete: false })
    expect(p).toMatchObject({ homeView: 'latest', toolCalls: 'zen', defaultMode: 'auto', defaultAgent: 'codex', followUp: 'steer', confirmArchive: true, confirmDelete: false })
    const bad = normalizePrefs({ homeView: 'grid', toolCalls: 'loud', defaultMode: 'yolo', defaultAgent: 'gpt', followUp: 3, confirmDelete: 'no' })
    expect(bad).toEqual(DEFAULT_PREFS)
  })

  it('names the modes', () => {
    expect(modeLabel('edits')).toBe('Accept edits')
  })

  it('lets a project override the default mode', () => {
    const p = normalizePrefs({ defaultMode: 'ask', projectModes: { '/a': 'auto', '/b': 'yolo', '/c': 3 } })
    expect(p.projectModes).toEqual({ '/a': 'auto' })
    expect(modeForProject(p, '/a')).toBe('auto')
    expect(modeForProject(p, '/b')).toBe('ask')
    expect(normalizePrefs(null).projectModes).toEqual({})
  })
})
