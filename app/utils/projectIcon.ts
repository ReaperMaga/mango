import { defineComponent, h } from 'vue'
import ProjectBadge from '~/components/ui/ProjectBadge.vue'

/** A project's badge as a menu icon (MenuItem.icon takes a component). */
export const projectIcon = (name: string, path: string, hue?: number) =>
  defineComponent({ render: () => h(ProjectBadge, { name, path, hue, size: 'sm' }) })
