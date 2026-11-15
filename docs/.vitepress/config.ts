import { defineConfigWithTheme, type DefaultTheme } from 'vitepress'
import { release, REPO, type Release } from './release'

export type ThemeConfig = DefaultTheme.Config & { release: Release }

const base = '/mango/'

export default defineConfigWithTheme<ThemeConfig>({
  title: 'Mango',
  description: 'A desktop workbench for coding agents: run Claude Code and Codex chats side by side, review and commit changes, and keep a real terminal docked at the bottom.',
  lang: 'en-US',
  base,
  cleanUrls: true,
  lastUpdated: true,
  appearance: 'dark',

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}icon.svg` }],
    ['meta', { name: 'theme-color', content: '#1a1d1b' }],
    ['meta', { property: 'og:title', content: 'Mango' }],
    ['meta', { property: 'og:description', content: 'A desktop workbench for Claude Code and Codex.' }],
  ],

  themeConfig: {
    release,
    logo: { src: '/icon.svg', alt: '' },
    siteTitle: 'Mango',

    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '^/guide/' },
      { text: 'Download', link: '/guide/install' },
      { text: 'Development', link: '/development/building', activeMatch: '^/development/' },
      {
        text: release.tag,
        items: [
          { text: 'Changelog', link: '/changelog' },
          { text: `Release ${release.tag}`, link: release.url },
          { text: 'All releases', link: release.allUrl },
        ],
      },
    ],

    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Install', link: '/guide/install' },
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'Chats and agents', link: '/guide/chats' },
          { text: 'Changes (git)', link: '/guide/changes' },
          { text: 'Unity Version Control', link: '/guide/unity-vcs' },
          { text: 'Terminal', link: '/guide/terminal' },
          { text: 'Settings', link: '/guide/settings' },
          { text: 'Updates', link: '/guide/updates' },
          { text: 'Keyboard shortcuts', link: '/guide/shortcuts' },
        ],
      },
      {
        text: 'Development',
        items: [
          { text: 'Building from source', link: '/development/building' },
          { text: 'Architecture', link: '/development/architecture' },
          { text: 'Releasing', link: '/development/releasing' },
        ],
      },
      { text: 'Changelog', link: '/changelog' },
    ],

    socialLinks: [{ icon: 'github', link: REPO, ariaLabel: 'Mango on GitHub' }],

    editLink: {
      pattern: `${REPO}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub',
    },

    search: { provider: 'local' },

    outline: { level: [2, 3] },

    footer: {
      message: `Mango ${release.version}`,
    },
  },
})
