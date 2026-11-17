import { File, FileBraces, FileCode, FileImage, FileText, FileTerminal } from 'lucide-vue-next'
import type { Component } from 'vue'

/** A file's icon and its tint (a `--file-*` token), picked by extension so a language reads at a glance. */
export interface FileIcon { icon: Component; tint: string }

const TINTS: Record<string, string> = {
  ts: 'blue', tsx: 'blue', py: 'blue', go: 'blue', c: 'blue', h: 'blue', cpp: 'blue', hpp: 'blue', dart: 'blue', lua: 'blue',
  js: 'yellow', jsx: 'yellow', mjs: 'yellow', cjs: 'yellow', json: 'yellow', jsonc: 'yellow', json5: 'yellow',
  swift: 'orange', rs: 'orange', html: 'orange', xml: 'orange', toml: 'orange', java: 'orange', svelte: 'orange',
  vue: 'green', cs: 'green', sh: 'green', bash: 'green', zsh: 'green', ps1: 'green', yaml: 'green', yml: 'green',
  css: 'purple', scss: 'purple', less: 'purple', kt: 'purple', php: 'purple', md: 'purple', mdx: 'purple',
  rb: 'red', sql: 'red', lock: 'red',
}

const CODE = /^(ts|tsx|js|jsx|mjs|cjs|vue|svelte|rs|go|py|rb|java|kt|cs|c|h|cpp|hpp|swift|php|lua|sql|html|css|scss|less|dart)$/
const SHELL = /^(sh|bash|zsh|ps1|bat|cmd)$/
const DATA = /^(json|jsonc|json5|yaml|yml|toml|lock|xml)$/
const IMAGE = /^(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/
const TEXT = /^(md|mdx|txt|rst|log)$/

export function fileIcon(name: string): FileIcon {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  const tint = TINTS[ext] ? `var(--file-${TINTS[ext]})` : 'var(--fg-subtle)'
  if (CODE.test(ext)) return { icon: FileCode, tint }
  if (SHELL.test(ext)) return { icon: FileTerminal, tint }
  if (DATA.test(ext)) return { icon: FileBraces, tint }
  if (IMAGE.test(ext)) return { icon: FileImage, tint: 'var(--file-purple)' }
  if (TEXT.test(ext)) return { icon: FileText, tint }
  return { icon: File, tint }
}
