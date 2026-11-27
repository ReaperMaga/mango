import { actions } from './actions.ts'
import { agents } from './agents.ts'
import { appearance } from './appearance.ts'
import { behavior } from './behavior.ts'
import { chat } from './chat.ts'
import { common } from './common.ts'
import { envs } from './envs.ts'
import { files } from './files.ts'
import { general } from './general.ts'
import { git } from './git.ts'
import { links } from './links.ts'
import { lore } from './lore.ts'
import { notifications } from './notifications.ts'
import { plugins } from './plugins.ts'
import { project } from './project.ts'
import { releases } from './releases.ts'
import { settings } from './settings.ts'
import { shell } from './shell.ts'
import { start } from './start.ts'
import { terminal } from './terminal.ts'

/** English: the source, and the shape every other language has to fill. */
export const en = {
  actions,
  agents,
  appearance,
  behavior,
  chat,
  common,
  envs,
  files,
  general,
  git,
  links,
  lore,
  notifications,
  plugins,
  project,
  releases,
  settings,
  shell,
  start,
  terminal,
}

export type Messages = typeof en
