/** How a person looks and reads: the same colour on every computer, from their id, and their name as it is now. */

import { NAMED_COLORS, personName, UNKNOWN_PERSON, type NamedColor, type People, type Property } from '../model.ts'

const HUES = NAMED_COLORS.filter(c => c !== 'neutral')

/** One of the named colours, the same for an id everywhere (FNV-1a of its code points): a rename keeps it. */
export function personColor(id: string): NamedColor {
  let h = 0x811c9dc5
  for (const ch of id) {
    h ^= ch.codePointAt(0)!
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return HUES[h % HUES.length]!
}

/** The first letter (or other character) of the name, as a capital. */
export function personInitial(name: string): string {
  const first = [...name.trim()].find(ch => /[\p{L}\p{N}]/u.test(ch)) ?? [...name.trim()][0] ?? '?'
  return first.toLocaleUpperCase()
}

/** A person as shown. */
export interface PersonView {
  readonly id: string
  readonly name: string
  /** Not one to assign any more: their tokens were revoked, or the server does not know them. */
  readonly former: boolean
  /** Nobody here knows their name. */
  readonly unknown: boolean
  readonly you: boolean
}

/** A person of a property, by id: the server's name for them, else the one the property wrote down. */
export function personView(id: string, property: Pick<Property, 'people'>, people: People | null): PersonView {
  const live = people?.all.find(p => p.id === id)
  const name = personName(id, property, people)
  return {
    id,
    name: name ?? UNKNOWN_PERSON,
    former: !!people && !live?.active,
    unknown: name === null,
    you: !!people?.me && people.me === id,
  }
}

/** The ids to choose from: whoever is looking first, then the others who may be assigned, then any others given. */
export function peopleRows(people: People | null, also: readonly string[] = []): string[] {
  const active = (people?.all ?? []).filter(p => p.active).map(p => p.id)
  const me = people?.me && active.includes(people.me) ? [people.me] : []
  return [...new Set([...me, ...active, ...also])]
}
