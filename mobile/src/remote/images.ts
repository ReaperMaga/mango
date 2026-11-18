import { toBase64, utf8Decode } from './bytes'
import type { Output } from './git'

/**
 * Pictures in an agent's reply, read inside the environment: a port of the desktop's
 * `images.rs` (`remote`). Agents there save screenshots wherever suits them (a temp folder, the
 * project), so the path is not confined to a folder; instead only real raster images are shown:
 * the file's own bytes must say PNG, JPEG, GIF, WebP, AVIF or BMP, whatever its name. Anything
 * else is refused, so this cannot be used to read other files. Web addresses are never fetched.
 */

/** Larger pictures are not shown in a chat. Lower than the desktop's 25 MB: the phone holds them in memory, base64. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** A picture read from the environment. */
export interface ChatPicture {
  /** The whole file, base64. */
  data: string
  /** From the file's bytes, not its name. */
  mime: string
  size: number
}

const MISSING = 10
const NOT_FILE = 13
const MARK = '\0mango-fs\0'

/**
 * The desktop's `images::remote::READ`, unchanged. `$1`: the path, absolute or relative to the
 * project (the working folder); `$2`: the size limit. Prints `<size> <mtime ms>\n`, then the
 * file's bytes unless it is larger. Runs as the agent user, so it reads only what that user may
 * read; `parsePicture` decides what is shown.
 */
export const IMAGE_READ = `printf '\\000mango-fs\\000'
p=$1
[ -e "$p" ] || exit 10
[ -f "$p" ] || exit 13
size=$(stat -L -c %s -- "$p") || exit 1
m=$(stat -L -c %Y -- "$p") || exit 1
printf '%s %s000\\n' "$size" "$m"
[ "$size" -gt "$2" ] && exit 0
exec cat -- "$p"
`

/** A path the script can take as one argument; throws otherwise. */
export function checkedPicturePath(path: string): string {
  if (!path.trim() || /[\0\n\r]/.test(path)) throw new Error('No picture path given')
  return path
}

/** The image type the bytes start with; null for anything that is not a raster image. */
export function sniffImage(b: Uint8Array): string | null {
  const at = (i: number, sig: number[] | string) => {
    const bytes = typeof sig === 'string' ? [...sig].map(c => c.charCodeAt(0)) : sig
    return b.length >= i + bytes.length && bytes.every((v, k) => b[i + k] === v)
  }
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return 'image/gif'
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp'
  if (at(4, 'ftyp') && (at(8, 'avif') || at(8, 'avis'))) return 'image/avif'
  // "BM" alone is too weak a mark; the header must also state the file's real length.
  if (at(0, 'BM') && b.length >= 26 && (b[2]! | (b[3]! << 8) | (b[4]! << 16) | (b[5]! << 24)) >>> 0 === b.length) return 'image/bmp'
  return null
}

function tooLarge(path: string, size: number): string {
  return `${path} is ${Math.floor(size / (1024 * 1024))} MB; pictures up to ${MAX_IMAGE_BYTES / (1024 * 1024)} MB are shown in a chat`
}

/** Turn the script's answer into the picture, or why it is not one (the desktop's `remote::parse`). */
export function parsePicture(path: string, out: Output): ChatPicture {
  if (out.code === MISSING) throw new Error(`Could not read ${path}: it does not exist in the environment`)
  if (out.code === NOT_FILE) throw new Error(`${path} is not a file`)
  const unexpected = () => new Error(`Could not read ${path}: the environment gave an answer Mango does not understand`)
  const raw = out.stdout
  // The mark is ASCII, so finding it in the bytes read as Latin-1 finds it at the same offset.
  let at = -1
  for (let i = 0; i + MARK.length <= raw.length && at < 0; i++) {
    let k = 0
    while (k < MARK.length && raw[i + k] === MARK.charCodeAt(k)) k++
    if (k === MARK.length) at = i + MARK.length
  }
  if (at < 0) {
    const reason = utf8Decode(out.stderr).trim()
    if (out.code !== 0 && reason) throw new Error(`Could not read ${path}: ${reason}`)
    throw unexpected()
  }
  const body = raw.subarray(at)
  const nl = body.indexOf(0x0a)
  const m = nl < 0 ? null : /^(\d+) (\d+)$/.exec(utf8Decode(body.subarray(0, nl)))
  if (!m) throw unexpected()
  const size = Number(m[1])
  const bytes = body.subarray(nl + 1)
  if (size > MAX_IMAGE_BYTES || out.truncated || bytes.length > MAX_IMAGE_BYTES) throw new Error(tooLarge(path, Math.max(size, bytes.length)))
  if (bytes.length !== size) throw new Error(`Could not read ${path}: it changed while it was read. Try again.`)
  const mime = sniffImage(bytes)
  if (!mime) throw new Error(`${path} is not a PNG, JPEG, GIF, WebP, AVIF or BMP picture`)
  return { data: toBase64(bytes), mime, size }
}
