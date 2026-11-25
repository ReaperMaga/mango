import { h, type Component } from 'vue'
import App from './App.vue'
import { readRoute, TAB_KEY, VIEW_ID, type Route } from './context.ts'
import type { MangoPluginApi } from './host.ts'
import type { Collection } from './model.ts'
import PickCollection from './PickCollection.vue'
import { createStore, type PlannerStore } from './store.ts'
import { strings } from './strings.ts'

const ICON = 'square-kanban'
let current: PlannerStore | null = null

export function activate(mango: MangoPluginApi) {
  const store = createStore(mango)
  current = store
  mango.onDispose(() => {
    store.dispose()
    if (current === store) current = null
  })

  const isOpen = () => mango.ui.tabs.active()?.viewId === VIEW_ID

  function open(route?: Route) {
    if (!mango.workspace.activeProject()) return mango.ui.toast({ title: strings.noProject })
    mango.ui.tabs.open(VIEW_ID, { title: strings.planner, key: TAB_KEY, state: route ? { ...route } : undefined })
  }

  function toggle() {
    if (isOpen()) mango.ui.tabs.close(VIEW_ID, TAB_KEY)
    else open()
  }

  mango.ui.tabs.register({
    id: VIEW_ID,
    icon: ICON,
    header: 'none',
    restore: true,
    view: { component: App as Component, props: { mango, store } },
  })
  mango.ui.navItems.register({ id: 'planner', title: strings.planner, icon: ICON, shortcut: 'planner', active: isOpen, run: () => open() })
  mango.shortcuts.register({ id: 'planner', label: strings.commands.open, key: 'Mod+Shift+D', run: toggle })

  /** The only collection, or the one the user picks; says so when there is none. */
  async function chooseCollection(): Promise<Collection | null> {
    const list = store.collections.value
    if (!list.length) {
      mango.ui.toast({ title: strings.noCollections, body: strings.noCollectionsForItem, action: { label: strings.commands.open, run: () => open() } })
      return null
    }
    if (list.length === 1) return list[0]!
    let picked: Collection | null = null
    await mango.ui.dialog({
      title: strings.chooseCollection,
      width: 360,
      view: {
        component: {
          props: ['ctx'],
          setup: (props: { ctx?: { close(): void } }) => () => h(PickCollection, {
            mango,
            collections: list,
            onPick: (c: Collection) => {
              picked = c
              props.ctx?.close()
            },
          }),
        } as Component,
      },
    })
    return picked
  }

  mango.commands.register({ id: 'open', title: strings.commands.open, icon: ICON, keywords: 'board kanban tasks notes table', run: () => open() })
  mango.commands.register({
    id: 'new-item',
    title: strings.commands.newItem,
    icon: ICON,
    keywords: 'planner task bug note',
    run: async () => {
      // In the planner it goes into the collection on screen.
      const shown = isOpen() ? readRoute(mango.ui.tabs.active()?.state)?.collectionId ?? store.lastCollection() : null
      const collection = store.collections.value.find(c => c.id === shown) ?? await chooseCollection()
      if (!collection) return
      const title = (await mango.ui.prompt({ title: strings.newItemIn(collection.name), placeholder: strings.newItemPrompt }))?.trim()
      if (!title) return
      const item = await store.createItem(collection.id, { title })
      if (item) open({ collectionId: collection.id, itemId: item.id })
    },
  })
  mango.commands.register({
    id: 'new-collection',
    title: strings.commands.newCollection,
    icon: ICON,
    keywords: 'planner board table',
    run: async () => {
      const name = (await mango.ui.prompt({ title: strings.newCollection, placeholder: strings.templates.tasks.name }))?.trim()
      if (!name) return
      const collection = store.createCollection({ name, template: 'tasks' })
      if (collection) open({ collectionId: collection.id })
    },
  })
  mango.ui.menus.register('thread', {
    id: 'add',
    label: strings.commands.addThread,
    icon: ICON,
    run: async ({ threadId }) => {
      const title = mango.chat.get(threadId)?.title
      const collection = title === undefined ? null : await chooseCollection()
      if (!collection) return
      const item = await store.createItem(collection.id, { title, chats: [threadId] })
      if (!item) return
      mango.ui.toast({
        title: strings.itemAdded(collection.name),
        kind: 'success',
        action: { label: strings.show, run: () => open({ collectionId: collection.id, itemId: item.id }) },
      })
    },
  })

}

/** Before the plugin goes: what was typed is written. */
export async function deactivate() {
  await current?.flush()
}
