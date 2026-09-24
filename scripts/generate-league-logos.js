// Builds public/leagues/<slug>.png: each league's emblem WITHOUT its wordmark
// (the site shows the league name next to the logo), trimmed and transparent.
//
// Every emblem comes from the official vector logo hosted on Wikimedia (Commons or
// English Wikipedia), rendered at high resolution, so all six share one source and
// one look. The mark is separated from the wordmark by cutting at the first empty
// gap (rows for logos with the text underneath, columns for Premier League where the
// text sits to the right). Liga Portugal is different: its mark is the two big navy
// shapes of the logo, so those are kept and everything else (text, red sponsor band,
// card border) is dropped.
//
// Run with: npm run generate:league-logos   (needs network). The result is committed,
// and generate-icons.js builds the app icon from these files.
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const OUT = path.join(root, 'public/leagues');
const MAX = 256; // longest side of each output, in px
const UA = 'league-predictions-logo-fetch/1.0 (personal project)';

const wiki = (host, file) => `https://${host}/wiki/Special:FilePath/${encodeURIComponent(file)}?width=1200`;
const commons = (file) => wiki('commons.wikimedia.org', file);
const enwiki = (file) => wiki('en.wikipedia.org', file);

// first: which way to look for the gap that separates the mark from the wordmark
const LOGOS = [
  { slug: 'premierleague', url: enwiki('Premier League Logo.svg'), first: 'cols' },          // lion | text
  { slug: 'laliga', url: commons('LaLiga 2023 Vertical Logo.svg'), first: 'rows' },          // mark / LALIGA
  { slug: 'bundesliga', url: enwiki('Bundesliga logo (2017).svg'), first: 'rows' },          // red square / BUNDESLIGA
  { slug: 'seriea', url: enwiki('Serie A ENILIVE logo.svg'), first: 'rows' },                // blue A / SERIE A / sponsor
  { slug: 'ligue1', url: commons("Logo Ligue 1 McDonald's 2024.svg"), first: 'rows' },       // L1 / LIGUE 1 / McDonald's
  { slug: 'ligaportugal', url: commons('Liga Portugal Betclic logo.svg'), keepBigNavyShapes: true },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchBuffer(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// Cut the image at the first empty gap: keeps only the leading band of ink. A gap must
// be at least 1% of the image, so hairline gaps inside a mark never split it.
async function keepFirstBand(buf, direction) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const ink = (x, y) => {
    const i = (y * W + x) * 4;
    return data[i + 3] > 60 && !(data[i] > 235 && data[i + 1] > 235 && data[i + 2] > 235);
  };
  const len = direction === 'rows' ? H : W;
  const cross = direction === 'rows' ? W : H;
  const has = new Array(len).fill(false);
  for (let a = 0; a < len; a++) {
    for (let b = 0; b < cross; b++) {
      if (direction === 'rows' ? ink(b, a) : ink(a, b)) { has[a] = true; break; }
    }
  }
  const minGap = Math.max(3, Math.round(len * 0.01));
  const start = has.indexOf(true);
  let end = start;
  let gap = 0;
  for (let a = start; a < len; a++) {
    if (has[a]) { end = a; gap = 0; } else if (++gap >= minGap) break;
  }
  const size = end - start + 1;
  return sharp(buf).extract(direction === 'rows'
    ? { left: 0, top: start, width: W, height: size }
    : { left: start, top: 0, width: size, height: H }).png().toBuffer();
}

// Liga Portugal: keep only the large navy connected shapes (the mark) and make
// everything else transparent. Letters are separate small shapes, so an area
// threshold separates the mark from the "LIGA PORTUGAL" text.
async function isolateBigNavyShapes(buf) {
  const full = await sharp(buf).flatten({ background: '#ffffff' }).raw().toBuffer({ resolveWithObject: true });
  const W = full.info.width, H = full.info.height, C = full.info.channels;

  const SCALE = 640 / W; // find components on a small copy for speed
  const sw = 640, sh = Math.round(H * SCALE);
  const small = await sharp(buf).flatten({ background: '#ffffff' }).resize(sw, sh).raw().toBuffer();
  const navy = (d, i) => d[i] < 90 && d[i + 1] < 100 && d[i + 2] < 150 && d[i + 2] > d[i] + 15;

  const label = new Int32Array(sw * sh);
  const areas = [0];
  let n = 0;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const p = y * sw + x;
      if (label[p] || !navy(small, p * C)) continue;
      n++;
      let area = 0;
      const stack = [p];
      label[p] = n;
      while (stack.length) {
        const q = stack.pop();
        area++;
        const qx = q % sw, qy = (q / sw) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = qx + dx, ny = qy + dy;
          if (nx < 0 || ny < 0 || nx >= sw || ny >= sh) continue;
          const np = ny * sw + nx;
          if (label[np] || !navy(small, np * C)) continue;
          label[np] = n;
          stack.push(np);
        }
      }
      areas[n] = area;
    }
  }
  const BIG = 10000; // letters are ~3.7k, the two mark shapes are 18k and 68k
  const keep = new Set(areas.map((a, i) => (a >= BIG ? i : -1)).filter((i) => i > 0));
  if (keep.size < 2) throw new Error(`expected the 2 big shapes of the Liga Portugal mark, found ${keep.size}`);

  // mask at small size (grown by 2px so anti-aliased edges survive), scaled up to full size
  const mask = Buffer.alloc(sw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (!keep.has(label[y * sw + x])) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < sw && ny < sh) mask[ny * sw + nx] = 255;
        }
      }
    }
  }
  const up = await sharp(mask, { raw: { width: sw, height: sh, channels: 1 } })
    .resize(W, H, { kernel: 'nearest' }).raw().toBuffer({ resolveWithObject: true });
  const bigMask = up.data;
  const MC = up.info.channels; // sharp may return more than 1 channel

  // alpha = how far from white a pixel is (keeps smooth edges), colour = the navy
  const out = Buffer.alloc(W * H * 4);
  for (let p = 0; p < W * H; p++) {
    const r = full.data[p * C], g = full.data[p * C + 1], b = full.data[p * C + 2];
    const alpha = bigMask[p * MC] ? Math.min(255, Math.round((255 - Math.min(r, g, b)) * 1.15)) : 0;
    out[p * 4] = 19; out[p * 4 + 1] = 40; out[p * 4 + 2] = 92; out[p * 4 + 3] = alpha;
  }
  return sharp(out, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}

async function build(logo) {
  let buf = await fetchBuffer(logo.url);
  if (logo.keepBigNavyShapes) buf = await isolateBigNavyShapes(buf);

  if (logo.first) buf = await keepFirstBand(buf, logo.first);

  const trimmed = await sharp(buf).trim().png().toBuffer();
  const file = path.join(OUT, `${logo.slug}.png`);
  await sharp(trimmed)
    .resize(MAX, MAX, { fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toFile(file);
  const meta = await sharp(file).metadata();
  console.log(`wrote public/leagues/${logo.slug}.png (${meta.width}x${meta.height})`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const logo of LOGOS) {
    await build(logo);
    await sleep(2500); // Wikimedia asks for gentle request rates
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
