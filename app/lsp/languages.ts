import type { LspServerId } from '../types/ipc.ts'

/** What each language server needs to hear from its client; its command line is the backend's. */

/** The LSP language id of a file: its extension where LSP tells apart what Monaco does not, else Monaco's. */
export function lspLanguage(file: string, monacoLanguage: string): string {
  const name = file.toLowerCase()
  if (monacoLanguage === 'typescript') return name.endsWith('.tsx') ? 'typescriptreact' : 'typescript'
  if (monacoLanguage === 'javascript') return name.endsWith('.jsx') ? 'javascriptreact' : 'javascript'
  return monacoLanguage
}

export interface ServerProfile {
  initializationOptions?: unknown
  /** Answers to `workspace/configuration`, by section. */
  settings?: Record<string, unknown>
  /**
   * It leaves watching the project to its client (`workspace/didChangeWatchedFiles`). The others
   * watch for themselves when a client does not offer to, and see more than Mango could.
   */
  clientWatches?: boolean
}

export const PROFILES: Record<LspServerId, ServerProfile> = {
  typescript: {
    initializationOptions: {
      hostInfo: 'mango',
      // It would send the project's package names to npm to fetch their types.
      disableAutomaticTypingAcquisition: true,
      preferences: {
        includeCompletionsForModuleExports: true,
        includeCompletionsForImportStatements: true,
        includeCompletionsWithInsertText: true,
        includeCompletionsWithSnippetText: true,
      },
    },
  },
  rust: {},
  python: { settings: { python: {}, 'python.analysis': { diagnosticMode: 'openFilesOnly' } } },
  go: { clientWatches: true },
  clangd: {},
  csharp: { clientWatches: true },
}

/** What Mango's editor can do, as `initialize` says it. */
export function clientCapabilities(profile: ServerProfile) {
  const markdown = ['markdown', 'plaintext']
  return {
    general: { positionEncodings: ['utf-16'] },
    window: { workDoneProgress: true, showMessage: {}, showDocument: { support: false } },
    workspace: {
      applyEdit: false,
      configuration: true,
      workspaceFolders: true,
      ...(profile.clientWatches ? { didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true } } : {}),
    },
    textDocument: {
      synchronization: { dynamicRegistration: false, didSave: true },
      completion: {
        contextSupport: true,
        insertTextMode: 2,
        completionItem: {
          snippetSupport: true,
          insertReplaceSupport: true,
          labelDetailsSupport: true,
          deprecatedSupport: true,
          preselectSupport: true,
          commitCharactersSupport: false,
          documentationFormat: markdown,
          tagSupport: { valueSet: [1] },
          insertTextModeSupport: { valueSet: [1, 2] },
          resolveSupport: { properties: ['detail', 'documentation', 'additionalTextEdits'] },
        },
        completionItemKind: { valueSet: Array.from({ length: 25 }, (_, i) => i + 1) },
        completionList: { itemDefaults: ['editRange', 'insertTextFormat', 'insertTextMode', 'data'] },
      },
      hover: { contentFormat: markdown },
      signatureHelp: {
        contextSupport: true,
        signatureInformation: { documentationFormat: markdown, activeParameterSupport: true, parameterInformation: { labelOffsetSupport: true } },
      },
      definition: { linkSupport: true },
      publishDiagnostics: { versionSupport: true, tagSupport: { valueSet: [1, 2] } },
    },
  }
}
