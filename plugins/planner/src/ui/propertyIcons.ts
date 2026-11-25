import type { PropertyType } from '../model.ts'

export const PROPERTY_ICONS: Record<PropertyType, string> = {
  text: 'text-initial',
  number: 'hash',
  select: 'list',
  multiSelect: 'tags',
  date: 'calendar',
  checkbox: 'square-check',
  url: 'link',
  createdTime: 'calendar-plus',
  updatedTime: 'clock',
  unsupported: 'puzzle',
}
