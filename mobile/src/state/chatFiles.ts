import { type ChatFiles, memoryChatFiles } from '@/state/chatHistory'

/**
 * Where the web preview keeps chats: localStorage, one key per chat (there is no file system in
 * a browser). The iOS app uses `chatFiles.native.ts` instead (Metro picks it by platform).
 */
const PREFIX = 'mango.chat.'

function webChatFiles(storage: Storage): ChatFiles {
  return {
    async readAll() {
      const out: string[] = []
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i)
        const json = key?.startsWith(PREFIX) ? storage.getItem(key) : null
        if (json) out.push(json)
      }
      return out
    },
    async write(id, json) { storage.setItem(PREFIX + id, json) },
    async remove(id) { storage.removeItem(PREFIX + id) },
  }
}

/** localStorage when there is a working one (not in Node, where it may exist but refuse); else memory. */
function pick(): ChatFiles {
  try {
    const storage = globalThis.window?.localStorage
    if (storage) { storage.getItem(PREFIX); return webChatFiles(storage) }
  } catch { /* storage refused (private mode, no file): keep chats in memory */ }
  return memoryChatFiles()
}

let picked: ChatFiles | null = null
const files = () => (picked ??= pick())

export const chatFiles: ChatFiles = {
  readAll: () => files().readAll(),
  write: (id, json) => files().write(id, json),
  remove: id => files().remove(id),
}
