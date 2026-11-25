import { computed, defineComponent, h, markRaw, ref, type Component, type PropType } from 'vue'
import ChatMarkdown from '~/components/chat/ChatMarkdown.vue'
import IconButton from '~/components/ui/IconButton.vue'
import ProjectBadge from '~/components/ui/ProjectBadge.vue'
import RipenessDot from '~/components/ui/RipenessDot.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiField from '~/components/ui/UiField.vue'
import UiMenu from '~/components/ui/UiMenu.vue'
import { useThreads } from '~/stores/threads'
import { useWorkspace } from '~/stores/workspace'
import { hasUnreadResult } from '~/types/chat'
import { baseName } from '~/utils/paths'
import { pluginRowItems } from '../menus'
import type { PluginMenuRow, PluginUiComponents } from '../types'
import PluginIcon from './PluginIcon.vue'

/**
 * Mango's own controls for plugins (`ui.components`), whose modules cannot import them. Most are the
 * components themselves; the wrappers here take what a plugin has (a chat's id, a project's path, its own
 * kinds of icon). Their props are part of the plugin API: docs/plugins.md lists them.
 */

type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'

/** UiMenu with a plugin's rows. Each plugin has its own, so a row that fails lands in its log. */
const menuOf = (pluginId: string): Component => defineComponent({
  name: 'PluginMenu',
  props: {
    items: { type: Array as PropType<PluginMenuRow[]>, required: true },
    placement: String as PropType<Placement>,
    width: Number,
    label: String,
    maxHeight: Number,
    maxWidth: Number,
  },
  setup(props, { slots, expose }) {
    const menu = ref<InstanceType<typeof UiMenu> | null>(null)
    const items = computed(() => pluginRowItems(pluginId, props.items))
    expose({
      show: () => menu.value?.show(),
      showAt: (x: number, y: number) => menu.value?.showAt(x, y),
      close: () => menu.value?.close(),
      toggle: () => menu.value?.toggle(),
    })
    return () => h(UiMenu, { ...props, items: items.value, ref: menu }, slots)
  },
})

/** A chat's status dot, as its sidebar row draws it. */
const ThreadDot = defineComponent({
  name: 'PluginThreadDot',
  props: { threadId: String as PropType<string | null>, size: Number },
  setup(props) {
    const threads = useThreads()
    return () => {
      const t = threads.byId(props.threadId)
      if (!t) return null
      return h(RipenessDot, {
        status: t.archived ? 'archived' : t.status,
        size: props.size,
        unseen: hasUnreadResult(t) || (!t.archived && !t.seen && t.status === 'waiting'),
      })
    }
  },
})

/** A project's badge, in the colour the user gave it. */
const PluginProjectBadge = defineComponent({
  name: 'PluginProjectBadge',
  props: { path: { type: String, required: true }, name: String, size: String as PropType<'sm' | 'md'> },
  setup(props) {
    const ws = useWorkspace()
    return () => h(ProjectBadge, {
      path: props.path,
      name: props.name || ws.openProjects.find(p => p.path === props.path)?.name || baseName(props.path),
      hue: ws.projectPrefs[props.path]?.color,
      size: props.size,
    })
  },
})

/** Markdown as a chat reply shows it, outside a chat: raw HTML escaped, pictures only from files, links as they open anywhere. */
const Markdown = defineComponent({
  name: 'PluginMarkdown',
  props: { text: String, base: String as PropType<string | null> },
  setup: props => () => h(ChatMarkdown, { text: String(props.text ?? ''), base: props.base ?? null, threadId: null }),
})

const shared = {
  Button: UiButton,
  IconButton,
  Field: UiField,
  Icon: PluginIcon,
  ThreadDot,
  ProjectBadge: PluginProjectBadge,
  Markdown,
}
for (const c of Object.values(shared)) markRaw(c as object)

export const pluginComponents = (pluginId: string): PluginUiComponents => markRaw({ ...shared, Menu: markRaw(menuOf(pluginId)) })
