import type { Planner } from '../context.ts'
import type { PluginMenuRow } from '../host.ts'
import { itemWord, propertyOf, valueOf, type Collection, type Item, type Property } from '../model.ts'
import { optionIcon } from '../ui/optionIcon.ts'
import { startChat } from './chats.ts'
import { strings } from './strings.ts'

export interface ItemMenuOptions {
  /** How it opens; left out, in the planner's tab. `null`: it is open already. */
  open?: ((itemId: string) => void) | null
  /** The key that opens it there; Enter when left out. */
  openKey?: string
  /** The select offered as quick choices: a board's group. Left out, the first one. */
  propertyId?: string | null
  /** Rows of the view's own, after Open. */
  rows?: readonly PluginMenuRow[]
  /** After these were deleted. */
  deleted?: () => void
}

/** More choices than this do not belong in a menu. */
const MAX_OPTIONS = 8

/** The menu of one item, or of several selected ones. */
export function itemMenu(
  planner: Planner,
  collection: Collection,
  itemIds: readonly string[],
  at: HTMLElement | { x: number; y: number },
  opts: ItemMenuOptions = {},
): Promise<void> {
  const { mango, store } = planner
  const items = itemIds.map(id => store.item(collection.id, id)).filter((i): i is Item => i !== null)
  if (!items.length) return Promise.resolve()
  const ids = items.map(i => i.id)
  const one = items.length === 1 ? items[0]! : null
  const rows: PluginMenuRow[] = []

  if (one) {
    const { open = (itemId: string) => planner.go({ itemId }) } = opts
    if (open) rows.push({ label: strings.open, icon: 'panel-right', kbd: opts.openKey ?? 'Enter', onSelect: () => open(one.id) })
  }
  rows.push(...(opts.rows ?? []))
  if (one) {
    rows.push({ label: strings.startChat, icon: 'message-square-plus', onSelect: () => { startChat(planner, collection, one) } })
    const chats = one.chats.flatMap(id => mango.chat.get(id) ?? []).slice(-3)
    for (const t of chats) {
      rows.push({
        label: chats.length === 1 ? strings.openChat : t.title || strings.newChatTitle,
        aside: chats.length === 1 ? t.title : undefined,
        icon: 'message-square',
        onSelect: () => mango.chat.show(t.id),
      })
    }
  }

  const status = statusOf(collection, opts.propertyId)
  if (status) {
    const set = (id: string | null) => store.updateItems(collection.id, ids, { values: { [status.id]: id } })
    const all = (id: string | null) => items.every(i => valueOf(i, status) === id)
    status.options.forEach((o, i) => rows.push({
      label: o.name,
      icon: optionIcon(o.color),
      checked: all(o.id),
      ...(i === 0 ? { divider: true, group: status.name } : {}),
      onSelect: () => set(o.id),
    }))
    rows.push({ label: strings.none(status.name), icon: optionIcon(null), checked: all(null), onSelect: () => set(null) })
  }

  rows.push(
    { label: strings.duplicate, icon: 'copy-plus', divider: true, onSelect: () => { store.duplicateItems(collection.id, ids) } },
    { label: strings.copyMarkdown, icon: 'copy', onSelect: () => { void copyMarkdown(planner, collection.id, ids) } },
    {
      label: one ? strings.delete : strings.deleteMany(ids.length, itemWord(collection, ids.length)),
      icon: 'trash-2',
      danger: true,
      divider: true,
      onSelect: () => {
        store.deleteItems(collection.id, ids)
        opts.deleted?.()
      },
    },
  )
  return mango.ui.contextMenu(at, rows)
}

function statusOf(collection: Collection, propertyId: string | null | undefined): Property | null {
  const given = propertyId ? propertyOf(collection, propertyId) : null
  const p = given?.type === 'select' ? given : collection.properties.find(e => e.type === 'select') ?? null
  return p && p.options.length > 0 && p.options.length <= MAX_OPTIONS ? p : null
}

async function copyMarkdown(planner: Planner, collectionId: string, ids: readonly string[]) {
  const { mango, store } = planner
  try {
    const text = await store.exportMarkdown(collectionId, ids)
    // Says itself why the items could not be read.
    if (text === null) return
    await navigator.clipboard.writeText(text)
    mango.ui.toast({ title: strings.copied, kind: 'success', timeout: 2000 })
  } catch (e) {
    mango.log.error('Copying:', e)
    mango.ui.toast({ title: strings.copyFailed, kind: 'error' })
  }
}
