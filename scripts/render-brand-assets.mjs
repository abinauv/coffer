/*
 * Renders the launch images from the brand sheet (§07), and the installer artwork cut from
 * the same banner:
 *
 *   docs/assets/banner.png          1280 × 320   committed, shown at the top of the README
 *   dist/brand/social-preview.png   1280 × 640   NOT committed — uploaded by hand in the
 *                                                repository's Settings → Social preview,
 *                                                which the GitHub API cannot set
 *   build/installerSidebar.bmp       164 × 314   the Windows installer's welcome and finish
 *                                                pages (and the uninstaller's, by default)
 *   build/installerHeader.bmp        150 × 57    the right end of every other installer page
 *   build/background.png             540 × 380   the macOS disk image's window, with
 *   build/background@2x.png         1080 × 760   its Retina pair; electron-builder joins the
 *                                                two into one TIFF on the Mac that packages it
 *
 * ELECTRON-BUILDER FINDS ALL FOUR BY NAME in build/, so electron-builder.yml names none of
 * them. The installer images carry NO TEXT (docs/design.md): the installer writes its own
 * words beside them, in the user's language and at the user's scale, and a word baked into
 * a bitmap is one nobody can translate or read at 200%. The NSIS images are 24-bit BMP,
 * the one format its wizard pages load, written by `bmp()` below because Chromium has no
 * BMP encoder.
 *
 * Both are laid out in HTML and captured from an offscreen Electron window, so the text is
 * set in the IBM Plex files the app bundles (src/renderer/src/assets/fonts) rather than in
 * whatever fonts the machine running this happens to have, and the mark is drawn from
 * src/shared/brand-mark.ts, the same numbers as the title bar and the packaging icon.
 * Nothing is fetched: the page loads only the local font files and has no script.
 *
 *   npm run brand:assets
 *
 * Run it after changing the mark, the palette, the tagline or the copy below. The text is
 * the brand sheet's; BRAND.name and BRAND.tagline come from src/branding.ts.
 *
 * Electron runs this file as its main process and imports the TypeScript modules directly
 * (Node 24 inside Electron strips types). `ELECTRON_RUN_AS_NODE` must not be set, or
 * Electron starts as plain Node and there is no window to capture.
 */

import { Buffer } from 'node:buffer'
import console from 'node:console'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout } from 'node:timers'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow } from 'electron'
import { BRAND } from '../src/branding.ts'
import { MARK_GRID, MARK_OUTER, markSvg } from '../src/shared/brand-mark.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FONTS = path.join(ROOT, 'src', 'renderer', 'src', 'assets', 'fonts')
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'coffer-brand-'))

/* Values from styles/tokens.css, named so a palette change is easy to carry over. The
 * images are not themed, so they take fixed colours rather than reading the stylesheet. */
const PALETTE = {
  lapis: '#3a3d9e', // --accent (light)
  lapisLine: '#d3d5f0', // --accent-line (light)
  slateGround: '#0e1216', // --ground (dark)
  slateAccent: '#a2aefb', // --accent (dark)
  slateAccentSoft: '#1a1e3d', // --accent-soft (dark)
  slateAccentInk: '#b6befc', // --accent-ink (dark)
  slateInk: '#e6eaf0', // --ink (dark)
  slateInkStrong: '#f8fafc', // --ink-strong (dark)
  slateInkMuted: '#9ca6b4', // --ink-muted (dark)
  slateRuleTotal: '#3a4450', // --rule-total (dark)
  white: '#ffffff',
  paper: '#f5f3ee', // --ground (light)
  lapisArrow: 'rgba(58, 61, 158, 0.55)', // --accent (light), half strength on Paper
}

const fontFace = (family, weight, file) => `
  @font-face {
    font-family: '${family}';
    font-weight: ${weight};
    font-display: block;
    src: url('${pathToFileURL(path.join(FONTS, file)).href}') format('woff2');
  }`

