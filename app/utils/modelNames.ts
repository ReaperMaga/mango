/**
 * A model's title from a raw id, for the few places one reaches the picker unnamed (a chat whose model
 * the CLI no longer lists, the built-in fallback list): `claude-opus-4-1-20250805` reads "Opus 4.1",
 * `claude-3-5-sonnet-latest` "Sonnet 3.5", `claude-sonnet-4-5[1m]` "Sonnet 4.5 (1M context)".
 * Anything that is not a `claude-…` id is returned as it is. Plain TypeScript (tests run in Node).
 */
export function modelTitle(name: string): string {
  const raw = name.trim()
  const m = /^claude-([a-z0-9-]+?)(\[1m\])?$/i.exec(raw)
  if (!m) return name
  const words: string[] = []
  const version: string[] = []
  for (const part of m[1]!.split('-')) {
    if (/^\d{8}$/.test(part) || part === 'latest') continue
    if (/^\d{1,2}$/.test(part)) version.push(part)
    else if (/^[a-z]+$/i.test(part)) words.push(part[0]!.toUpperCase() + part.slice(1).toLowerCase())
    else return name
  }
  if (!words.length) return name
  return [words.join(' '), version.join('.'), m[2] ? '(1M context)' : ''].filter(Boolean).join(' ')
}
