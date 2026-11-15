/**
 * Which Mango this is: the version from package.json, the git commit it was
 * built from, and when. Baked in at build time by nuxt.config.ts.
 */
export function useBuildInfo() {
  const b = useRuntimeConfig().public.build
  /** Running from source (`pnpm dev` / `pnpm app`) rather than a built release. */
  const dev = import.meta.dev
  /** One line for bug reports, e.g. "Mango 0.1.0, commit 09dd483, release build, Tauri 2.12.5". */
  const summary = (extra: string[] = []) =>
    [`Mango ${b.version}`, ...[b.commit && `commit ${b.commit}`, dev ? 'development build' : 'release build', ...extra].filter(Boolean)].join(', ')
  return { version: b.version, commit: b.commit, builtAt: b.builtAt, dev, summary }
}
