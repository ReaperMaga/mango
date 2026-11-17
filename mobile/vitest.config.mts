import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Tests run in plain Node. The aliases match tsconfig `paths` and metro.config.js:
 * `~/…` is the desktop's shared code (`../app`), `@/…` this app's `src`.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^~\//, replacement: fileURLToPath(new URL('../app/', import.meta.url)) },
      { find: /^@\//, replacement: fileURLToPath(new URL('./src/', import.meta.url)) },
    ],
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
