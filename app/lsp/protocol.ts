/**
 * The part of the Language Server Protocol Mango speaks (3.17), as types. Servers are untrusted:
 * what arrives is checked where it is used (`convert.ts`), whatever these say.
 */

export interface Position { line: number; character: number }
export interface Range { start: Position; end: Position }
export interface TextEdit { range: Range; newText: string }
export interface InsertReplaceEdit { insert: Range; replace: Range; newText: string }
export interface ContentChange { range?: Range; text: string }

export interface MarkupContent { kind: 'plaintext' | 'markdown'; value: string }
export type MarkedString = string | { language: string; value: string }

export interface Command { title?: string; command: string }

export interface CompletionItem {
  label: string
  labelDetails?: { detail?: string; description?: string }
  kind?: number
  tags?: number[]
  deprecated?: boolean
  detail?: string
  documentation?: string | MarkupContent
  preselect?: boolean
  sortText?: string
  filterText?: string
  insertText?: string
  insertTextFormat?: number
  insertTextMode?: number
  textEdit?: TextEdit | InsertReplaceEdit
  textEditText?: string
  additionalTextEdits?: TextEdit[]
  command?: Command
  data?: unknown
}

export interface CompletionList {
  isIncomplete?: boolean
  itemDefaults?: {
    editRange?: Range | { insert: Range; replace: Range }
    insertTextFormat?: number
    insertTextMode?: number
    data?: unknown
  }
  items: CompletionItem[]
}

export interface Hover { contents: MarkupContent | MarkedString | MarkedString[]; range?: Range }

export interface SignatureHelp {
  signatures: Array<{
    label: string
    documentation?: string | MarkupContent
    parameters?: Array<{ label: string | [number, number]; documentation?: string | MarkupContent }>
    activeParameter?: number | null
  }>
  activeSignature?: number
  activeParameter?: number | null
}

export interface Location { uri: string; range: Range }
export interface LocationLink { originSelectionRange?: Range; targetUri: string; targetRange: Range; targetSelectionRange: Range }

export interface Diagnostic {
  range: Range
  severity?: number
  code?: number | string
  source?: string
  message: string | MarkupContent
  tags?: number[]
}

export interface ServerCapabilities {
  positionEncoding?: string
  textDocumentSync?: number | { openClose?: boolean; change?: number; save?: boolean | { includeText?: boolean } }
  completionProvider?: { triggerCharacters?: string[]; resolveProvider?: boolean }
  signatureHelpProvider?: { triggerCharacters?: string[]; retriggerCharacters?: string[] }
  hoverProvider?: boolean | object
  definitionProvider?: boolean | object
  semanticTokensProvider?: { legend?: SemanticTokensLegend; full?: boolean | object; range?: boolean | object }
}

export interface SemanticTokensLegend { tokenTypes: string[]; tokenModifiers: string[] }
/** Five numbers a token, each place counted from the token before (`relative`). */
export interface SemanticTokens { resultId?: string; data: number[] }

export interface InitializeResult { capabilities: ServerCapabilities }
