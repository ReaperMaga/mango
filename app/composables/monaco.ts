import type * as Monaco from 'monaco-editor'
import { tokenHex } from '~/utils/cssColor'
import { pluginLanguage } from '~/plugin-host/fileHooks'

/**
 * Monaco, loaded the first time a file is opened (it is a few megabytes and
 * most sessions never open one). Its theme is built from Mango's tokens, so
 * it follows the light and dark themes and the colour schemes, and syntax
 * colours come from the terminal palette so code reads the same in both.
 */

export type MonacoApi = typeof Monaco

let loading: Promise<MonacoApi> | null = null

export function loadMonaco(): Promise<MonacoApi> {
  return (loading ??= (async () => {
    ;(self as any).MonacoEnvironment = {
      async getWorker(_: string, label: string) {
        switch (label) {
          case 'json': return new (await import('monaco-editor/language/json/json.worker?worker')).default()
          case 'css': case 'scss': case 'less': return new (await import('monaco-editor/language/css/css.worker?worker')).default()
          case 'html': case 'handlebars': case 'razor': return new (await import('monaco-editor/language/html/html.worker?worker')).default()
          case 'typescript': case 'javascript': return new (await import('monaco-editor/language/typescript/ts.worker?worker')).default()
          default: return new (await import('monaco-editor/editor/editor.worker?worker')).default()
        }
      },
    }
    const monaco = await import('monaco-editor')
    // There is no project context (tsconfig, node_modules) in the editor, so
    // semantic errors would flag every import. Keep syntax errors only.
    for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
      defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })
    }
    applyTheme(monaco)
    new MutationObserver(() => applyTheme(monaco))
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-scheme'] })
    return monaco
  })())
}

const THEME = 'mango'

function applyTheme(monaco: MonacoApi) {
  const dark = document.documentElement.dataset.theme !== 'light'
  const c = tokenHex
  const bare = (hex: string) => hex.slice(1, 7)

  const fg = c('--fg', dark ? '#e8ece9' : '#1f2522')
  const faint = c('--fg-faint', dark ? '#8a958f' : '#6d7672')
  const keyword = c('--term-magenta', dark ? '#d39af0' : '#8e3fb0')
  const string = c('--term-green', dark ? '#8fcf9a' : '#2e8a4a')
  const number = c('--term-yellow', dark ? '#f4c062' : '#a86a00')
  const type = c('--term-cyan', dark ? '#78d0c8' : '#11807a')
  const fn = c('--term-blue', dark ? '#7fb2f0' : '#2a64b8')
  const tag = c('--term-red', dark ? '#f0766b' : '#c4362c')

  monaco.editor.defineTheme(THEME, {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: bare(fg) },
      { token: 'comment', foreground: bare(faint), fontStyle: 'italic' },
      { token: 'keyword', foreground: bare(keyword) },
      { token: 'storage', foreground: bare(keyword) },
      { token: 'string', foreground: bare(string) },
      { token: 'string.escape', foreground: bare(number) },
      { token: 'regexp', foreground: bare(number) },
      { token: 'number', foreground: bare(number) },
      { token: 'constant', foreground: bare(number) },
      { token: 'type', foreground: bare(type) },
      { token: 'type.identifier', foreground: bare(type) },
      { token: 'identifier.function', foreground: bare(fn) },
      { token: 'tag', foreground: bare(tag) },
      { token: 'metatag', foreground: bare(tag) },
      { token: 'attribute.name', foreground: bare(number) },
      { token: 'attribute.value', foreground: bare(string) },
      { token: 'key', foreground: bare(fn) },
      { token: 'string.key.json', foreground: bare(fn) },
      { token: 'string.value.json', foreground: bare(string) },
      { token: 'delimiter', foreground: bare(c('--fg-subtle', faint)) },
      { token: 'variable', foreground: bare(fg) },
      { token: 'markup.heading', foreground: bare(fn), fontStyle: 'bold' },
    ],
    colors: {
      'editor.background': c('--bg-canvas', dark ? '#141917' : '#fbfcfb'),
      'editor.foreground': fg,
      'editorGutter.background': c('--bg-canvas', dark ? '#141917' : '#fbfcfb'),
      'editorLineNumber.foreground': faint,
      'editorLineNumber.activeForeground': c('--fg-muted', fg),
      'editor.lineHighlightBackground': c('--bg-hover', '#ffffff0d'),
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': c('--accent', '#f5a524'),
      'editor.selectionBackground': c('--selection', '#f4c06247'),
      'editor.inactiveSelectionBackground': c('--bg-active', '#ffffff1a'),
      'editor.selectionHighlightBackground': c('--accent-soft', '#f5a52424'),
      'editor.wordHighlightBackground': c('--bg-active', '#ffffff1a'),
      'editor.findMatchBackground': c('--accent-line', '#f5a52473'),
      'editor.findMatchHighlightBackground': c('--accent-soft', '#f5a52424'),
      'editorIndentGuide.background1': c('--line-soft', '#ffffff14'),
      'editorIndentGuide.activeBackground1': c('--line-strong', '#ffffff33'),
      'editorWhitespace.foreground': c('--line-strong', '#ffffff33'),
      'editorBracketMatch.background': c('--bg-active', '#ffffff1a'),
      'editorBracketMatch.border': c('--line-strong', '#ffffff33'),
      'editorWidget.background': c('--bg-raised', dark ? '#222a26' : '#ffffff'),
      'editorWidget.border': c('--line', '#ffffff22'),
      'editorSuggestWidget.background': c('--bg-raised', dark ? '#222a26' : '#ffffff'),
      'editorSuggestWidget.border': c('--line', '#ffffff22'),
      'editorSuggestWidget.selectedBackground': c('--bg-active', '#ffffff1a'),
      'editorHoverWidget.background': c('--bg-raised', dark ? '#222a26' : '#ffffff'),
      'editorHoverWidget.border': c('--line', '#ffffff22'),
      'input.background': c('--bg-inset', dark ? '#0f1311' : '#f6f8f7'),
      'input.border': c('--line', '#ffffff22'),
      'focusBorder': c('--accent-line', '#f5a52473'),
      'scrollbarSlider.background': c('--line', '#ffffff22'),
      'scrollbarSlider.hoverBackground': c('--line-strong', '#ffffff33'),
      'scrollbarSlider.activeBackground': c('--fg-faint', '#ffffff44'),
      'scrollbar.shadow': '#00000000',
      'editorOverviewRuler.border': '#00000000',
      'editorError.foreground': c('--ripe-error-fg', '#f0766b'),
      'editorWarning.foreground': c('--ripe-running-fg', '#f4c062'),
    },
  })
  monaco.editor.setTheme(THEME)
}

export const MONACO_THEME = THEME

/** Monaco's language id for a file name; plaintext when it has none. */
export function languageFor(monaco: MonacoApi, file: string): string {
  const name = file.slice(file.lastIndexOf('/') + 1).toLowerCase()
  if (name.endsWith('.vue') || name.endsWith('.svelte')) return 'html'
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile'
  if (name.endsWith('.jsonc') || name === 'tsconfig.json' || name.endsWith('.json5')) return 'json'
  if (name.endsWith('.toml') || name.endsWith('.lock') && name.startsWith('cargo')) return 'ini'
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : ''
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some(f => f.toLowerCase() === name)) return lang.id
    if (ext && lang.extensions?.some(e => e.toLowerCase() === ext)) return lang.id
  }
  const added = pluginLanguage(file)
  if (added && monaco.languages.getLanguages().some(l => l.id === added)) return added
  return 'plaintext'
}
