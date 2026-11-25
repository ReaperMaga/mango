import { computed, type Component } from 'vue'
import App from './App.vue'
import { readRoute, TAB_KEY, VIEW_ID, type Planner, type Route } from './context.ts'
import type { MangoPluginApi } from './host.ts'
import { askCollection, askNewCollection, askNewItem } from './shell/dialogs.ts'
import './shell/shell.css'
import { shell } from './shell/strings.ts'
import { createStore, type PlannerStore } from './store.ts'
import { strings } from './strings.ts'
import { toastOnce } from './ui/toastOnce.ts'

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

  /** Shows the planner's tab, where it was or at `route`. */
  function open(route?: Route) {
    if (!mango.workspace.activeProject()) return toastOnce(mango, strings.noProject, shell.noProjectBody)
    mango.ui.tabs.open(VIEW_ID, { title: strings.planner, key: TAB_KEY, state: route ? { ...route } : undefined })
  }

  function toggle() {
    if (isOpen()) mango.ui.tabs.close(VIEW_ID, TAB_KEY)
    else open()
  }

  /** For dialogs outside of the tab: going somewhere opens it there. */
  const planner: Planner = {
    mango,
    store,
    route: computed(() => readRoute(mango.ui.tabs.active()?.state) ?? { collectionId: store.lastCollection() }),
    go: route => open({ collectionId: route.collectionId ?? store.lastCollection(), ...route }),
  }

  /** The collections are there; says so when they could not be read. */
  async function loaded(): Promise<boolean> {
    if (store.status.value !== 'ready') await store.load()
    // Another load was under way.
    for (let i = 0; i < 100 && store.status.value === 'loading'; i++) await new Promise(r => setTimeout(r, 50))
    if (store.status.value === 'ready') return true
    mango.ui.toast({ title: strings.loadFailed, body: store.error.value ?? '', kind: 'error' })
    return false
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

  mango.commands.register({ id: 'open', title: strings.commands.open, icon: ICON, keywords: 'board kanban tasks notes table', run: () => open() })
  mango.commands.register({
    id: 'new-item',
    title: strings.commands.newItem,
    icon: ICON,
    keywords: 'planner task bug note add',
    run: async () => {
      if (!await loaded()) return
      // In the planner it goes into the collection on screen.
      const shown = (isOpen() ? readRoute(mango.ui.tabs.active()?.state)?.collectionId : null) ?? store.lastCollection()
      const collection = store.collections.value.find(c => c.id === shown) ?? store.collections.value[0] ?? await askNewCollection(planner)
      if (!collection) return
      const added = await askNewItem(planner, collection.id)
      if (!added) return
      const route: Route = { collectionId: added.collection.id, itemId: added.item.id }
      if (added.open) return open(route)
      mango.ui.toast({ title: strings.itemAdded(added.collection.name), kind: 'success', action: { label: strings.show, run: () => open(route) } })
    },
  })
  mango.commands.register({
    id: 'new-collection',
    title: strings.commands.newCollection,
    icon: ICON,
    keywords: 'planner board table',
    run: async () => {
      if (!await loaded()) return
      const collection = await askNewCollection(planner)
      if (collection) open({ collectionId: collection.id })
    },
  })
  mango.ui.menus.register('thread', {
    id: 'add',
    label: strings.commands.addThread,
    icon: ICON,
    run: async ({ threadId }) => {
      const title = mango.chat.get(threadId)?.title
      if (title === undefined || !await loaded()) return
      const collection = await askCollection(planner)
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
