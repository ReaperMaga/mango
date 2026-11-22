import type * as Monaco from 'monaco-editor'
import { reactive, shallowReactive } from 'vue'
import type { Session } from '~/lsp/session'
import type { CancelToken } from '~/lsp/rpc'
import { useThreads } from '~/stores/threads'
import { DECOMPILED_SCHEME, decompiledTabId, fileNameOf, toDecompiled } from '~/utils/decompiledTabs'
import type { MonacoApi } from '~/composables/monaco'

/**
 * Library source a language server decompiled for go to definition (`utils/decompiledTabs.ts`): one
 * read-only model per symbol and folder, shown in a peek or in a tab of its own. Asked of the server,
 * never read from disk, and kept only while this window runs.
 */

export interface DecompiledSource {
  tabId: string
  /** The folder it was asked from: only that folder's files lead to it. */
  project: string
  assembly: string
  symbol: string
  model: Monaco.editor.ITextModel
}

/** Sources not open in a tab are kept up to this many (a peek may show them again). */
const KEEP = 12
const TIMEOUT = 20_000

const byTab = shallowReactive(new Map<string, DecompiledSource>())
const byModel = new Map<string, DecompiledSource>()
/** Where a tab was asked to show, until it did. */
export const decompiledReveals = reactive<Record<string, { lineNumber: number; column: number }>>({})
let made = 0

export const decompiledSource = (tabId: string) => {
  const source = byTab.get(tabId)
  return source && !source.model.isDisposed() ? source : null
}

/** The source behind a model's URI, if it is one of these. */
export function decompiledOfUri(uri: { scheme: string; toString(): string }) {
  if (uri.scheme !== DECOMPILED_SCHEME) return null
  const source = byModel.get(uri.toString())
  return source && !source.model.isDisposed() ? source : null
}

/** The source whose model lives in this folder of the scheme (a peek's header names the folder too). */
export function decompiledInFolder(uri: { scheme: string; path: string }) {
  if (uri.scheme !== DECOMPILED_SCHEME) return null
  for (const source of byModel.values()) {
    if (!source.model.isDisposed() && source.model.uri.path.startsWith(`${uri.path.replace(/\/+$/, '')}/`)) return source
  }
  return null
}

/** The decompiled source behind a definition's address, asked of its server once. */
export async function decompile(monaco: MonacoApi, session: Session, project: string, uri: string, token?: CancelToken): Promise<DecompiledSource | null> {
  const tabId = decompiledTabId(project, uri)
  const had = decompiledSource(tabId)
  if (had) {
    // Most recently used last.
    byTab.delete(tabId)
    byTab.set(tabId, had)
    return had
  }
  const result = toDecompiled(await session.send('csharp/metadata', { textDocument: { uri } }, { token, timeout: TIMEOUT }))
  if (!result) return null
  // Another jump asked the same meanwhile.
  const raced = decompiledSource(tabId)
  if (raced) return raced
  const name = fileNameOf(uri)
  const model = monaco.editor.createModel(result.source, 'csharp',
    monaco.Uri.from({ scheme: DECOMPILED_SCHEME, path: `/${++made}/${name}` }))
  const source: DecompiledSource = { tabId, project, assembly: result.assembly, symbol: result.symbol || name.replace(/\.cs$/i, ''), model }
  byTab.set(tabId, source)
  byModel.set(model.uri.toString(), source)
  prune()
  return source
}

/** Let go of the oldest sources no tab or editor shows. */
function prune() {
  const open = new Set(useThreads().tabs)
  let spare = [...byTab.values()].filter(s => !open.has(s.tabId)).length
  for (const source of [...byTab.values()]) {
    if (spare <= KEEP) break
    if (open.has(source.tabId) || source.model.isAttachedToEditor()) continue
    forget(source)
    spare--
  }
}

function forget(source: DecompiledSource) {
  byTab.delete(source.tabId)
  byModel.delete(source.model.uri.toString())
  delete decompiledReveals[source.tabId]
  source.model.dispose()
}

/** Show a source in its tab, at a position. */
export function openDecompiled(source: DecompiledSource, at: { lineNumber: number; column: number }) {
  decompiledReveals[source.tabId] = at
  useThreads().show(source.tabId)
}

