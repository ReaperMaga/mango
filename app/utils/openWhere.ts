/**
 * Where a project the user opens goes: this window (beside the projects it holds) or a new one.
 * Pure, so `tests/openWhere.test.ts` runs it in plain Node.
 */

/** Settings > Preferences: ask each time, or always this window / a new window. */
export type OpenProjectIn = 'ask' | 'this' | 'new'
export const OPEN_PROJECT_IN: readonly OpenProjectIn[] = ['ask', 'this', 'new']

/** A stored value from any build: anything unknown asks. */
export const openProjectInOf = (v: unknown): OpenProjectIn =>
  (OPEN_PROJECT_IN as readonly unknown[]).includes(v) ? (v as OpenProjectIn) : 'ask'

/**
 * What to do with `path`: open it here, in a new window, or ask. Only a window that already holds
 * other projects has a choice to make; a chat window, a project already open here and one open in
 * another window (which comes to the front instead) open here without a question.
 */
export function whereToOpen(o: {
  pref: OpenProjectIn
  windowKind: 'main' | 'project' | 'chat'
  openHere: readonly string[]
  path: string
  elsewhere: boolean
}): OpenProjectIn {
  if (o.windowKind === 'chat' || o.elsewhere) return 'this'
  if (!o.openHere.length || o.openHere.includes(o.path)) return 'this'
  return o.pref
}
