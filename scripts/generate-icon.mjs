/*
 * Generates build/icon.png — the packaging icon electron-builder derives every
 * platform icon from (.ico for NSIS, .icns for the dmg, sized PNGs for Linux).
 *
 * This is a placeholder mark, not a designed identity: a vault door, because a coffer
 * is a strongbox and the product's one non-negotiable is that the books are encrypted
 * at rest. It is generated rather than committed as an opaque binary so that the shape
 * and the palette are reviewable, and so replacing it with real artwork is a matter of
 * dropping in a 1024×1024 PNG at the same path and deleting this file.
 *
 *   node scripts/generate-icon.mjs
 *
 * Written with nothing but node:zlib so packaging needs no image toolchain.
 */

import process from 'node:process'
import console from 'node:console'
import path from 'node:path'
import fs from 'node:fs'
import zlib from 'node:zlib'
import { Buffer } from 'node:buffer'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = path.join(ROOT, 'build', 'icon.png')

/** Final image edge, in pixels. 1024 is what electron-builder wants to downscale from. */
const SIZE = 1024
/** Samples per axis per pixel. 4 gives 16 coverage levels, which is enough for edges. */
const SUPERSAMPLE = 4

const INK_TOP = [0x1d, 0x27, 0x36]
const INK_BOTTOM = [0x0c, 0x11, 0x18]
const DOOR_TOP = [0x27, 0x33, 0x46]
const DOOR_BOTTOM = [0x18, 0x21, 0x2e]
const BOLT = [0x3d, 0x4c, 0x63]
const BRASS_TOP = [0xf0, 0xc4, 0x72]
const BRASS_BOTTOM = [0xc8, 0x8f, 0x33]
const KEYWAY = [0x10, 0x16, 0x1f]

const TAU = Math.PI * 2

function mix(a, b, t) {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t
  return [
    a[0] + (b[0] - a[0]) * clamped,
    a[1] + (b[1] - a[1]) * clamped,
    a[2] + (b[2] - a[2]) * clamped,
  ]
}

/** Signed distance to a rounded rectangle centred on the origin. Negative is inside. */
function roundedRect(x, y, halfWidth, halfHeight, radius) {
  const dx = Math.abs(x) - (halfWidth - radius)
  const dy = Math.abs(y) - (halfHeight - radius)
  const outsideX = Math.max(dx, 0)
  const outsideY = Math.max(dy, 0)
  return Math.hypot(outsideX, outsideY) + Math.min(Math.max(dx, dy), 0) - radius
}

function circle(x, y, radius) {
  return Math.hypot(x, y) - radius
}

/** Signed distance to a bar through the origin, rotated by `angle`. */
function spoke(x, y, angle, halfLength, halfWidth) {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return roundedRect(x * cos + y * sin, -x * sin + y * cos, halfLength, halfWidth, halfWidth)
}

/**
 * Colour of one sample, in design coordinates where the image spans 0…SIZE.
 * Returns null where the icon is transparent.
 */
function sample(px, py) {
  const x = px - SIZE / 2
  const y = py - SIZE / 2
  const vertical = py / SIZE

  let colour = null

  /* The plate: a squircle, so the icon reads well inside macOS's rounded mask. */
  if (roundedRect(x, y, 486, 486, 232) < 0) colour = mix(INK_TOP, INK_BOTTOM, vertical)
  if (colour === null) return null

  /* The door face, inset far enough to leave a visible frame at 32px. */
  if (roundedRect(x, y, 392, 392, 168) < 0) colour = mix(DOOR_TOP, DOOR_BOTTOM, vertical)

  /* Four bolts at the corners of the door. */
  for (const bx of [-286, 286]) {
    for (const by of [-286, 286]) {
      if (circle(x - bx, y - by, 27) < 0) colour = BOLT
    }
  }

  const brass = mix(BRASS_TOP, BRASS_BOTTOM, vertical)

  /* The dial ring. */
  if (Math.abs(circle(x, y, 196)) - 21 < 0) colour = brass

  /* Eight arms of the handle, drawn as four bars through the centre. */
  for (let i = 0; i < 4; i += 1) {
    if (spoke(x, y, (i * TAU) / 8, 244, 18) < 0) colour = brass
  }

  /* Hub and keyway. */
  if (circle(x, y, 78) < 0) colour = brass
  if (circle(x, y, 34) < 0) colour = KEYWAY

  return colour
}

function render() {
  /* One filter byte (0 = none) per row, then RGBA. */
  const stride = SIZE * 4 + 1
  const raw = Buffer.alloc(stride * SIZE)
  const step = 1 / SUPERSAMPLE
  const samplesPerPixel = SUPERSAMPLE * SUPERSAMPLE

  for (let row = 0; row < SIZE; row += 1) {
    let offset = row * stride + 1
    for (let column = 0; column < SIZE; column += 1) {
      let r = 0
      let g = 0
      let b = 0
      let covered = 0

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        const py = row + (sy + 0.5) * step
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const colour = sample(column + (sx + 0.5) * step, py)
          if (colour === null) continue
          r += colour[0]
          g += colour[1]
          b += colour[2]
          covered += 1
        }
      }

      if (covered === 0) {
        offset += 4
        continue
      }

      /* Premultiplication is wrong for PNG, so average colour over covered samples
       * only and let alpha carry the coverage. */
      raw[offset] = Math.round(r / covered)
      raw[offset + 1] = Math.round(g / covered)
      raw[offset + 2] = Math.round(b / covered)
      raw[offset + 3] = Math.round((covered / samplesPerPixel) * 255)
      offset += 4
    }
  }

  return raw
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePng(raw) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(SIZE, 0)
  header.writeUInt32BE(SIZE, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  header[10] = 0 // deflate
  header[11] = 0 // adaptive filtering
  header[12] = 0 // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const png = encodePng(render())
fs.mkdirSync(path.dirname(OUTPUT), { recursive: true })
fs.writeFileSync(OUTPUT, png)
console.log(`[icon] wrote ${path.relative(ROOT, OUTPUT)} — ${SIZE}×${SIZE}, ${png.length} bytes`)
process.exit(0)
