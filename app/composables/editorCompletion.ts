import type * as Monaco from 'monaco-editor'
import type { FsEntry } from '~/types/ipc'
import { call } from '~/composables/useBackend'
import { parseFileTab } from '~/utils/fileTabs'
import { parentOf, pathIn } from '~/utils/fileOps'
import { fileOfUri, tabOfModel } from '~/composables/editorDocuments'
import type { MonacoApi } from '~/composables/monaco'

/**
 * Completion that needs no language server, so it works in every project, remote ones too: the
 * keywords of the languages Monaco only has a grammar for, beside its words from open files, those
 * words for scripts, and relative paths inside quotes. Where a server completes, all stand back.
 */

/** Monaco's workers complete these. */
const WITH_WORKER = new Set(['typescript', 'javascript', 'json', 'css', 'scss', 'less', 'html', 'plaintext'])
const KEYWORD_LISTS = ['keywords', 'typeKeywords', 'phpKeywords', 'builtins', 'builtinFunctions', 'phpConstants', 'constants']
/** Scripts offer each other's words: their worker sees one file (`withWords`). */
const SCRIPTS = new Set(['typescript', 'javascript'])
/** Up to this size a document is looked through for its words. */
const WORDS_IN_MAX = 200_000
const WORD = /(?<![\p{ID_Continue}$])[\p{ID_Start}_$][\p{ID_Continue}$]+/gu

const keywordLists = new Map<string, Promise<string[]>>()

function keywordsOf(monaco: MonacoApi, id: string): Promise<string[]> {
  let list = keywordLists.get(id)
  if (!list) {
    list = (async () => {
      // Monaco registers each bundled language with the loader of its grammar.
      const def = monaco.languages.getLanguages().find(l => l.id === id && 'loader' in l) as
        { loader?: () => Promise<{ language?: Record<string, unknown> }> } | undefined
      const grammar = (await def?.loader?.().catch(() => null))?.language
      if (!grammar) return []
      const words = KEYWORD_LISTS.flatMap(key => (Array.isArray(grammar[key]) ? grammar[key] as unknown[] : []))
      return [...new Set(words.filter((w): w is string => typeof w === 'string' && /^[A-Za-z_]\w+$/.test(w)))]
    })()
    keywordLists.set(id, list)
  }
  return list
}

const wordsIn = new WeakMap<Monaco.editor.ITextModel, { version: number; words: Set<string> }>()
const NO_WORDS = new Set<string>()

function documentWords(model: Monaco.editor.ITextModel): Set<string> {
  if (model.getValueLength() > WORDS_IN_MAX) return NO_WORDS
  const version = model.getVersionId()
  let known = wordsIn.get(model)
  if (known?.version !== version) {
    known = { version, words: new Set(model.getValue().match(WORD)) }
    wordsIn.set(model, known)
  }
  return known.words
}

/** The words of the project's other open scripts, for a script. */
export function* otherFilesWords(monaco: MonacoApi, model: Monaco.editor.ITextModel): Generator<string> {
  const project = SCRIPTS.has(model.getLanguageId()) ? fileOfUri(model.uri)?.project : undefined
  if (project === undefined) return
  for (const other of monaco.editor.getModels()) {
    // A peek's preview is not open.
    if (other === model || other.uri.scheme !== 'file' || !SCRIPTS.has(other.getLanguageId())) continue
    if (fileOfUri(other.uri)?.project === project) yield* documentWords(other)
  }
}

/** A relative path being typed after a quote or bracket: its folder part, then the name so far. */
const PATH = /["'`(]((?:\.\.?\/)(?:[^"'`()\s/]+\/)*)([^"'`()\s/]*)$/
/** Imports leave these endings out. */
const IMPORTED = /(\.d)?\.(tsx?|jsx?)$/
const LISTING_MS = 10_000
const listings = new Map<string, { at: number; entries: Promise<FsEntry[] | null> }>()

function listFolder(root: string, dir: string) {
  const key = `${root}\0${dir}`
  const now = Date.now()
  const known = listings.get(key)
  if (known && now - known.at < LISTING_MS) return known.entries
  for (const [k, v] of listings) if (now - v.at >= LISTING_MS) listings.delete(k)
  // Kept for a moment: in a remote project each is a round trip.
  const entries = call('fs_list_dir', { root, dir }).then(got => got.entries, () => null)
  listings.set(key, { at: now, entries })
  return entries
}

/** `relative` (ending in a slash) from `dir`; null above the project. */
function resolveFolder(dir: string, relative: string): string | null {
  const parts = dir ? dir.split('/') : []
  for (const part of relative.split('/')) {
    if (part === '' || part === '.') continue
    if (part !== '..') parts.push(part)
    else if (!parts.length) return null
    else parts.pop()
  }
  return parts.join('/')
}

export function registerBasicCompletion(monaco: MonacoApi, servedByServer: (model: Monaco.editor.ITextModel) => boolean) {
  const Kind = monaco.languages.CompletionItemKind

  // '*' ranks with Monaco's words, below anything that knows the language.
  monaco.languages.registerCompletionItemProvider('*', {
    async provideCompletionItems(model, position, context) {
      const language = model.getLanguageId()
      if (WITH_WORKER.has(language) || servedByServer(model) || context.triggerCharacter) return null
      const word = model.getWordUntilPosition(position)
      // Nothing after a dot is a keyword.
      if (model.getLineContent(position.lineNumber)[word.startColumn - 2] === '.') return null
      const keywords = await keywordsOf(monaco, language)
      if (!keywords.length || model.isDisposed()) return null
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, position.column)
      const present = documentWords(model)
      return {
        suggestions: keywords
          .filter(k => k === word.word || !present.has(k))
          .map(k => ({ label: k, kind: Kind.Keyword, insertText: k, range })),
      }
    },
  })

  monaco.languages.registerCompletionItemProvider({ scheme: 'file' }, {
    triggerCharacters: ['/'],
    async provideCompletionItems(model, position, _context, token) {
      if (servedByServer(model)) return null
      const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1)
      const m = PATH.exec(before)
      const tab = m ? parseFileTab(tabOfModel(model)) : null
      if (!m || !tab) return null
      const dir = resolveFolder(parentOf(tab.file), m[1]!)
      if (dir === null) return null
      const entries = await listFolder(tab.projectPath, dir)
      if (!entries || token.isCancellationRequested || model.isDisposed()) return null
      const language = model.getLanguageId()
      const bare = (language === 'typescript' || language === 'javascript') && /\b(import|from|require)\b/.test(before)
      const range = new monaco.Range(position.lineNumber, position.column - m[2]!.length, position.lineNumber, position.column)
      return {
        suggestions: entries.filter(e => pathIn(dir, e.name) !== tab.file).map((e) => {
          const name = !e.isDir && bare ? e.name.replace(IMPORTED, '') : e.name
          return {
            label: e.isDir ? `${e.name}/` : name,
            kind: e.isDir ? Kind.Folder : Kind.File,
            insertText: e.isDir ? `${e.name}/` : name,
            sortText: `${e.isDir ? 0 : 1}${e.name}`,
            range,
            command: e.isDir ? { id: 'editor.action.triggerSuggest', title: '' } : undefined,
          }
        }),
      }
    },
  })
}
