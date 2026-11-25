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
 * Paths alternate: containers (`views`, `options`) and the entries in them by id. A container that is not there
 * yet is made, an entry never is: that would bring back half of what someone else deleted.
 */
function setAt(doc: JsonObject, op: PatchOp, depth: number): JsonObject | null {
  const key = op.path[depth]!
  const out = { ...doc }
  if (depth === op.path.length - 1) {
    if (op.value === undefined) delete out[key]
    else out[key] = op.value
    return out
  }
  const isEntry = depth % 2 === 1
  const child = childObject(doc, key)
  if (!child && (isEntry || op.value === undefined)) return null
  const next = setAt(child ?? {}, op, depth + 1)
  if (!next) return null
  out[key] = next
  return out
}

/**
 * The document with the patch applied (a copy; untouched parts are shared). A path into an entry that is gone
 * (`['views', 'deleted', 'name']`) does nothing.
 */
export function applyPatch(doc: JsonObject, patch: Patch): JsonObject {
  let out = { ...doc }
  for (const op of patch) {
    if (op.path.length && op.path.every(isSafeKey)) out = setAt(out, op, 0) ?? out
  }
  return out
}

/** The same whatever order the keys of objects are in (a database may sort them). */
export function sameJson(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]))
  if (!isObject(a) || !isObject(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && sameJson(a[k], b[k]))
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
