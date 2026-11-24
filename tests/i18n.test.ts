/**
 * Interface languages: which one shows, and that the translations hold together.
 *
 *   node --test tests/i18n.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { globSync, readFileSync } from 'node:fs'
import { i18n } from '../app/i18n/index.ts'
import { formatLocaleOf, localePrefOf, resolveLocale, russianPlural } from '../app/i18n/locales.ts'
import { de } from '../app/i18n/messages/de/index.ts'
import { en } from '../app/i18n/messages/en/index.ts'
import { ru } from '../app/i18n/messages/ru/index.ts'

type Tree = { [key: string]: string | Tree }
const flatten = (tree: Tree, prefix = ''): Array<[string, string]> => Object.entries(tree).flatMap(([k, v]) =>
  (typeof v === 'string' ? [[prefix + k, v] as [string, string]] : flatten(v, `${prefix}${k}.`)))
const params = (text: string) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]!))].sort()

test('a picked language wins over the computer\'s', () => {
  assert.equal(resolveLocale('ru', ['de-DE']), 'ru')
})

test('system takes the first language Mango has, else English', () => {
  assert.equal(resolveLocale('system', ['fr-FR', 'de-AT', 'ru']), 'de')
  assert.equal(resolveLocale('system', ['fr']), 'en')
  assert.equal(resolveLocale('system', []), 'en')
})

test('an unreadable pref means system', () => {
  for (const v of [undefined, null, 1, 'fr', 'toString']) assert.equal(localePrefOf(v), 'system')
  assert.equal(localePrefOf('de'), 'de')
})

const source = new Map(flatten(en))

for (const [name, messages] of Object.entries({ de, ru })) {
  test(`${name} has the keys and placeholders of English`, () => {
    const translated = new Map(flatten(messages))
    assert.deepEqual([...translated.keys()].sort(), [...source.keys()].sort())
    for (const [key, text] of translated) assert.deepEqual(params(text), params(source.get(key)!), key)
  })
}

test('dates take the computer\'s region of the language', () => {
  assert.equal(formatLocaleOf('en', ['de-DE', 'en-GB']), 'en-GB')
  assert.equal(formatLocaleOf('ru', ['de-DE']), 'ru')
})

test('Russian counts', () => {
  const forms = [1, 2, 5, 11, 14, 21, 22, 25, 101, 111, 0].map(russianPlural)
  assert.deepEqual(forms, [0, 1, 2, 2, 2, 0, 1, 2, 0, 2, 2])
})

/** Plural messages: two forms in English and German, three in Russian. A literal "|" is written {'|'}. */
const forms = (text: string) => text.replaceAll("{'|'}", '').split('|').length
test('counted messages have the forms their language needs', () => {
  const [german, russian] = [new Map(flatten(de)), new Map(flatten(ru))]
  for (const [key, text] of source) {
    const counted = forms(text) > 1
    assert.equal(forms(text), counted ? 2 : 1, key)
    assert.equal(forms(german.get(key)!), counted ? 2 : 1, `de ${key}`)
    assert.equal(forms(russian.get(key)!), counted ? 3 : 1, `ru ${key}`)
  }
})

test('every message compiles', (t) => {
  const warnings: unknown[] = []
  t.mock.method(console, 'warn', (w: unknown) => warnings.push(w))
  t.mock.method(console, 'error', (w: unknown) => warnings.push(w))
  for (const [locale, messages] of Object.entries({ en, de, ru })) {
    for (const [key, text] of flatten(messages)) {
      const named = Object.fromEntries(params(text).map(p => [p, 'x']))
      i18n.global.t(key, named, { locale })
    }
  }
  assert.deepEqual(warnings, [])
})

test('every key the code names exists', () => {
  for (const file of globSync('app/**/*.{vue,ts}')) {
    const code = readFileSync(file, 'utf8')
    for (const [, key] of code.matchAll(/(?:\bt\(\s*|keypath=")'?([\w-]+(?:\.[\w-]+)+)['"]/g)) assert.ok(source.has(key!), `${file}: ${key}`)
    for (const [, prefix] of code.matchAll(/\bt\(`([\w.-]+\.)\$\{/g)) {
      assert.ok([...source.keys()].some(k => k.startsWith(prefix!)), `${file}: ${prefix}`)
    }
  }
})
