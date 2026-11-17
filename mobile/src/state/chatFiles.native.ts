import { Directory, File, Paths } from 'expo-file-system'
import type { ChatFiles } from '@/state/chatHistory'

/**
 * The phone's chats on disk: `<documents>/chats/<id>.json`, one file per chat, so a save
 * writes only the chats that changed. Each write goes to a temporary file first and is then
 * moved over the old one, so a chat is never left half written.
 */
const dir = new Directory(Paths.document, 'chats')

const ensureDir = () => dir.create({ intermediates: true, idempotent: true })

export const chatFiles: ChatFiles = {
  async readAll() {
    if (!dir.exists) return []
    const out: string[] = []
    for (const entry of dir.list()) {
      if (!(entry instanceof File) || !entry.name.endsWith('.json')) continue
      try { out.push(await entry.text()) } catch { /* unreadable: skipped */ }
    }
    return out
  },
  async write(id, json) {
    ensureDir()
    const tmp = new File(dir, `${id}.json.tmp`)
    tmp.create({ overwrite: true })
    await tmp.write(json)
    tmp.moveSync(new File(dir, `${id}.json`), { overwrite: true })
  },
  async remove(id) {
    const file = new File(dir, `${id}.json`)
    if (file.exists) file.delete()
  },
}
