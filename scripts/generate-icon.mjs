/*
 * Generates build/icon.png — the packaging icon electron-builder derives every
 * platform icon from (.ico for NSIS, .icns for the dmg, sized PNGs for Linux).
 *
 * The designed application icon (brand sheet §02): the mark, reversed white on Lapis,
 * as one flat 1024×1024 square with 12% padding around the mark's 24-unit box. No platform
 * mask and no gradient are baked in — macOS applies its own rounded mask and shading, and
 * Windows and Linux show the square as drawn.
 *
 * The mark's shape is not written here. It is read from src/shared/brand-mark.ts, the
 * same numbers the title bar's SVG and the README banner are drawn from, so the icon
 * cannot drift from the mark. This file only rasterises it.
 *
 * build/icon.png is committed, so packaging needs nothing but a checkout. This script is
 * how that file is made: after any change to the mark or to Lapis, run it and commit the
 * result. Keeping the generator rather than only the PNG keeps the icon reviewable and
 * reproducible. Written with nothing but node:zlib, so no image toolchain is involved.
 *
 *   node scripts/generate-icon.mjs            writes build/icon.png
 *   node scripts/generate-icon.mjs out.png    writes somewhere else
 *
 * Node imports the TypeScript module directly: type stripping is on by default from
 * Node 22.18, and .nvmrc pins 22.
 */

import process from 'node:process'
import console from 'node:console'
import path from 'node:path'
import fs from 'node:fs'
import zlib from 'node:zlib'
import { Buffer } from 'node:buffer'
import { fileURLToPath } from 'node:url'
import { MARK_GRID, markShapes } from '../src/shared/brand-mark.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = path.resolve(process.argv[2] ?? path.join(ROOT, 'build', 'icon.png'))

/** Final image edge, in pixels. 1024 is what electron-builder wants to downscale from. */
const SIZE = 1024
/** Samples per axis per pixel. 4 gives 16 coverage levels, which is enough for edges. */
const SUPERSAMPLE = 4
/** Space between the icon's edge and the mark's 24-unit box, as a share of the edge. */
const PADDING = 0.12

/** --accent in light, and the brand's primary colour. */
const LAPIS = [0x3a, 0x3d, 0x9e]
const WHITE = [0xff, 0xff, 0xff]

const MARK_PX = SIZE * (1 - PADDING * 2)
const MARK_ORIGIN = SIZE * PADDING
const SCALE = MARK_PX / MARK_GRID

/* Every shape, converted from grid units to pixels once. */
const shapes = markShapes(MARK_PX)
const toPx = (rect) => ({
  cx: MARK_ORIGIN + (rect.x + rect.size / 2) * SCALE,
  cy: MARK_ORIGIN + (rect.y + rect.size / 2) * SCALE,
  half: (rect.size / 2) * SCALE,
  radius: rect.radius * SCALE,
})
const FRAMES = [
  { outside: toPx(shapes.outer.outside), hole: toPx(shapes.outer.hole) },
  shapes.inner.solid
    ? { outside: toPx(shapes.inner.outside), hole: null }
    : { outside: toPx(shapes.inner.outside), hole: toPx(shapes.inner.hole) },
]

/** Signed distance to a rounded square. Negative is inside. */
function roundedSquare(px, py, { cx, cy, half, radius }) {
  const dx = Math.abs(px - cx) - (half - radius)
  const dy = Math.abs(py - cy) - (half - radius)
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius
}

/** The mark covers a sample when it is inside a frame's outside edge and not in its hole. */
function isMark(px, py) {
  for (const frame of FRAMES) {
    if (roundedSquare(px, py, frame.outside) >= 0) continue
    if (frame.hole === null || roundedSquare(px, py, frame.hole) >= 0) return true
  }
  return false
}

function render() {
  /* One filter byte (0 = none) per row, then RGB. The square is opaque edge to edge. */
  const stride = SIZE * 3 + 1
  const raw = Buffer.alloc(stride * SIZE)
  const step = 1 / SUPERSAMPLE
  const samplesPerPixel = SUPERSAMPLE * SUPERSAMPLE

  for (let row = 0; row < SIZE; row += 1) {
    let offset = row * stride + 1
    for (let column = 0; column < SIZE; column += 1) {
      let covered = 0
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        const py = row + (sy + 0.5) * step
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          if (isMark(column + (sx + 0.5) * step, py)) covered += 1
        }
      }

      const t = covered / samplesPerPixel
      for (let channel = 0; channel < 3; channel += 1) {
        raw[offset + channel] = Math.round(LAPIS[channel] + (WHITE[channel] - LAPIS[channel]) * t)
      }
      offset += 3
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
  header[9] = 2 // colour type: RGB, since the icon has no transparent pixel
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
