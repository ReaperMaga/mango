/** Filters and sorts in words, and changing them. */

import {
  conditionValueKind, ME, newId, operatorsFor, personName, propertyOf, TITLE, UNKNOWN_PERSON, type Collection, type People, type Condition, type Filter,
  type Operator, type Sort, type View,
} from '../model.ts'
import type { PlannerStore } from '../store.ts'
import { strings } from '../strings.ts'
import { dateText } from '../values/dates.ts'
import type { PickRow } from './PickList.vue'
import { shell } from './strings.ts'

export const propertyName = (c: Collection, id: string): string =>
  (id === TITLE ? shell.title : propertyOf(c, id)?.name || shell.unnamed)

export const operatorText = (o: Operator): string =>
  (o === 'nextDays' || o === 'pastDays' ? shell.daysAre[o] : strings.operators[o])

/** A condition's value in words; '' while it has none. `people`: the collection's, for names as they are now. */
export function conditionText(c: Collection, condition: Condition, people: People | null = null): string {
  const { propertyId, operator, value } = condition
  const property = propertyOf(c, propertyId)
  switch (conditionValueKind(property?.type ?? TITLE, operator)) {
    case 'none': return ''
    case 'options':
      return (Array.isArray(value) ? (value as readonly string[]) : []).map(id => property?.options.find(o => o.id === id)?.name ?? '').filter(Boolean).join(', ')
    case 'people':
      return (Array.isArray(value) ? (value as readonly string[]) : [])
        .map(id => (id === ME ? shell.me : (property && personName(id, property, people)) ?? UNKNOWN_PERSON)).join(', ')
    case 'checkbox': return value === null ? '' : value ? strings.checked.toLowerCase() : strings.unchecked.toLowerCase()
    case 'date': return typeof value === 'string' ? dateText({ start: value.slice(0, 10) }, Date.now()) : ''
    case 'number':
      if (typeof value !== 'number') return ''
      return operator === 'nextDays' || operator === 'pastDays' ? shell.dayCount(value) : String(value)
    default: return typeof value === 'string' ? value : ''
  }
}

/** The title and the properties, to pick one. */
export function propertyRows(c: Collection, except: readonly string[] = []): PickRow[] {
  return [{ id: TITLE, label: shell.title }, ...c.properties.map(p => ({ id: p.id, label: p.name || shell.unnamed }))]
    .filter(r => !except.includes(r.id))
}

export function newCondition(c: Collection, propertyId: string): Condition {
  const type = propertyOf(c, propertyId)?.type ?? TITLE
  const operator = operatorsFor(type)[0]!
  return { id: newId(), propertyId, operator, value: conditionValueKind(type, operator) === 'checkbox' ? true : null }
}

export function setFilter(store: PlannerStore, c: Collection, v: View, change: Partial<Filter>, typing = false) {
  store.updateView(c.id, v.id, { filter: { ...v.filter, ...change } }, { defer: typing })
}
export function setSorts(store: PlannerStore, c: Collection, v: View, sorts: readonly Sort[]) {
  store.updateView(c.id, v.id, { sorts })
}
