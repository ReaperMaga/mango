import type * as Monaco from 'monaco-editor'

/**
 * One Monaco text model per open file tab, kept while the tab is open so
 * switching tabs keeps edits, undo history and scroll position. Types only
 * here: Monaco itself is loaded by the editor pane.
 */
export interface EditorModel {
  model: Monaco.editor.ITextModel
  /** Alternative version id at the last load or save: dirty when the model's differs. */
  savedVersion: number
  /** The store's `version` the model was last filled from. */
  loadedVersion: number
  viewState: Monaco.editor.ICodeEditorViewState | null
}

const models = new Map<string, EditorModel>()
let onEdit: ((tabId: string) => void) | null = null

/**
 * Hear of every edit in any tab's model (shown in a pane or not), by the tab id it has then. A model
 * refilled from disk is no edit. One listener (`composables/useAutoSave.ts`).
 */
export function onEditorModelEdit(listener: (tabId: string) => void): () => void {
  onEdit = listener
  return () => { if (onEdit === listener) onEdit = null }
}

export const editorModel = (tabId: string) => models.get(tabId) ?? null

export function setEditorModel(tabId: string, entry: EditorModel) {
  models.set(tabId, entry)
  entry.model.onDidChangeContent((e) => {
    if (e.isFlush || !onEdit) return
    // Looked up each time: a rename gives the model another tab.
    for (const [id, held] of models) {
      if (held === entry) return onEdit(id)
    }
  })
}

/** The tab's file was renamed: its edits, undo history and scroll position go to the new tab id. */
export function moveEditorModel(from: string, to: string) {
  const entry = models.get(from)
  if (!entry) return
  models.delete(from)
  models.set(to, entry)
}

export function disposeEditorModel(tabId: string) {
  models.get(tabId)?.model.dispose()
  models.delete(tabId)
}
