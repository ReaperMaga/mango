import type { SystemNotifier } from './types'

/** The web preview cannot show an iPhone's notifications: it only says so. */
export const systemNotifier: SystemNotifier = {
  kind: 'none',
  async permission() { return 'undetermined' },
  async request() { return 'denied' },
  async show() { /* nothing to show it with */ },
}
