import { defineComponent, h, provide, type Component } from 'vue'
import { PLANNER, type Planner } from '../context.ts'
import { propertyOf } from '../model.ts'
import PropertyEditor from './PropertyEditor.vue'
import { strings } from './strings.ts'

/**
 * A property's editor in a dialog. Mango shows one dialog at a time: from inside a dialog, show `PropertyEditor`
 * there instead (a second one would wait until the first is closed).
 */
export function editProperty(planner: Planner, collectionId: string, propertyId: string): Promise<void> {
  const c = planner.store.collection(collectionId)
  const property = c && propertyOf(c, propertyId)
  if (!property) return Promise.resolve()
  return planner.mango.ui.dialog({
    title: strings.editorTitle(property.name),
    width: 480,
    view: {
      component: defineComponent({
        props: ['ctx'],
        setup(props: { ctx?: { close(): void } }) {
          provide(PLANNER, planner)
          return () => h(PropertyEditor, { collectionId, propertyId, onGone: () => props.ctx?.close() })
        },
      }) as Component,
    },
  }).then(() => planner.store.flush())
}
