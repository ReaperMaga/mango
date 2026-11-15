import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/**
 * What this build is, baked in at build time. package.json holds the version
 * (tauri.conf.json reads it from there too; `pnpm bump` changes it).
 */
function buildInfo() {
  const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string
  let commit = ''
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().trim()
  } catch { /* not a git checkout: no commit to show */ }
  return { version, commit, builtAt: new Date().toISOString() }
}

// Mango runs as a Tauri webview: SPA only, static output in .output/public.
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  ssr: false,
  devtools: { enabled: false },
  modules: ['@pinia/nuxt'],
  css: [
    '@fontsource-variable/inter',
    '@fontsource-variable/jetbrains-mono',
    '@xterm/xterm/css/xterm.css',
    '~/assets/css/tokens.css',
    '~/assets/css/base.css',
  ],
  app: {
    head: {
      title: 'Mango',
      meta: [{ name: 'color-scheme', content: 'dark light' }],
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/icon.svg' }],
    },
  },
  runtimeConfig: { public: { build: buildInfo() } },
  devServer: { host: '127.0.0.1', port: 1420 },
  vite: {
    clearScreen: false,
    envPrefix: ['VITE_', 'TAURI_'],
    server: { strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
    optimizeDeps: {
      include: [
        '@tauri-apps/api/core',
        '@tauri-apps/api/event',
        '@tauri-apps/api/window',
        '@tauri-apps/plugin-dialog',
        '@tauri-apps/plugin-shell',
        '@xterm/addon-fit',
        '@xterm/addon-web-links',
        '@xterm/xterm',
        'lucide-vue-next',
        'marked',
      ],
    },
  },
  ignore: ['src-tauri/**', 'docs/**'],
})
