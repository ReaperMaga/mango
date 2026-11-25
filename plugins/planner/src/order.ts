/**
 * Positions as short strings ("fractional indexing"): a new position between two others is a new key, so moving
 * one thing writes one thing. Keys are read as base-62 fractions and compare as plain strings.
 *
 * Two writers may make the same key, and data from elsewhere may hold anything: ties are broken by id
 * (`compareOrder`), and `between` answers null when nothing fits, which is when the caller re-spaces (`spread`).
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const BASE = DIGITS.length
/** Adding at either end counts up or down in this many digits, so keys stay short however much is added. */
const WIDTH = 5
const CAPACITY = BASE ** WIDTH
const MAX_LENGTH = 200

/** A key is usable when it is base-62 and does not end in 0 (nothing fits between `a` and `a0`). */
export function isKey(key: unknown): key is string {
  return typeof key === 'string' && key.length <= MAX_LENGTH && /^[0-9A-Za-z]*[1-9A-Za-z]$/.test(key)
}

function toNumber(key: string): number {
  let n = 0
  for (let i = 0; i < WIDTH; i++) n = n * BASE + (i < key.length ? DIGITS.indexOf(key[i]!) : 0)
  return n
}

function fromNumber(n: number): string {
  let s = ''
  for (let i = 0; i < WIDTH; i++) {
    s = DIGITS[n % BASE]! + s
    n = Math.floor(n / BASE)
  }
  return s
}

/** The midpoint of two fractions; `b` null is 1. Requires a < b. */
function midpoint(a: string, b: string | null): string {
  let prefix = ''
  for (let i = 0; ; i++) {
    const x = i < a.length ? DIGITS.indexOf(a[i]!) : 0
    const y = b === null ? BASE : i < b.length ? DIGITS.indexOf(b[i]!) : 0
    if (x === y) {
      prefix += DIGITS[x]
      continue
    }
    if (y - x > 1) return prefix + DIGITS[Math.floor((x + y) / 2)]
    // Neighbouring digits: keep the lower one, and go on above `a` with no upper limit.
    prefix += DIGITS[x]
    b = null
  }
}

/**
 * A key after `a` and before `b` (null: no limit on that side). Null when there is none: the keys are equal, out
 * of order, or not keys at all.
 */
export function between(a: string | null, b: string | null): string | null {
  if (a !== null && !isKey(a)) return null
  if (b !== null && !isKey(b)) return null
  let key: string
  if (a === null && b === null) {
    key = fromNumber(Math.floor(CAPACITY / 2) + 1)
  } else if (b === null) {
    let n = toNumber(a!) + 1
    if (n % BASE === 0) n++
    key = n < CAPACITY ? fromNumber(n) : midpoint(a!, null)
  } else if (a === null) {
    let n = toNumber(b) - 1
    if (n % BASE === 0) n--
    key = n > 0 ? fromNumber(n) : midpoint('', b)
  } else if (a < b) {
    key = midpoint(a, b)
  } else {
    return null
  }
  return isKey(key) ? key : null
}

/** `n` keys in order, evenly spaced with room on both sides. */
export function spread(n: number): string[] {
  const step = Math.max(2, Math.floor(CAPACITY / (n + 1)))
  return Array.from({ length: n }, (_, i) => {
    const at = step * (i + 1)
    return fromNumber(at % BASE === 0 ? at + 1 : at)
  })
}

/** `n` keys after `a` and before `b`, or null when they do not fit. */
export function manyBetween(a: string | null, b: string | null, n: number): string[] | null {
  if (a !== null && b !== null && !(a < b)) return null
  const out: string[] = []
  // Before everything else the keys count down, so they are made from the last to the first.
  const down = a === null && b !== null
  let edge = down ? b : a
  for (let i = 0; i < n; i++) {
    const key = down ? between(null, edge) : between(edge, b)
    if (key === null) return null
    out.push(key)
    edge = key
  }
  return down ? out.reverse() : out
}

export interface Ordered { readonly id: string; readonly order: string }

export function compareOrder(a: Ordered, b: Ordered): number {
  if (a.order !== b.order) return a.order < b.order ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Where something is put: before or after another entry, or at either end. */
export type Position = 'start' | 'end' | { before: string } | { after: string }

/**
 * The keys that put `ids` (in this sequence) at `position` among `list`. Usually only theirs; when the keys
 * around that place leave no room, the whole list's. An unknown neighbour counts as the end.
 */
export function placeAt(list: readonly Ordered[], ids: readonly string[], position: Position): Map<string, string> {
  const moving = new Set(ids)
  const rest = list.filter(e => !moving.has(e.id)).sort(compareOrder)
  let index = rest.length
  if (position === 'start') index = 0
  else if (position !== 'end') {
    const at = rest.findIndex(e => e.id === ('before' in position ? position.before : position.after))
    if (at >= 0) index = 'before' in position ? at : at + 1
  }
  const keys = manyBetween(rest[index - 1]?.order ?? null, rest[index]?.order ?? null, ids.length)
  if (keys) return new Map(ids.map((id, i) => [id, keys[i]!]))
  const all = [...rest.slice(0, index).map(e => e.id), ...ids, ...rest.slice(index).map(e => e.id)]
  const fresh = spread(all.length)
  return new Map(all.map((id, i) => [id, fresh[i]!]))
}
