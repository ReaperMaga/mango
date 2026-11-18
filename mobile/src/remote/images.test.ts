/// <reference types="node" />
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { BATCH, batchArgs, parseBatch } from './git'
import { IMAGE_READ, MAX_IMAGE_BYTES, checkedPicturePath, parsePicture, sniffImage } from './images'
import { utf8Encode } from './bytes'

/**
 * Pictures in replies, read inside the environment: the script run by this computer's `bash`
 * through the same batch runner the backend uses (the desktop's `reads_pictures_inside_an_environment`).
 */

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52])
const scratch: string[] = []
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }) })

function read(root: string, path: string) {
  const file = checkedPicturePath(path)
  const cap = MAX_IMAGE_BYTES + 256
  const r = spawnSync('bash', ['-c', BATCH, 'mango', ...batchArgs([{ argv: ['sh', '-c', IMAGE_READ, 'sh', file, String(MAX_IMAGE_BYTES)], cap }])], { cwd: root, encoding: 'utf8' })
  const [out] = parseBatch(r.stdout, [cap])!
  return parsePicture(file, out!)
}

describe('pictures in replies', () => {
  it('knows images by their bytes, not their names', () => {
    expect(sniffImage(PNG)).toBe('image/png')
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImage(utf8Encode('GIF89a\u0001'))).toBe('image/gif')
    expect(sniffImage(utf8Encode('RIFF$\u0000\u0000\u0000WEBPVP8 '))).toBe('image/webp')
    expect(sniffImage(Uint8Array.from([0, 0, 0, 0x1c, ...utf8Encode('ftypavif'), 0, 0, 0, 0]))).toBe('image/avif')
    expect(sniffImage(utf8Encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(sniffImage(utf8Encode('-----BEGIN OPENSSH PRIVATE KEY-----'))).toBeNull()
    expect(sniffImage(new Uint8Array())).toBeNull()
    const bmp = new Uint8Array(30)
    bmp.set([0x42, 0x4d, 30, 0, 0, 0])
    expect(sniffImage(bmp)).toBe('image/bmp')
    expect(sniffImage(utf8Encode('BM is how this note starts, and it is long enough'))).toBeNull()
  })

  it('reads absolute and project-relative pictures, and refuses everything else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mango-images-'))
    scratch.push(dir)
    const root = join(dir, 'proj')
    mkdirSync(root)
    writeFileSync(join(dir, 'shot.png'), PNG)
    writeFileSync(join(root, 'local.png'), PNG)
    writeFileSync(join(root, 'key.png'), '-----BEGIN OPENSSH PRIVATE KEY-----')

    const img = read(root, join(dir, 'shot.png'))
    expect(img.mime).toBe('image/png')
    expect(img.size).toBe(PNG.length)
    expect(Buffer.from(img.data, 'base64').equals(Buffer.from(PNG))).toBe(true)
    expect(read(root, 'local.png').data).toBe(img.data)
    expect(() => read(root, 'key.png')).toThrow('is not a PNG')
    expect(() => read(root, 'nope.png')).toThrow('does not exist')
    expect(() => read(root, '.')).toThrow('is not a file')
    // Odd names stay one argument: nothing runs, nothing is read.
    expect(() => read(root, '$(touch pwned).png')).toThrow('does not exist')
    expect(spawnSync('ls', [root], { encoding: 'utf8' }).stdout).not.toContain('pwned')
    expect(() => read(root, 'a\nb.png')).toThrow()
    expect(() => read(root, ' ')).toThrow()
  })

  it('checks the answer instead of trusting it', () => {
    const out = (s: string | Uint8Array, code = 0) => ({ code, stdout: typeof s === 'string' ? utf8Encode(s) : s, stderr: new Uint8Array(), truncated: false })
    expect(() => parsePicture('x', out(Uint8Array.from([...utf8Encode('\0mango-fs\0'), ...utf8Encode('99 0\n'), ...PNG])))).toThrow('changed while')
    expect(() => parsePicture('x', out('hello'))).toThrow('does not understand')
    expect(() => parsePicture('x', out(`\0mango-fs\0${MAX_IMAGE_BYTES + 1} 0\n`))).toThrow('MB')
    expect(() => parsePicture('x', { ...out('\0mango-fs\0'), truncated: true })).toThrow()
  })

  it('runs the same script as the desktop', () => {
    const rust = readFileSync(join(__dirname, '../../../src-tauri/src/images.rs'), 'utf8')
    const desktop = /pub\(crate\) const READ: &str = r#"([\s\S]*?)"#;/.exec(rust)?.[1]
    expect(desktop).toBe(IMAGE_READ)
  })
})
