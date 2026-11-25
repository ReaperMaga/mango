/**
 * Builds the official plugins that have a source folder (`plugins/<id>/src/main.ts`) into the files that are
 * committed and installed: `main.js` and `styles.css`.
 *
 *   node scripts/build-plugin.ts [id...] [--watch]
 *
 * A plugin's module cannot import anything, so everything is bundled but Vue, which is Mango's own
 * (`mango.vue`) and only there once the plugin is activated: the bundle runs inside `activate`. `main.ts`
 * exports `activate(mango)` and may export `deactivate()`.
 *
 * The output depends on the source alone (line endings do not matter, nor where the repository is). Its first
 * line carries a hash of the source, which `tests/plannerBuild.test.ts` compares.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGINS = fileURLToPath(new URL('../plugins/', import.meta.url))
const BANNER = 'Built from src/ by `pnpm plugins:build`. Do not edit.'
const toLf = (text: string) => text.replaceAll('\r\n', '\n')

/** Plugins that are built from source. */
export function builtPlugins(): string[] {
  return readdirSync(PLUGINS, { withFileTypes: true })
    .filter(e => e.isDirectory() && existsSync(join(PLUGINS, e.name, 'src', 'main.ts')))
    .map(e => e.name)
    .sort()
}

/** Of every file in `src/`, by name, with line endings as LF. */
export function sourceHash(id: string): string {
  const src = join(PLUGINS, id, 'src')
  const files = readdirSync(src, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => join(e.parentPath, e.name).slice(src.length + 1).replaceAll('\\', '/'))
    .sort()
  const hash = createHash('sha256')
  for (const f of files) hash.update(`${f}\n`).update(toLf(readFileSync(join(src, f), 'utf8'))).update('\0')
  return hash.digest('hex').slice(0, 32)
}

/** The hash a built file carries, or null. */
export function builtHash(id: string, file: 'main.js' | 'styles.css'): string | null {
  const first = readFileSync(join(PLUGINS, id, file), 'utf8').split(/\r?\n/, 1)[0]!
  return first.startsWith(`/* ${BANNER} `) ? /([0-9a-f]{32}) \*\/$/.exec(first)?.[1] ?? null : null
}

export async function buildPlugin(id: string): Promise<{ 'main.js': string; 'styles.css': string }> {
  // Only here: the test reads the hashes without loading Vite.
  const [{ build }, { default: vue }] = await Promise.all([import('vite'), import('@vitejs/plugin-vue')])
  const hash = sourceHash(id)
  const result = await build({
    configFile: false,
    root: join(PLUGINS, id),
    logLevel: 'warn',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [
      {
        name: 'lf',
        enforce: 'pre',
        transform: code => (code.includes('\r\n') ? { code: toLf(code), map: null } : null),
      },
      vue({ isProduction: true, features: { componentIdGenerator: 'filepath' } }),
    ],
    build: {
      write: false,
      minify: false,
      cssMinify: false,
      target: 'es2023',
      lib: { entry: join(PLUGINS, id, 'src', 'main.ts'), formats: ['iife'], name: '__plugin', cssFileName: 'styles' },
      rolldownOptions: { external: ['vue'], output: { globals: { vue: '__vue' }, sourcemap: false } },
    },
  })
  const output = (Array.isArray(result) ? result : [result]).flatMap(r => ('output' in r ? r.output : []))
  const chunk = output.find(o => o.type === 'chunk')
  if (chunk?.type !== 'chunk') throw new Error(`${id}: nothing was built`)
  const css = output.map(o => (o.type === 'asset' && o.fileName.endsWith('.css') ? String(o.source) : '')).join('').replace(/\/\*\$vite\$:\d+\*\//g, '')

  const banner = `/* ${BANNER} ${hash} */\n`
  const js = `${banner}
let active = null

/** The bundle, with Vue from Mango. */
function load(__vue) {
${toLf(chunk.code).trim()}
return __plugin
}

export function activate(mango) {
  active = load(mango.vue)
  return active.activate(mango)
}

export function deactivate() {
  return active?.deactivate?.()
}
`
  return { 'main.js': js, 'styles.css': `${banner}${toLf(css).trim()}\n` }
}

async function run(ids: string[]) {
  for (const id of ids) {
    const files = await buildPlugin(id)
    for (const [name, text] of Object.entries(files)) {
      const path = join(PLUGINS, id, name)
      if (!existsSync(path) || readFileSync(path, 'utf8') !== text) writeFileSync(path, text)
    }
    console.log(`plugins/${id}: main.js ${(files['main.js'].length / 1024).toFixed(0)} KB, styles.css ${(files['styles.css'].length / 1024).toFixed(0)} KB`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const named = args.filter(a => !a.startsWith('--'))
  const ids = named.length ? named : builtPlugins()
  const watching = args.includes('--watch')
  const report = (e: unknown) => console.error(e instanceof Error ? e.message : e)
  if (watching) await run(ids).catch(report)
  else await run(ids)
  if (watching) {
    for (const id of ids) {
      let timer: NodeJS.Timeout | undefined
      let job = Promise.resolve()
      watch(join(PLUGINS, id, 'src'), { recursive: true }, () => {
        clearTimeout(timer)
        timer = setTimeout(() => { job = job.then(() => run([id])).catch(report) }, 150)
      })
    }
    console.log('Watching for changes.')
  }
}
