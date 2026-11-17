<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useData, withBase } from 'vitepress'
import type { ThemeConfig } from '../../config'
import AppPreview from './AppPreview.vue'

/**
 * The home page: mark, headline, one-click downloads of the current release
 * for Windows, macOS and Linux, links into the docs, and a picture of the app.
 */
const { theme } = useData<ThemeConfig>()
const release = computed(() => theme.value.release)
const pick = (id: string) => release.value.assets.find(a => a.id === id)!

const downloads = computed(() => [
  { os: 'windows' as const, label: 'Windows', asset: pick('windows-exe'), detail: 'Installer (.exe), x64' },
  { os: 'mac' as const, label: 'macOS', asset: pick('macos-arm64'), detail: '.dmg, Apple Silicon' },
  { os: 'linux' as const, label: 'Linux', asset: pick('linux-appimage'), detail: 'AppImage, x86_64' },
])

/** The visitor's platform gets the filled button; unknown (phones) leaves them all quiet. */
const current = ref<'windows' | 'mac' | 'linux' | null>(null)
onMounted(() => {
  const ua = navigator.userAgent
  if (/Windows/i.test(ua)) current.value = 'windows'
  else if (/Macintosh|Mac OS X/i.test(ua) && !/iPhone|iPad/i.test(ua)) current.value = 'mac'
  else if (/Linux|X11/i.test(ua) && !/Android/i.test(ua)) current.value = 'linux'
})
</script>

<template>
  <section class="hero">
    <img class="hero__mark" :src="withBase('/icon.svg')" alt="" width="72" height="72" />

    <h1 class="hero__title">A workbench for coding agents</h1>
    <p class="hero__lede">
      Mango runs your Claude Code and Codex chats side by side on a project, lets you review and commit
      what they change, and keeps a real terminal docked at the bottom. It updates itself.
    </p>

    <div class="get">
      <div class="get__head">
        <span>Download Mango <span class="get__version">{{ release.version }}</span></span>
        <a class="get__more" :href="withBase('/guide/install')">All formats and install notes</a>
      </div>
      <div class="get__body">
        <a
          v-for="d in downloads"
          :key="d.os"
          class="get__btn"
          :class="{ 'is-current': current === d.os }"
          :href="d.asset.url"
          :download="d.asset.file"
        >
          <svg class="get__icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14" />
          </svg>
          <span class="get__text">
            <span class="get__label">Download for {{ d.label }}</span>
            <span class="get__detail">{{ d.detail }}</span>
          </span>
        </a>
      </div>
      <p class="get__foot">
        Also as .msi, an Intel .dmg, .deb and .rpm. Needs the <code>claude</code> or <code>codex</code> CLI, signed in.
      </p>
    </div>

    <div class="hero__links">
      <a class="link-btn" :href="withBase('/guide/getting-started')">Get started</a>
      <a class="link-btn" :href="withBase('/guide/chats')">Read the docs</a>
      <a class="link-btn" href="https://github.com/ReaperMaga/mango">GitHub</a>
    </div>

    <AppPreview class="hero__preview" />
  </section>
</template>

<style scoped>
.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 72px 0 24px;
}
@media (max-width: 640px) {
  .hero { padding-top: 40px; }
}

.hero__mark { display: block; width: 72px; height: 72px; margin-bottom: 24px; }

.hero__title {
  margin: 0;
  max-width: 16ch;
  font-size: clamp(36px, 6vw, 60px);
  line-height: 1.06;
  font-weight: 650;
  letter-spacing: -0.03em;
  color: var(--vp-c-text-1);
  text-wrap: balance;
}
.hero__lede {
  margin: 20px 0 0;
  max-width: 58ch;
  font-size: 17px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  text-wrap: pretty;
}

/* ---------- downloads ---------- */
.get {
  width: 100%;
  max-width: 760px;
  margin-top: 36px;
  text-align: left;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
  overflow: hidden;
}
.get__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--vp-c-divider);
  font-size: 13px;
  color: var(--vp-c-text-2);
}
.get__version { font-family: var(--vp-font-family-mono); font-size: 12px; color: var(--vp-c-text-1); }
.get__more { color: var(--vp-c-brand-1); font-weight: 500; text-decoration: none; white-space: nowrap; }
.get__more:hover { text-decoration: underline; text-underline-offset: 3px; }
.get__body { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; padding: 14px 16px; }
@media (max-width: 700px) {
  .get__body { grid-template-columns: 1fr; }
}
@media (max-width: 560px) {
  .get__head { flex-direction: column; gap: 2px; }
}

.get__btn {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 14px;
  border-radius: 8px;
  border: 1px solid var(--vp-c-border);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  text-decoration: none;
  transition: background 0.15s ease-out, border-color 0.15s ease-out, transform 0.1s ease-out;
}
.get__btn:hover { border-color: var(--vp-c-text-3); background: var(--vp-c-bg-elv); }
.get__btn:active { transform: translateY(1px); }
.get__btn.is-current { background: var(--vp-button-brand-bg); border-color: transparent; color: var(--vp-button-brand-text); }
.get__btn.is-current:hover { background: var(--vp-button-brand-hover-bg); }
.get__icon {
  flex: none;
  width: 20px;
  height: 20px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.get__text { display: grid; gap: 1px; min-width: 0; }
.get__label { font-size: 14.5px; font-weight: 600; line-height: 1.3; }
.get__detail { font-size: 12.5px; line-height: 1.35; color: var(--vp-c-text-3); }
.get__btn.is-current .get__detail { color: inherit; opacity: 0.78; }

.get__foot {
  margin: 0;
  padding: 0 16px 12px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--vp-c-text-3);
}
.get__foot code {
  font-family: var(--vp-font-family-mono);
  font-size: 11.5px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--vp-code-bg);
  color: var(--vp-c-text-2);
}

/* ---------- links ---------- */
.hero__links { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; margin-top: 24px; }
.link-btn {
  display: inline-flex;
  align-items: center;
  height: 40px;
  padding: 0 18px;
  border-radius: 8px;
  border: 1px solid var(--vp-c-divider);
  font-size: 14px;
  font-weight: 500;
  color: var(--vp-c-text-1);
  text-decoration: none;
  transition: border-color 0.15s ease-out, background 0.15s ease-out;
}
.link-btn:hover { border-color: var(--vp-c-border); background: var(--vp-c-bg-soft); }

.hero__preview { margin-top: 56px; }
</style>
