/**
 * Line changes between two versions of a file, for the editor's change markers: which lines of
 * the new text were added or changed, and where lines were removed. Myers' diff on interned
 * lines, after trimming the common start and end; past `maxEdits` differences it gives up on
 * detail and reports the differing middle as one change.
 */

export interface LineChange {
  kind: 'add' | 'mod' | 'del'
  /** First line in the new text (1-based). For 'del', the line the removed ones stood before (may be one past the end). */
  start: number
  /** Lines in the new text: 0 for 'del'. */
  count: number
  /** The lines as they were: empty for 'add'. */
  old: string[]
}

export function lineChanges(oldLines: string[], newLines: string[], maxEdits = 2000): LineChange[] {
  let pre = 0
  while (pre < oldLines.length && pre < newLines.length && oldLines[pre] === newLines[pre]) pre++
  let suf = 0
  while (suf < oldLines.length - pre && suf < newLines.length - pre
    && oldLines[oldLines.length - 1 - suf] === newLines[newLines.length - 1 - suf]) suf++
  const a = oldLines.slice(pre, oldLines.length - suf)
  const b = newLines.slice(pre, newLines.length - suf)
  if (!a.length && !b.length) return []

  const ids = new Map<string, number>()
  const intern = (s: string) => {
    let v = ids.get(s)
    if (v === undefined) { v = ids.size; ids.set(s, v) }
    return v
  }
  const pairs = matches(Int32Array.from(a, intern), Int32Array.from(b, intern), maxEdits) ?? []

  const out: LineChange[] = []
  let ai = 0
  let bi = 0
  const gap = (x: number, y: number) => {
    if (x === ai && y === bi) return
    const old = a.slice(ai, x)
    const count = y - bi
    out.push({ kind: count === 0 ? 'del' : old.length === 0 ? 'add' : 'mod', start: pre + bi + 1, count, old })
  }
  for (const [x, y] of pairs) {
    gap(x, y)
    ai = x + 1
    bi = y + 1
  }
  gap(a.length, b.length)
  return out
}

/** The matched (old, new) index pairs of a shortest edit script, in order; null past `maxD` edits. */
function matches(A: Int32Array, B: Int32Array, maxD: number): Array<[number, number]> | null {
  const N = A.length
  const M = B.length
  const max = N + M
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  // v as it stood after each round d, for k in [-d, d].
  const trace: Int32Array[] = []
  for (let d = 0; d <= Math.min(maxD, max); d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[k - 1 + off]! < v[k + 1 + off]!) ? v[k + 1 + off]! : v[k - 1 + off]! + 1
      let y = x - k
      while (x < N && y < M && A[x] === B[y]) { x++; y++ }
      v[k + off] = x
      if (x >= N && y >= M) {
        trace.push(v.slice(off - d, off + d + 1))
        return backtrack(trace, N, M)
      }
    }
    trace.push(v.slice(off - d, off + d + 1))
  }
  return null
}

function backtrack(trace: Int32Array[], N: number, M: number): Array<[number, number]> {
  const pairs: Array<[number, number]> = []
  let x = N
  let y = M
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1]!
    const at = (k: number) => prev[k + d - 1]!
    const k = x - y
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const prevK = down ? k + 1 : k - 1
    const prevX = at(prevK)
    const startX = down ? prevX : prevX + 1
    while (x > startX) { x--; y--; pairs.push([x, y]) }
    x = prevX
    y = prevX - prevK
  }
  while (x > 0 && y > 0) { x--; y--; pairs.push([x, y]) }
  return pairs.reverse()
}
