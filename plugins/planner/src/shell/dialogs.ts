/** The planner's dialogs. They show in Mango's dialog, outside of the planner's tab, and get what its components need. */

import { defineComponent, h, provide, type Component } from 'vue'
import { PLANNER, type Planner } from '../context.ts'
import type { Collection, Item } from '../model.ts'
import PickCollection from '../PickCollection.vue'
import { strings } from '../strings.ts'
import CollectionSettings from './CollectionSettings.vue'
import NewCollection from './NewCollection.vue'
import QuickAdd from './QuickAdd.vue'
import { shell } from './strings.ts'

/** Shows a component in a dialog; `answer` closes it. Resolves with the answer, or null when it was closed. */
async function ask<T>(planner: Planner, title: string, width: number, view: Component, on: (answer: (value: T | null) => void) => Record<string, unknown>): Promise<T | null> {
  let result: T | null = null
  await planner.mango.ui.dialog({
    title,
    width,
    view: {
      component: defineComponent({
        props: ['ctx'],
        setup(props: { ctx?: { close(): void } }) {
          provide(PLANNER, planner)
          const answer = (value: T | null) => {
            result = value
            props.ctx?.close()
          }
          return () => h(view, on(answer))
        },
      }) as Component,
    },
  })
  return result
}

export const askNewCollection = (planner: Planner): Promise<Collection | null> =>
  ask<Collection>(planner, strings.newCollection, 480, NewCollection, answer => ({ onMade: answer, onCancel: () => answer(null) }))

/** The collection the user picks, or makes. */
export async function askCollection(planner: Planner): Promise<Collection | null> {
  if (!planner.store.collections.value.length) return askNewCollection(planner)
  const picked = await ask<Collection | 'new'>(planner, strings.chooseCollection, 380, PickCollection, answer => ({
    currentId: planner.store.lastCollection(),
    onPick: answer,
    onCreate: () => answer('new'),
  }))
  return picked === 'new' ? askNewCollection(planner) : picked
}

export interface QuickAdded { collection: Collection; item: Item; open: boolean }

export const askNewItem = (planner: Planner, collectionId: string): Promise<QuickAdded | null> =>
  ask<QuickAdded>(planner, shell.quickAdd, 440, QuickAdd, answer => ({
    collectionId,
    onAdded: (collection: Collection, item: Item, open: boolean) => answer({ collection, item, open }),
    onCancel: () => answer(null),
  }))

/** `remove`: it is to be deleted, which asks in a dialog of its own. */
export const askCollectionSettings = (planner: Planner, collectionId: string, groupBy: string | null): Promise<'remove' | null> =>
  ask<'remove'>(planner, shell.editCollectionTitle, 480, CollectionSettings, answer => ({
    collectionId,
    groupBy,
    onDone: () => answer(null),
    onRemove: () => answer('remove'),
  }))
