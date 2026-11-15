import type { Terminal } from '@xterm/xterm'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'

/**
 * Nerd Font families tried after the app font, before the generic fallback.
 * The bundled JetBrains Mono has no icon glyphs, so prompts (starship,
 * oh-my-posh) would otherwise show missing-glyph boxes for their icons.
 */
const NERD_FALLBACKS = [
  'JetBrainsMono Nerd Font',
  'JetBrainsMono NF',
  'Symbols Nerd Font Mono',
  'Symbols Nerd Font',
  'CaskaydiaCove Nerd Font',
  'CaskaydiaMono Nerd Font',
  'MesloLGS NF',
  'MesloLGM Nerd Font',
  'FiraCode Nerd Font',
  'Hack Nerd Font',
]

/** `--font-mono` with Nerd Font fallbacks slotted in before the generic families. */
export function terminalFontFamily(base: string): string {
  const parts = (base || 'monospace').split(',').map(s => s.trim()).filter(Boolean)
  const generic = parts.findIndex(p => /^(ui-monospace|monospace)$/i.test(p))
  const at = generic === -1 ? parts.length : generic
  const extra = NERD_FALLBACKS.map(f => `'${f}'`)
  return [...parts.slice(0, at), ...extra, ...parts.slice(at)].join(', ')
}

/**
 * Call after `term.open()`. Needs `allowProposedApi: true` (the unicode API is proposed).
 *
 * - Unicode 11 widths, so emoji and wide symbols take the two cells the shell expects.
 * - The WebGL renderer, which draws box-drawing, block and powerline glyphs
 *   itself: table borders join across rows despite the line height, and
 *   prompt caps render without a patched font. Falls back to the DOM renderer
 *   when WebGL is unavailable or its context is lost.
 */
export function enhanceTerminal(term: Terminal): void {
  try {
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
  } catch { /* keep the default widths */ }

  try {
    const webgl = new WebglAddon()
    webgl.onContextLoss(() => webgl.dispose())
    term.loadAddon(webgl)
  } catch { /* no WebGL: the DOM renderer stays */ }
}
