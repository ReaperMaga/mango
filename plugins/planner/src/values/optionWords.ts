/** What a property's options are called after its name: Status: status, statuses; Tags: tag, tags. */

import type { Property } from '../model.ts'
import { strings } from './strings.ts'

export function optionWords(property: Pick<Property, 'name'>): { one: string; many: string } {
  const name = property.name.trim().toLowerCase()
  // English endings; any other name stays out of sentences.
  if (!/^[a-z][a-z -]{1,23}$/.test(name)) return { one: strings.option, many: strings.options }
  if (/(?:ss|us|is|x|ch|sh)$/.test(name)) return { one: name, many: `${name}es` }
  if (/[^aeiou]ies$/.test(name)) return { one: name.replace(/ies$/, 'y'), many: name }
  if (/(?:sses|uses|xes|ches|shes)$/.test(name)) return { one: name.replace(/es$/, ''), many: name }
  if (name.endsWith('s')) return { one: name.slice(0, -1), many: name }
  if (/[^aeiou]y$/.test(name)) return { one: name, many: name.replace(/y$/, 'ies') }
  return { one: name, many: `${name}s` }
}