const FONT_FACES = [
  fontFace('IBM Plex Sans', 400, 'IBMPlexSans-Regular.woff2'),
  fontFace('IBM Plex Serif', 600, 'IBMPlexSerif-SemiBold.woff2'),
  fontFace('IBM Plex Mono', 400, 'IBMPlexMono-Regular.woff2'),
].join('\n')

/* The mark's box includes its own clear space. Pulling it left by the outer inset lines
 * the visible frame up with the text beside or below it. */
const markInset = (size) => (size * MARK_OUTER.inset) / MARK_GRID

function page(width, height, css, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src file:; img-src data:">
<style>
${FONT_FACES}
* { box-sizing: border-box; }
html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; }
body { font-family: 'IBM Plex Sans', sans-serif; -webkit-font-smoothing: antialiased; }
${css}
</style>
</head>
<body>${body}</body>
</html>`
}

const BANNER_MARK = 160

const banner = {
  name: 'banner',
  background: PALETTE.lapis,
  fonts: ['IBM Plex Sans', 'IBM Plex Serif'],
  width: 1280,
  height: 320,
  output: path.join(ROOT, 'docs', 'assets', 'banner.png'),
  html: page(
    1280,
    320,
    `
    .banner { position: relative; width: 100%; height: 100%; background: ${PALETTE.lapis};
      display: flex; align-items: center; gap: 44px; padding: 0 88px; }
    .lines { position: absolute; inset: 0;
      background: repeating-linear-gradient(90deg, transparent 0 63px, rgba(255, 255, 255, 0.06) 63px 64px); }
    .mark { position: relative; flex: none; margin-left: ${-markInset(BANNER_MARK)}px; display: block; }
    .words { position: relative; display: flex; flex-direction: column; gap: 12px; }
    .name { font-family: 'IBM Plex Serif', serif; font-weight: 600; font-size: 60px;
      letter-spacing: -0.02em; line-height: 1; color: ${PALETTE.white}; }
    .tagline { font-size: 24px; color: ${PALETTE.lapisLine}; }
    `,
    `<div class="banner">
      <div class="lines"></div>
      <span class="mark">${markSvg(BANNER_MARK, PALETTE.white)}</span>
      <div class="words">
        <div class="name">${BRAND.name}</div>
        <div class="tagline">${BRAND.tagline}</div>
      </div>
    </div>`,
  ),
}

const SOCIAL_MARK = 96

const socialPreview = {
  name: 'social preview',
  background: PALETTE.slateGround,
  fonts: ['IBM Plex Sans', 'IBM Plex Serif', 'IBM Plex Mono'],
  width: 1280,
  height: 640,
  output: path.join(ROOT, 'dist', 'brand', 'social-preview.png'),
  html: page(
    1280,
    640,
    `
    .card { position: relative; width: 100%; height: 100%; background: ${PALETTE.slateGround};
      display: flex; flex-direction: column; justify-content: center; gap: 32px; padding: 0 104px; }
    .grid { position: absolute; inset: 0;
      background:
        repeating-linear-gradient(0deg, transparent 0 55px, rgba(162, 174, 251, 0.07) 55px 56px),
        repeating-linear-gradient(90deg, transparent 0 55px, rgba(162, 174, 251, 0.07) 55px 56px); }
    .lockup { position: relative; display: flex; align-items: center; gap: 20px; }
    .mark { flex: none; margin-left: ${-markInset(SOCIAL_MARK)}px; display: block; }
    .name { font-family: 'IBM Plex Serif', serif; font-weight: 600; font-size: 64px;
      letter-spacing: -0.02em; line-height: 1; color: ${PALETTE.slateInkStrong}; }
    .claim { position: relative; display: flex; flex-direction: column; gap: 18px; }
    .headline { font-size: 38px; line-height: 1.3; color: ${PALETTE.slateInk}; max-width: 26ch; }
    .sub { font-size: 23px; color: ${PALETTE.slateInkMuted}; }
    .chips { position: relative; display: flex; gap: 12px; flex-wrap: wrap;
      font-family: 'IBM Plex Mono', monospace; font-size: 18px; }
    .chip { padding: 8px 18px; border-radius: 999px; border: 1px solid ${PALETTE.slateRuleTotal};
      color: ${PALETTE.slateInkMuted}; }
    .chip--licence { border-color: transparent; background: ${PALETTE.slateAccentSoft};
      color: ${PALETTE.slateAccentInk}; }
    `,
    `<div class="card">
      <div class="grid"></div>
      <div class="lockup">
        <span class="mark">${markSvg(SOCIAL_MARK, PALETTE.slateAccent)}</span>
        <div class="name">${BRAND.name}</div>
      </div>
      <div class="claim">
        <div class="headline">Free, offline GST accounting for small businesses in India.</div>
        <div class="sub">Double-entry books and inventory, in one encrypted file you own.</div>
      </div>
      <div class="chips">
        <span class="chip">no account</span>
        <span class="chip">no subscription</span>
        <span class="chip">no telemetry</span>
        <span class="chip chip--licence">AGPL-3.0</span>
      </div>
    </div>`,
  ),
}

/* ---- Installer artwork ------------------------------------------------------------------
 *
 * The sidebar is a slice of the banner: Lapis, the same faint rules, the mark reversed white.
 * The header sits at the right of a white wizard header, so it is white with the mark in
 * Lapis. The disk-image background is Paper, because Finder draws the icon names in black
 * on top of it, and the one mark on it is an arrow from the app to Applications.
 */

const SIDEBAR_MARK = 72

const installerSidebar = {
  name: 'installer sidebar',
  background: PALETTE.lapis,
  fonts: [],
  width: 164,
  height: 314,
  output: path.join(ROOT, 'build', 'installerSidebar.bmp'),
  format: 'bmp',
  html: page(
    164,
    314,
    `
    .side { position: relative; width: 100%; height: 100%; background: ${PALETTE.lapis}; }
    .lines { position: absolute; inset: 0;
      background: repeating-linear-gradient(90deg, transparent 0 31px, rgba(255, 255, 255, 0.06) 31px 32px); }
    .mark { position: absolute; left: ${(164 - SIDEBAR_MARK) / 2}px; top: 96px; display: block; }
    `,
    `<div class="side"><div class="lines"></div>
      <span class="mark">${markSvg(SIDEBAR_MARK, PALETTE.white)}</span></div>`,
  ),
}

const HEADER_MARK = 36

const installerHeader = {
  name: 'installer header',
  background: PALETTE.white,
  fonts: [],
  width: 150,
  height: 57,
  output: path.join(ROOT, 'build', 'installerHeader.bmp'),
  format: 'bmp',
  html: page(
    150,
    57,
    `
    .head { position: relative; width: 100%; height: 100%; background: ${PALETTE.white}; }
    .mark { position: absolute; left: 102px; top: 10px; display: block; }
    `,
    `<div class="head"><span class="mark">${markSvg(HEADER_MARK, PALETTE.lapis)}</span></div>`,
  ),
  /* White is also the colour a new window starts as, so a white corner proves nothing. This
   * pixel is inside the mark's left stroke (x 4.5 to 6.75 of 36, half way down). */
  probe: { x: 107, y: 28 },
}

/* Finder places the two icons at x 140 and 400, y 200 (dmg.contents in electron-builder.yml),
 * measured to their centres. The arrow runs between them, clear of both. */
function diskImageBackground(scale) {
  const s = (value) => value * scale
  return {
    name: scale === 1 ? 'disk image background' : 'disk image background @2x',
    background: PALETTE.paper,
    fonts: [],
    width: s(540),
    height: s(380),
    output: path.join(ROOT, 'build', scale === 1 ? 'background.png' : 'background@2x.png'),
    format: 'png',
    html: page(
      s(540),
      s(380),
      `
      .dmg { position: relative; width: 100%; height: 100%; background: ${PALETTE.paper}; }
      .band { position: absolute; left: 0; right: 0; bottom: 0; height: ${s(6)}px; background: ${PALETTE.lapis}; }
      .arrow { position: absolute; left: ${s(222)}px; top: ${s(199)}px; width: ${s(96)}px;
        height: ${s(2)}px; background: ${PALETTE.lapisArrow}; }
      .arrow::after { content: ''; position: absolute; right: 0; top: ${-s(5)}px;
        width: ${s(12)}px; height: ${s(12)}px; border-top: ${s(2)}px solid ${PALETTE.lapisArrow};
        border-right: ${s(2)}px solid ${PALETTE.lapisArrow}; transform: rotate(45deg); }
      `,
      `<div class="dmg"><div class="band"></div><div class="arrow"></div></div>`,
    ),
  }
}

/**
 * A 24-bit, bottom-up, uncompressed BMP from a Chromium bitmap.
 *
 * `order` says where red and blue sit in each four-byte pixel, which differs by platform and
 * is read off a known pixel rather than assumed (`channelOrder`).
 */
function bmp(bitmap, width, height, order) {
  const rowSize = Math.ceil((width * 3) / 4) * 4
  const pixels = rowSize * height
  const file = Buffer.alloc(54 + pixels)
  file.write('BM', 0, 'ascii')
  file.writeUInt32LE(file.length, 2)
  file.writeUInt32LE(54, 10)
  file.writeUInt32LE(40, 14)
  file.writeInt32LE(width, 18)
  file.writeInt32LE(height, 22)
  file.writeUInt16LE(1, 26)
  file.writeUInt16LE(24, 28)
  file.writeUInt32LE(0, 30)
  file.writeUInt32LE(pixels, 34)
  file.writeInt32LE(2835, 38)
  file.writeInt32LE(2835, 42)
  for (let y = 0; y < height; y += 1) {
    const target = 54 + (height - 1 - y) * rowSize
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 4
      file[target + x * 3] = bitmap[source + (order === 'bgra' ? 0 : 2)]
      file[target + x * 3 + 1] = bitmap[source + 1]
      file[target + x * 3 + 2] = bitmap[source + (order === 'bgra' ? 2 : 0)]
    }
  }
  return file
}

/** Which way round a bitmap's channels are, from a corner known to be `hex` (not a grey). */
function channelOrder(image, hex) {
  const want = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
  const px = image.crop({ x: 4, y: 4, width: 1, height: 1 }).toBitmap()
  const near = (values) => values.every((value, i) => Math.abs(value - want[i]) <= 2)
  if (near([px[2], px[1], px[0]])) return 'bgra'
  if (near([px[0], px[1], px[2]])) return 'rgba'
  throw new Error(`the corner is not ${hex}, so the channel order cannot be read`)
}

/* Read once, from the Lapis sidebar, and used for every BMP after it. A white corner could
 * not tell the two orders apart. */
let bitmapOrder = null

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** True when the pixel just inside the top-left corner is `hex`, within a rounding step. */
function cornerIs(image, hex, at = { x: 4, y: 4 }) {
  const want = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
  const px = image.crop({ x: at.x, y: at.y, width: 1, height: 1 }).toBitmap()
  /* The bitmap is BGRA on Windows and Linux and RGBA elsewhere; accept either order. */
  const near = (order) => order.every((value, i) => Math.abs(value - want[i]) <= 2)
  return near([px[2], px[1], px[0]]) || near([px[0], px[1], px[2]])
}

async function capture(asset) {
  const file = path.join(WORK, `${asset.name.replace(/\s+/g, '-')}.html`)
  fs.writeFileSync(file, asset.html)

  const window = new BrowserWindow({
    show: false,
    width: asset.width,
    height: asset.height,
    useContentSize: true,
    frame: false,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  /* Offscreen windows report every frame. Keep the latest one that has pixels in it. */
  let latest = null
  window.webContents.on('paint', (_event, _dirty, frame) => {
    if (!frame.isEmpty()) latest = frame
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[brand] ${asset.name}: renderer gone (${details.reason})`)
  })

  try {
    await window.loadFile(file)
    /* Page script is off by the page's own CSP; this runs in an isolated world and only
     * waits for the bundled faces, so no frame is captured in a fallback font. */
    const families = await window.webContents.executeJavaScript(
      `document.fonts.ready.then(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family))`,
    )
    /* A face loads only when text on the page uses it, so each image names its own. */
    for (const family of asset.fonts) {
      if (!families.includes(family)) throw new Error(`${asset.name}: ${family} did not load`)
    }
    /* The frame is taken from the offscreen `paint` event rather than `capturePage()`, which
     * fails in offscreen mode on Windows ("UnknownVizError"). The first frames a new window
     * paints can still be the blank white it starts with, so a frame is accepted only once
     * its corner is the page's own background colour. */
    let image = null
    for (let attempt = 0; attempt < 40 && image === null; attempt += 1) {
      window.webContents.invalidate()
      await delay(150)
      if (
        latest !== null &&
        cornerIs(latest, asset.background) &&
        (asset.probe === undefined || !cornerIs(latest, asset.background, asset.probe))
      ) {
        image = latest
      }
    }
    if (image === null) throw new Error(`${asset.name}: never painted its background`)
    /* A frameless window can still paint a pixel or two of border beyond its content size.
     * Cropping keeps every pixel of the layout at 1:1; resizing would soften the text. */
    const { width, height } = image.getSize()
    if (width < asset.width || height < asset.height) {
      throw new Error(`${asset.name}: painted ${width}×${height}, smaller than the image`)
    }
    if (width !== asset.width || height !== asset.height) {
      image = image.crop({ x: 0, y: 0, width: asset.width, height: asset.height })
    }

    fs.mkdirSync(path.dirname(asset.output), { recursive: true })
    if (asset.format === 'bmp' && bitmapOrder === null) {
      bitmapOrder = channelOrder(image, asset.background)
    }
    const bytes =
      asset.format === 'bmp'
        ? bmp(image.toBitmap(), asset.width, asset.height, bitmapOrder)
        : image.toPNG()
    fs.writeFileSync(asset.output, bytes)
    console.log(
      `[brand] wrote ${path.relative(ROOT, asset.output)} — ${asset.width}×${asset.height}, ${bytes.length} bytes`,
    )
  } finally {
    window.destroy()
  }
}

/* Keep Electron's profile out of the user's application-data folder. */
app.setPath('userData', path.join(WORK, 'profile'))
app.disableHardwareAcceleration()
/* Each image gets its own window, destroyed when captured. Without a listener here,
 * destroying the first one closes the last window, Electron starts quitting, and the next
 * page load is aborted. */
app.on('window-all-closed', () => {})

app
  .whenReady()
  .then(async () => {
    await capture(banner)
    await capture(socialPreview)
    /* The sidebar before the header: its Lapis corner is what the BMP channel order is read
     * from. */
    await capture(installerSidebar)
    await capture(installerHeader)
    await capture(diskImageBackground(1))
    await capture(diskImageBackground(2))
  })
  .then(
    () => {
      /* Chromium still holds the profile open, so the temporary folder is left for the OS to
       * clear rather than failing the run on a lock. */
      try {
        fs.rmSync(WORK, { recursive: true, force: true })
      } catch {
        /* ignored */
      }
      app.exit(0)
    },
    (error) => {
      console.error('[brand] failed:', error)
      process.exitCode = 1
      app.exit(1)
    },
  )
