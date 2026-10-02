// Renders the lobby sign page with headless Chrome and cuts it into picture tiles for Joan.
//
// Joan's e-ink playlists can't show a web page, but an RSS widget set to "Picture only, 1 article"
// shows one RSS item's image, and Joan keeps images up to 600 px wide at full size. So the sign is
// published as a grid of tiles, one RSS item per tile, in reading order (left to right, top to
// bottom). The widget for a tile uses Skip article(s) = the tile's position, starting at 0.
//
// A tile's file name and guid contain a hash of its pixels, so Joan only fetches the tiles that
// changed since the last run. The hash uses the 16 grey levels the display has, so rendering noise
// of a shade or two doesn't count as a change.
//
// Environment:
//   SIGN_HTML  page to render                     (default index.html)
//   OUT_DIR    folder to write into                (default _site)
//   BASE_URL   public URL of OUT_DIR               (default the lobby-sign Pages site)
//   GRIDS      comma-separated COLSxROWS grids     (default 5x3; each gets tiles-COLSxROWS.xml)
//   CHROME_PATH  Chrome binary                     (default: the usual Linux and macOS locations)

import puppeteer from 'puppeteer-core';
import { PNG } from 'pngjs';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const W = 2560, H = 1440; // Joan Place & Play 32
const SRC = process.env.SIGN_HTML || 'index.html';
const OUT = process.env.OUT_DIR || '_site';
const BASE = (process.env.BASE_URL || 'https://community-food-works.github.io/lobby-sign').replace(/\/+$/, '');
const GRIDS = (process.env.GRIDS || '5x3').split(',').map((g) => g.trim()).filter(Boolean).map((g) => {
  const m = /^(\d+)x(\d+)$/.exec(g);
  if (!m) throw new Error(`Bad grid "${g}". Use COLSxROWS, for example 5x3.`);
  const cols = Number(m[1]), rows = Number(m[2]);
  if (W % cols || H % rows) throw new Error(`Grid ${g} doesn't divide ${W}x${H} evenly.`);
  return { name: g, cols, rows, w: W / cols, h: H / rows };
});
const CHROME = process.env.CHROME_PATH || [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
if (!CHROME) throw new Error('Chrome not found. Set CHROME_PATH.');

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  // --no-sandbox: GitHub's Ubuntu runners block Chrome's sandbox. The only page loaded is our own.
  // --disable-gpu: software rendering gives the same pixels on every run.
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--font-render-hinting=none'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

  // The page pulls its fonts and the logo from the web. Try a few times before settling for fallbacks:
  // fresh numbers in a plainer font beat a stale sign.
  let ready = false;
  for (let attempt = 1; attempt <= 3 && !ready; attempt++) {
    await page.goto(pathToFileURL(resolve(SRC)).href, { waitUntil: 'networkidle0', timeout: 60_000 }).catch((e) => {
      console.warn(`Attempt ${attempt}: ${e.message}`);
    });
    ready = await page.evaluate(async () => {
      await document.fonts.ready;
      const imgs = [...document.images].every((i) => i.complete && i.naturalWidth > 0);
      const fonts = document.fonts.check('800 20px Archivo') && document.fonts.check('400 20px "Atkinson Hyperlegible"');
      return imgs && fonts;
    });
    if (!ready) console.warn(`Attempt ${attempt}: fonts or logo didn't load.`);
  }
  if (!ready) console.warn('Rendering with fallback fonts or without the logo.');

  // The display is 16-level greyscale. Render grey so nothing depends on Joan's colour conversion.
  await page.addStyleTag({ content: 'html { filter: grayscale(1); }' });

  // One screenshot, cut up here, so neighbouring tiles always line up.
  const shot = PNG.sync.read(Buffer.from(await page.screenshot({ type: 'png' })));
  if (shot.width !== W || shot.height !== H) throw new Error(`Screenshot is ${shot.width}x${shot.height}, expected ${W}x${H}.`);
  const grey = Buffer.alloc(W * H);
  for (let i = 0; i < W * H; i++) grey[i] = shot.data[i * 4];
  const toPng = (buf, w, h) => {
    const png = new PNG({ width: w, height: h, colorType: 0, inputColorType: 0, bitDepth: 8 });
    png.data = buf;
    return PNG.sync.write(png, { colorType: 0, inputColorType: 0, bitDepth: 8 });
  };

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'sign.png'), toPng(grey, W, H));

  const now = Date.now();
  const manifest = { rendered: new Date(now).toISOString(), ready, grids: {} };

  for (const g of GRIDS) {
    const dir = join(OUT, 'tiles', g.name);
    mkdirSync(dir, { recursive: true });
    const items = [];
    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++) {
        const tile = Buffer.alloc(g.w * g.h);
        for (let y = 0; y < g.h; y++) grey.copy(tile, y * g.w, (r * g.h + y) * W + c * g.w, (r * g.h + y) * W + (c + 1) * g.w);
        const png = toPng(tile, g.w, g.h);
        const hash = createHash('sha1').update(tile.map((v) => v >> 4)).digest('hex').slice(0, 10);
        const pos = `r${r + 1}c${c + 1}`;
        const file = `${pos}-${hash}.png`;
        writeFileSync(join(dir, file), png);
        items.push({ pos, hash, url: `${BASE}/tiles/${g.name}/${file}`, bytes: png.length });
      }
    }

    // Item dates step back a minute per tile, so the order is the same whether Joan keeps the feed's
    // order or sorts newest first.
    const body = items.map((t, i) => [
      '<item>',
      `<title>Tile ${i} (${t.pos}) ${now}</title>`,
      `<description>${g.w}x${g.h} at x ${(i % g.cols) * g.w}, y ${Math.floor(i / g.cols) * g.h}</description>`,
      `<link>${BASE}/?t=${now}-${i}</link>`,
      `<guid isPermaLink="false">lobby-sign-${g.name}-${t.pos}-${t.hash}-${now}</guid>`,
      `<pubDate>${new Date(now - i * 60_000).toUTCString()}</pubDate>`,
      `<enclosure url="${t.url}" length="${t.bytes}" type="image/png"/>`,
      `<media:content url="${t.url}" medium="image" type="image/png" width="${g.w}" height="${g.h}"/>`,
      '</item>',
    ].join('\n')).join('\n');
    writeFileSync(join(OUT, `tiles-${g.name}.xml`), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">',
      '<channel>',
      `<title>CFW Lobby Sign Tiles ${g.name}</title>`,
      `<link>${BASE}/</link>`,
      `<description>The lobby sign as ${g.cols * g.rows} picture tiles of ${g.w}x${g.h}, in reading order.</description>`,
      `<lastBuildDate>${new Date(now).toUTCString()}</lastBuildDate>`,
      '<ttl>15</ttl>',
      body,
      '</channel>',
      '</rss>',
      '',
    ].join('\n'));
    manifest.grids[g.name] = items;
    console.log(`${g.name}: ${items.length} tiles of ${g.w}x${g.h}`);
  }

  writeFileSync(join(OUT, 'tiles.json'), JSON.stringify(manifest, null, 2) + '\n');
} finally {
  await browser.close();
}
