import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import '@fontsource-variable/jetbrains-mono'
import './style.css'
import DownloadTable from './components/DownloadTable.vue'
import ReleaseVersion from './components/ReleaseVersion.vue'
import HomeHero from './components/HomeHero.vue'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('DownloadTable', DownloadTable)
    app.component('ReleaseVersion', ReleaseVersion)
    app.component('HomeHero', HomeHero)
  },
} satisfies Theme
