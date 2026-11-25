/**
 * Field-level changes to a JSON document. A patch names only the fields it changes, so two writers that change
 * different fields of one document both win; it can be applied again on a newer copy, and inverted for undo.
 *
 * Everything that people edit one by one (properties, options, views, values, linked chats) is kept in objects
 * by id, never in arrays, so a path always means the same thing (`['views', viewId, 'name']`).
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }

/** Sets the field at `path`, or removes it when `value` is left out. */
export interface PatchOp { path: readonly string[]; value?: Json }
export type Patch = readonly PatchOp[]

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype'])

export function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Keys that could reach an object's prototype never come out of a document. */
export const isSafeKey = (key: string) => key !== '' && !UNSAFE.has(key)

/** Entries by id. Also reads a list of `{ id }` objects, should another writer have stored one. */
export function entriesById(v: unknown): Array<[string, JsonObject]> {
  if (Array.isArray(v)) {
    const out = new Map<string, JsonObject>()
    for (const e of v) if (isObject(e) && typeof e.id === 'string' && isSafeKey(e.id)) out.set(e.id, e)
    return [...out]
  }
  if (!isObject(v)) return []
  return Object.entries(v).filter((e): e is [string, JsonObject] => isSafeKey(e[0]) && isObject(e[1]))
}

function childObject(parent: JsonObject, key: string): JsonObject | null {
  const v = Object.hasOwn(parent, key) ? parent[key] : undefined
  if (isObject(v)) return { ...v }
  if (Array.isArray(v)) return Object.fromEntries(entriesById(v))
  return null
}

/**
 * The document with the patch applied (a copy; untouched parts are shared). A path into an entry that is gone
 * (`['views', 'deleted', 'name']`) does nothing: an edit never brings back half of what someone else deleted.
 */
export function applyPatch(doc: JsonObject, patch: Patch): JsonObject {
  const out = { ...doc }
  for (const op of patch) {
    if (!op.path.length || !op.path.every(isSafeKey)) continue
    let at = out
    let ok = true
    for (let i = 0; i < op.path.length - 1; i++) {
      const key = op.path[i]!
      const next = childObject(at, key)
      if (!next && (i === 1 || op.value === undefined)) {
        ok = false
        break
      }
      at = at[key] = next ?? {}
    }
    if (!ok) continue
    const last = op.path[op.path.length - 1]!
    if (op.value === undefined) delete at[last]
    else at[last] = op.value
  }
  return out
}

export function readPath(doc: JsonObject, path: readonly string[]): Json | undefined {
  let at: Json | undefined = doc
  for (const key of path) {
    const o: JsonObject | null = isObject(at) ? at : Array.isArray(at) ? Object.fromEntries(entriesById(at)) : null
    if (!o || !Object.hasOwn(o, key)) return undefined
    at = o[key]
  }
  return at
}

/** The patch that takes `applyPatch(doc, patch)` back to `doc`, touching only the same fields. */
export function invertPatch(doc: JsonObject, patch: Patch): PatchOp[] {
  const inverse: PatchOp[] = []
  let at = doc
  for (const op of patch) {
    const value = readPath(at, op.path)
    inverse.unshift(value === undefined ? { path: op.path } : { path: op.path, value })
    at = applyPatch(at, [op])
  }
  return inverse
}
