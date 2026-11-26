/**
 * Source a language server decompiled from a compiled library (a .NET assembly: UnityEngine, a
 * NuGet package, the framework), opened by going to a definition that no file of the project holds.
 * It shows read-only in a tab of its own. The id carries the folder it was asked from and the
 * server's address for the source; nothing of it is saved. Plain Node: no imports.
 */
const PREFIX = 'decompiled\u0001'

/** The scheme of the editor models holding decompiled source. */
export const DECOMPILED_SCHEME = 'mango-decompiled'

/** Longer source than this is not shown (a server's answer is untrusted). */
export const MAX_DECOMPILED = 4 * 1024 * 1024
const MAX_NAME = 1000

export const decompiledTabId = (projectPath: string, uri: string) => `${PREFIX}${projectPath}\u0001${uri}`

export const isDecompiledTab = (id: string | null | undefined): id is string => !!id && id.startsWith(PREFIX)

export function parseDecompiledTab(id: string | null | undefined) {
  if (!isDecompiledTab(id)) return null
  const rest = id.slice(PREFIX.length)
  const cut = rest.indexOf('\u0001')
  if (cut < 0) return null
  const uri = rest.slice(cut + 1)
  return { projectPath: rest.slice(0, cut), uri, name: fileNameOf(uri) }
}

/**
 * csharp-ls's address for a library symbol's decompiled source, as its definitions give it
 * (`csharp:/<project file>/decompiled/<symbol>.cs`) once the client asked for them.
 */
export const isMetadataUri = (uri: string) => /^csharp:\//i.test(uri)

/** The last part of an address, decoded: `System.Console.cs`. */
export function fileNameOf(uri: string): string {
  const last = uri.slice(uri.lastIndexOf('/') + 1) || uri
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

/** A type's own name without its namespace: `System.Collections.Generic.List`1` is `List`1`. */
export const shortSymbol = (symbol: string) => symbol.slice(symbol.lastIndexOf('.') + 1) || symbol

export interface Decompiled {
  /** The assembly it came from: `UnityEngine.CoreModule`. */
  assembly: string
  /** The type, with its namespace: `UnityEngine.MonoBehaviour`. */
  symbol: string
  source: string
}

/** csharp-ls's answer to `csharp/metadata`, checked; null for anything else. */
export function toDecompiled(result: unknown): Decompiled | null {
  if (!result || typeof result !== 'object') return null
  const { assemblyName, symbolName, source } = result as Record<string, unknown>
  if (typeof source !== 'string' || !source || source.length > MAX_DECOMPILED) return null
  const name = (value: unknown) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME) : '')
  const symbol = name(symbolName)
  return { assembly: name(assemblyName), symbol, source }
}
