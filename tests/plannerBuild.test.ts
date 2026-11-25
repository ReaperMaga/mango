/**
 * The built plugins (plugins/<id>/src -> main.js, styles.css) match their source.
 *
 *   node --test tests/plannerBuild.test.ts     (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { builtHash, builtPlugins, sourceHash } from '../scripts/build-plugin.ts'

test('the built files are of the source as it is', () => {
  assert.ok(builtPlugins().includes('planner'))
  for (const id of builtPlugins()) {
    for (const file of ['main.js', 'styles.css'] as const) {
      assert.equal(builtHash(id, file), sourceHash(id), `plugins/${id}/${file} is not built from its source: run pnpm plugins:build`)
    }
  }
})
