/**
 * What a run gets for its attachments, on this computer and in a remote environment.
 *
 *   node --test tests/attachments.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Attachment } from '../app/types/chat.ts'
import { forAgent, forRemoteAgent } from '../app/utils/attachments.ts'

const local = (id: string, name: string, kind: Attachment['kind'] = 'file', mime = 'application/pdf'): Attachment =>
  ({ id, name, kind, mime, size: 3, path: `C:\\Users\\me\\AppData\\Roaming\\dev.mango.app\\attachments\\${id}\\${name}` })
const there = (path: string) => `/home/agent/.local/share/mango/attachments/${path.split('\\').slice(-2).join('/')}`

test('on this computer only files named by path open their folder: a picture sent inline needs none', async () => {
  const gif = local('p1', 'small.gif', 'image', 'image/gif')
  const read = async () => 'R0lGODlh'
  const picture = await forAgent('look', [gif], read)
  assert.deepEqual([picture.images.length, picture.prompt, picture.readDirs], [1, 'look', []])
  const folder = (a: Attachment) => a.path.slice(0, a.path.lastIndexOf('\\'))
  const pdf = local('a1', 'spec.pdf')
  const both = await forAgent('read', [gif, pdf], read)
  assert.deepEqual(both.readDirs, [folder(pdf)])
  assert.ok(both.prompt.includes(pdf.path) && !both.prompt.includes(gif.path))
  // One that cannot go inline is read from disk, like any other file.
  const failed = await forAgent('look', [gif], async () => { throw new Error('too large') })
  assert.deepEqual([failed.images.length, failed.readDirs], [0, [folder(gif)]])
  assert.ok(failed.prompt.includes(gif.path))
})

test('every file is put into the environment and named by its path there', async () => {
  const put: string[] = []
  const r = await forRemoteAgent(
    'Read these',
    [local('a1', 'spec.pdf'), local('a2', 'data.csv', 'file', 'text/csv'), local('a3', 'build.zip', 'file', 'application/octet-stream')],
    async () => { throw new Error('files are not read here') },
    async (path) => { put.push(path); return there(path) },
  )
  assert.equal(put.length, 3)
  assert.deepEqual(r.images, [])
  assert.deepEqual(r.dropped, [])
  assert.equal(r.prompt, [
    'Read these',
    '',
    'The user attached 3 files. Read them from disk:',
    '- spec.pdf: /home/agent/.local/share/mango/attachments/a1/spec.pdf',
    '- data.csv: /home/agent/.local/share/mango/attachments/a2/data.csv',
    '- build.zip: /home/agent/.local/share/mango/attachments/a3/build.zip',
  ].join('\n'))
  assert.ok(!r.prompt.includes('C:\\'), 'no path on this computer reaches the remote agent')
})

test('a picture that cannot go inline goes into the environment too', async () => {
  const r = await forRemoteAgent(
    '',
    [local('p1', 'huge.png', 'image', 'image/png')],
    async () => { throw new Error('too large') },
    async path => there(path),
  )
  assert.deepEqual(r.images, [])
  assert.match(r.prompt, /huge\.png: \/home\/agent\/\.local\/share\/mango\/attachments\/p1\/huge\.png/)
})

test('a file that could not be put there stays behind, with the reason', async () => {
  const r = await forRemoteAgent(
    'hi',
    [local('a1', 'ok.pdf'), local('a2', 'bad.pdf')],
    async () => '',
    async (path) => {
      if (path.endsWith('bad.pdf')) throw new Error('Could not put bad.pdf into dev: no space left')
      return there(path)
    },
  )
  assert.equal(r.dropped.length, 1)
  assert.equal(r.dropped[0]!.attachment.name, 'bad.pdf')
  assert.equal(r.dropped[0]!.error, 'Could not put bad.pdf into dev: no space left')
  assert.match(r.prompt, /a file\. Read it from disk:\n- ok\.pdf: \/home\/agent/)
  assert.ok(!r.prompt.includes('bad.pdf'))
})
