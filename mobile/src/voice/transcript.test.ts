import { describe, expect, it } from 'vitest'
import { clock, hear, insertAt, joinWords, normalizePrefs, NOTHING_HEARD, noticeFor, pickLocale, problemOf, spoken } from './transcript'

describe('hear', () => {
  it('replaces the interim guess and piles up finished segments', () => {
    let h = hear(NOTHING_HEARD, false, 'fix the')
    h = hear(h, false, 'fix the build')
    expect(spoken(h)).toBe('fix the build')
    h = hear(h, true, 'Fix the build.')
    expect(h).toEqual({ final: 'Fix the build.', interim: '' })
    h = hear(h, false, 'then')
    expect(spoken(h)).toBe('Fix the build. then')
    // iOS starts a later final segment with a space: one space between, never two.
    h = hear(h, true, ' Then run the tests.')
    expect(spoken(h)).toBe('Fix the build. Then run the tests.')
  })

  it('ignores empty results', () => {
    expect(spoken(hear(NOTHING_HEARD, true, '  '))).toBe('')
  })
})

describe('joinWords', () => {
  it('puts no space between words of scripts that use none', () => {
    expect(joinWords('ビルドを', '直して')).toBe('ビルドを直して')
    expect(joinWords('hello', 'world')).toBe('hello world')
    expect(joinWords('', 'world')).toBe('world')
  })
})

describe('insertAt', () => {
  it('appends after the draft with a space when no caret is known', () => {
    expect(insertAt('Please', null, 'fix the build')).toEqual({ text: 'Please fix the build', caret: 20 })
  })

  it('fills an empty draft', () => {
    expect(insertAt('', undefined, ' hello ')).toEqual({ text: 'hello', caret: 5 })
  })

  it('goes where the caret is, spaced on both sides', () => {
    const draft = 'Fix,then push'
    const r = insertAt(draft, { start: 4, end: 4 }, 'run the tests')
    expect(r.text).toBe('Fix, run the tests then push')
    expect(r.text.slice(0, r.caret)).toBe('Fix, run the tests ')
  })

  it('does not double spaces already there', () => {
    expect(insertAt('a  b', { start: 2, end: 2 }, 'x').text).toBe('a x b')
  })

  it('replaces a selection', () => {
    expect(insertAt('use npm here', { start: 4, end: 7 }, 'pnpm').text).toBe('use pnpm here')
  })

  it('clamps a stale selection (the draft changed since)', () => {
    expect(insertAt('ab', { start: 9, end: 40 }, 'c').text).toBe('ab c')
  })

  it('leaves the draft alone when nothing was said', () => {
    expect(insertAt('keep', { start: 2, end: 2 }, '  ')).toEqual({ text: 'keep', caret: 2 })
  })
})

describe('pickLocale', () => {
  const ios = ['de-AT', 'de-DE', 'en-AU', 'en-GB', 'en-US', 'fr-CA', 'fr-FR', 'ja-JP', 'zh-CN', 'zh-TW']

  it('follows the phone when no language is chosen', () => {
    expect(pickLocale(null, ['en-GB'], ios)).toBe('en-GB')
    expect(pickLocale(null, ['de_CH', 'en-US'], ios)).toBe('de-AT')
    expect(pickLocale(null, ['xx-YY'], ios)).toBe('en-US')
  })

  it('keeps the phone\'s region for a chosen language when it can', () => {
    expect(pickLocale('en', ['en-GB', 'de-DE'], ios)).toBe('en-GB')
    expect(pickLocale('fr', ['en-US'], ios)).toBe('fr-FR')
    expect(pickLocale('de', ['de-CH'], ios)).toBe('de-DE')
  })

  it('says so when the recognizer lacks the language', () => {
    expect(pickLocale('ko', ['en-US'], ios)).toBeNull()
  })

  it('guesses unchecked when the recognizer lists nothing (a browser)', () => {
    expect(pickLocale(null, ['en-GB'], [])).toBe('en-GB')
    expect(pickLocale(null, [], [])).toBe('en-US')
    expect(pickLocale('pt', ['en-US'], [])).toBe('pt-BR')
    expect(pickLocale('pt', ['pt_PT'], [])).toBe('pt-PT')
  })

  it('matches regardless of case and separator', () => {
    expect(pickLocale(null, ['EN_gb'], ios)).toBe('en-GB')
  })
})

describe('normalizePrefs', () => {
  it('keeps valid values and drops the rest', () => {
    expect(normalizePrefs({ language: 'de', sendAfter: true })).toEqual({ language: 'de', sendAfter: true })
    expect(normalizePrefs({ language: 'klingon', sendAfter: 'yes' })).toEqual({ language: null, sendAfter: false })
    expect(normalizePrefs(null)).toEqual({ language: null, sendAfter: false })
    expect(normalizePrefs('garbage')).toEqual({ language: null, sendAfter: false })
  })
})

describe('problems', () => {
  it('maps recognizer codes, a deliberate stop to nothing', () => {
    expect(problemOf('aborted')).toBeNull()
    expect(problemOf('not-allowed')).toBe('denied')
    expect(problemOf('no-speech')).toBe('no-speech')
    expect(problemOf('nomatch')).toBe('no-speech')
    expect(problemOf('something-new')).toBe('other')
  })

  it('names the way out', () => {
    const ctx = { language: 'German', device: 'iPhone' }
    expect(noticeFor('denied', ctx)).toMatchObject({ tone: 'error', settings: 'system' })
    expect(noticeFor('language', ctx).text).toContain('German')
    expect(noticeFor('language', ctx).settings).toBe('app')
    expect(noticeFor('no-speech', ctx).tone).toBe('info')
    expect(noticeFor('other', { ...ctx, detail: 'boom' }).text).toBe('Dictation stopped: boom')
  })
})

describe('clock', () => {
  it('reads m:ss', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(65.7)).toBe('1:05')
  })
})
