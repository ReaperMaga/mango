// @ts-expect-error Monaco ships this module without types
import { initialize } from 'monaco-editor/internal/common/initialize'
// @ts-expect-error Monaco ships this module without types
import { TypeScriptWorker } from 'monaco-editor/languages/features/typescript/tsWorker'
// @ts-expect-error Monaco ships this module without types
import { typescript } from 'monaco-editor/languages/features/typescript/lib/typescriptServices'
import { oneFileWorker } from './builtins.ts'

/** The TypeScript worker Mango starts in place of Monaco's (`composables/monaco.ts`): see `oneFileWorker`. */
const OneFileWorker = oneFileWorker(TypeScriptWorker, typescript)

self.onmessage = () => {
  initialize((ctx: unknown, data: unknown) => new OneFileWorker(ctx, data))
}
