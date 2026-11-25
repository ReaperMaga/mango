import type { Planner } from '../context.ts'
import type { PluginMenuRow } from '../host.ts'
import { itemWord, hasOptions, PROPERTY_TYPES, type Collection, type Property, type View } from '../model.ts'
import { strings as shared } from '../strings.ts'
import { PROPERTY_ICONS } from '../ui/propertyIcons.ts'
import { editProperty } from './editProperty.ts'
import { optionWords } from './optionWords.ts'
import { strings } from './strings.ts'

/**
 * A property's menu. `view`: can hide it there. `rows`: the view's own, above the rest. The menu opens others
 * (types) and asks (names) once it has closed.
 */
export async function propertyMenu(
  planner: Planner,
  collection: Collection,
  property: Property,
  at: HTMLElement | { x: number; y: number },
  view?: View | null,
  rows: readonly PluginMenuRow[] = [],
): Promise<void> {
  const { mango, store } = planner
  const all = collection.properties
  const i = all.findIndex(p => p.id === property.id)
  let next: (() => unknown) | undefined

  const own: PluginMenuRow[] = [
    { label: strings.rename, icon: 'pencil', divider: rows.length > 0, onSelect: () => { next = rename } },
    ...(property.type === 'unsupported' ? [] : [{
      label: strings.changeType, icon: PROPERTY_ICONS[property.type], aside: shared.propertyTypes[property.type], onSelect: () => { next = changeType },
    }]),
    ...(hasOptions(property) ? [{ label: strings.editOptions(optionWords(property).many), icon: 'list', onSelect: () => { next = () => editProperty(planner, collection.id, property.id) } }] : []),
    ...(view ? [{ label: strings.hideInView, icon: 'eye-off', onSelect: hide }] : []),
    // In a view the columns have an order of their own.
    ...(view ? [] : [
      { label: strings.moveUpProperty, icon: 'arrow-up', disabled: i <= 0, onSelect: () => store.moveProperty(collection.id, property.id, { before: all[i - 1]!.id }) },
      { label: strings.moveDownProperty, icon: 'arrow-down', disabled: i < 0 || i >= all.length - 1, onSelect: () => store.moveProperty(collection.id, property.id, { after: all[i + 1]!.id }) },
    ]),
    { label: strings.deleteProperty, icon: 'trash-2', danger: true, divider: true, onSelect: () => { next = remove } },
  ]
  await mango.ui.contextMenu(at, [...rows, ...own])
  await next?.()

  async function rename() {
    const name = (await mango.ui.prompt({ title: strings.renameTitle, value: property.name, placeholder: strings.propertyName }))?.trim()
    if (name && name !== property.name) store.renameProperty(collection.id, property.id, name)
  }
  function changeType() {
    return mango.ui.contextMenu(at, PROPERTY_TYPES.map(t => ({
      label: shared.propertyTypes[t],
      icon: PROPERTY_ICONS[t],
      checked: t === property.type,
      onSelect: () => { void store.setPropertyType(collection.id, property.id, t) },
    })))
  }
  function hide() {
    const now = store.collection(collection.id)?.views.find(v => v.id === view?.id)
    if (now) store.updateView(collection.id, now.id, { columns: now.columns.map(c => (c.propertyId === property.id ? { ...c, visible: false } : c)) })
  }
  async function remove() {
    const ok = await mango.ui.confirm({ title: strings.deleteTitle(property.name), body: strings.deleteBody(itemWord(collection, 1)), confirmLabel: strings.delete, danger: true })
    if (ok) await store.deleteProperty(collection.id, property.id)
  }
}
