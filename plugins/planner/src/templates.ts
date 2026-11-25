/** What a new collection starts with. Nothing is made until the user picks one. */

import { newId, TITLE, type Color, type Operator, type PropertyType, type ViewType } from './model.ts'
import { spread } from './order.ts'
import type { Json, JsonObject } from './patch.ts'
import { strings } from './strings.ts'

export type TemplateId = 'tasks' | 'bugs' | 'notes' | 'empty'

interface PropertySpec { key: string; name: string; type: PropertyType; options?: Array<[name: string, color: Color]> }
interface ViewSpec {
  name: string
  type: ViewType
  groupBy?: string
  /** Shown, in this order; the others are hidden. */
  show: string[]
  sorts?: Array<[property: string, direction: 'asc' | 'desc']>
}
interface Spec { icon: string; color: Color; properties: PropertySpec[]; views: ViewSpec[] }

export interface Template { readonly id: TemplateId; readonly name: string; readonly description: string; readonly icon: string }

const t = strings.template

const SPECS: Record<TemplateId, Spec> = {
  tasks: {
    icon: 'square-kanban',
    color: 'blue',
    properties: [
      { key: 'status', name: t.status, type: 'select', options: [[t.toDo, 'neutral'], [t.inProgress, 'blue'], [t.done, 'green']] },
      { key: 'priority', name: t.priority, type: 'select', options: [[t.high, 'red'], [t.medium, 'yellow'], [t.low, 'neutral']] },
      { key: 'due', name: t.due, type: 'date' },
    ],
    views: [
      { name: t.board, type: 'board', groupBy: 'status', show: ['priority', 'due'] },
      { name: t.table, type: 'table', show: ['status', 'priority', 'due'] },
    ],
  },
  bugs: {
    icon: 'bug',
    color: 'red',
    properties: [
      { key: 'status', name: t.status, type: 'select', options: [[t.new, 'neutral'], [t.confirmed, 'yellow'], [t.fixing, 'blue'], [t.fixed, 'green']] },
      { key: 'severity', name: t.severity, type: 'select', options: [[t.critical, 'red'], [t.major, 'orange'], [t.minor, 'neutral']] },
      { key: 'link', name: t.link, type: 'url' },
    ],
    views: [
      { name: t.board, type: 'board', groupBy: 'status', show: ['severity'] },
      { name: t.table, type: 'table', show: ['status', 'severity', 'link'], sorts: [['severity', 'asc']] },
    ],
  },
  notes: {
    icon: 'notebook-text',
    color: 'yellow',
    properties: [
      { key: 'tags', name: t.tags, type: 'multiSelect' },
      { key: 'edited', name: t.edited, type: 'updatedTime' },
    ],
    views: [{ name: t.table, type: 'table', show: ['tags', 'edited'], sorts: [['edited', 'desc']] }],
  },
  empty: {
    icon: 'table-2',
    color: 'neutral',
    properties: [],
    views: [{ name: t.table, type: 'table', show: [] }],
  },
}

export const TEMPLATES: readonly Template[] = (Object.keys(SPECS) as TemplateId[])
  .map(id => ({ id, ...strings.templates[id], icon: SPECS[id].icon }))

export interface NewProperty { name: string; type: PropertyType; options?: ReadonlyArray<{ name: string; color?: Color }> }

export function propertyData(p: { name: string; type: PropertyType; order: string; options?: ReadonlyArray<{ id?: string; name: string; color?: Color }> }): JsonObject {
  const keys = spread(p.options?.length ?? 0)
  return {
    name: p.name,
    type: p.type,
    order: p.order,
    options: Object.fromEntries((p.options ?? []).map((o, i) => [o.id ?? newId(), { name: o.name, color: o.color ?? 'neutral', order: keys[i]! }])),
  }
}

export interface NewView {
  name: string
  type: ViewType
  groupBy?: string | null
  columns?: ReadonlyArray<{ propertyId: string; visible: boolean }>
  sorts?: ReadonlyArray<{ propertyId: string; direction: 'asc' | 'desc' }>
  filter?: { match: 'and' | 'or'; conditions: ReadonlyArray<{ id: string; propertyId: string; operator: Operator; value: Json }> }
}

export function viewData(v: NewView, order: string): JsonObject {
  return {
    name: v.name,
    type: v.type,
    order,
    groupBy: v.groupBy ?? null,
    hiddenGroups: [],
    collapsedGroups: [],
    sorts: (v.sorts ?? []).map(s => ({ ...s })),
    filter: v.filter ? { match: v.filter.match, conditions: v.filter.conditions.map(c => ({ ...c })) } : { match: 'and', conditions: [] },
    columns: (v.columns ?? []).map(c => ({ ...c })),
    widths: {},
    cardPreview: 'none',
  }
}

/** The stored properties and views of a new collection, with ids of its own. */
export function templateData(id: TemplateId): { icon: string; color: Color; properties: JsonObject; views: JsonObject } {
  const spec = SPECS[id]
  const ids = new Map(spec.properties.map(p => [p.key, newId()]))
  const idOf = (key: string) => (key === TITLE ? TITLE : ids.get(key)!)
  const propertyKeys = spread(spec.properties.length)
  const viewKeys = spread(spec.views.length)
  return {
    icon: spec.icon,
    color: spec.color,
    properties: Object.fromEntries(spec.properties.map((p, i) => [idOf(p.key), propertyData({
      name: p.name, type: p.type, order: propertyKeys[i]!, options: p.options?.map(([name, color]) => ({ name, color })),
    })])),
    views: Object.fromEntries(spec.views.map((v, i) => [newId(), viewData({
      name: v.name,
      type: v.type,
      groupBy: v.groupBy ? idOf(v.groupBy) : null,
      columns: [
        ...v.show.map(k => ({ propertyId: idOf(k), visible: true })),
        ...spec.properties.filter(p => !v.show.includes(p.key)).map(p => ({ propertyId: idOf(p.key), visible: false })),
      ],
      sorts: v.sorts?.map(([p, direction]) => ({ propertyId: idOf(p), direction })),
    }, viewKeys[i]!)])),
  }
}
