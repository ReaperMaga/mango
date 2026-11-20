export type NotifyPermission = 'granted' | 'denied' | 'undetermined'

export interface ShownNotification {
  title: string
  body: string
  sound: boolean
  /** The chat to open when it is tapped. */
  threadId?: string
}

/** Where a notification is shown: iOS (local notifications), or nowhere (the web preview). */
export interface SystemNotifier {
  kind: 'system' | 'none'
  permission(): Promise<NotifyPermission>
  /** Ask iOS; it asks the person once, and afterwards only reports their answer. */
  request(): Promise<NotifyPermission>
  show(n: ShownNotification): Promise<void>
}
