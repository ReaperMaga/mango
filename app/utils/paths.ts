/** Last segment of a path, for both / and \\ separators. */
export const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

/** The separator a path uses: backslash for Windows paths, slash otherwise. */
export const sepOf = (p: string) => (p.includes('\\') && !p.includes('/') ? '\\' : '/')

/** `base` with exactly one trailing separator. */
export const withTrailingSep = (base: string) => (/[\\/]$/.test(base) ? base : base + sepOf(base))
