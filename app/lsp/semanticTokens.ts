import type { SemanticTokensLegend } from './protocol.ts'

/**
 * Semantic colouring: what a server knows each name is (a class, a method, a field) on top of the
 * tokenizer's keywords, strings and comments. Every server has a legend of its own; Mango maps it onto
 * the few kinds its theme colours (`composables/monaco.ts`, a rule for each) and drops the rest, so
 * the tokenizer's colours stay wherever the server's word would add nothing. What a server sends is
 * untrusted: a malformed answer colours nothing.
 */

/** Mango's legend: each one is also the name of a theme rule. */
export const TOKEN_KINDS = ['type', 'function', 'constant', 'property', 'variable', 'namespace', 'macro'] as const
export type TokenKind = typeof TOKEN_KINDS[number]

export const LEGEND = { tokenTypes: [...TOKEN_KINDS], tokenModifiers: [] as string[] }

/** The servers' token types (the protocol's, and those csharp-ls, rust-analyzer, pyright and clangd add), as Mango's kinds. */
const KIND_OF: Readonly<Record<string, TokenKind>> = {
  class: 'type',
  struct: 'type',
  interface: 'type',
  enum: 'type',
  type: 'type',
  typeParameter: 'type',
  typeAlias: 'type',
  builtinType: 'type',
  selfTypeKeyword: 'type',
  concept: 'type',
  delegate: 'type',
  method: 'function',
  function: 'function',
  member: 'function',
  decorator: 'function',
  enumMember: 'constant',
  constant: 'constant',
  property: 'property',
  field: 'property',
  event: 'property',
  variable: 'variable',
  parameter: 'variable',
  selfParameter: 'variable',
  clsParameter: 'variable',
  namespace: 'namespace',
  module: 'namespace',
  macro: 'macro',
}

/** The token types Mango says it understands. */
export const KNOWN_TOKEN_TYPES = Object.keys(KIND_OF)

/** Larger answers colour nothing: more tokens than any file an editor can show has. */
export const MAX_TOKENS = 500_000
const MAX_LEGEND = 1000
const MAX_VALUE = 2 ** 31 - 1

/** A server's token types, by index, as Mango's kinds (-1: not coloured). Null for a legend that is no legend. */
export function kindMap(legend: SemanticTokensLegend | null | undefined): Int16Array | null {
  const types: unknown = legend?.tokenTypes
  if (!Array.isArray(types)) return null
  const map = new Int16Array(Math.min(types.length, MAX_LEGEND)).fill(-1)
  for (let i = 0; i < map.length; i++) {
    const type = types[i]
    if (typeof type === 'string' && Object.hasOwn(KIND_OF, type)) map[i] = TOKEN_KINDS.indexOf(KIND_OF[type]!)
  }
  return map
}

/**
 * A server's tokens in Mango's legend: those of kinds Mango colours, without modifiers, each again
 * placed relative to the one kept before it. Null when the answer is malformed or too large.
 */
export function toSemanticTokens(result: unknown, map: Int16Array): Uint32Array | null {
  const data: unknown = (result as { data?: unknown } | null)?.data
  if (!Array.isArray(data) || data.length % 5 !== 0 || data.length > MAX_TOKENS * 5) return null
  const out: number[] = []
  let line = 0
  let char = 0
  let keptLine = 0
  let keptChar = 0
  for (let i = 0; i < data.length; i += 5) {
    for (let j = i; j < i + 4; j++) {
      const n = data[j]
      if (!Number.isInteger(n) || n < 0 || n > MAX_VALUE) return null
    }
    const [deltaLine, deltaChar, length, type] = data.slice(i, i + 4) as number[]
    if (deltaLine) {
      line += deltaLine!
      char = deltaChar!
    } else {
      char += deltaChar!
    }
    if (line > MAX_VALUE || char > MAX_VALUE) return null
    const kind = type! < map.length ? map[type!]! : -1
    if (kind < 0 || !length) continue
    out.push(line - keptLine, line === keptLine ? char - keptChar : char, length, kind, 0)
    keptLine = line
    keptChar = char
  }
  return Uint32Array.from(out)
}
