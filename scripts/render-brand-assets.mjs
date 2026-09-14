/*
 * Renders the two launch images from the brand sheet (§07):
 *
 *   docs/assets/banner.png          1280 × 320   committed, shown at the top of the README
 *   dist/brand/social-preview.png   1280 × 640   NOT committed — uploaded by hand in the
 *                                                repository's Settings → Social preview,
 *                                                which the GitHub API cannot set
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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** True when the pixel just inside the top-left corner is `hex`, within a rounding step. */
function cornerIs(image, hex) {
  const want = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
  const px = image.crop({ x: 4, y: 4, width: 1, height: 1 }).toBitmap()
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
      if (latest !== null && cornerIs(latest, asset.background)) image = latest
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
    const png = image.toPNG()
    fs.writeFileSync(asset.output, png)
    console.log(
      `[brand] wrote ${path.relative(ROOT, asset.output)} — ${asset.width}×${asset.height}, ${png.length} bytes`,
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
