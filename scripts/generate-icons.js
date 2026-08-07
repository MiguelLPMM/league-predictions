// Regenerates public/icons/*.png and public/og-image.png: the 6 league
// crests arranged in a circle (angles 0, pi/3, 2pi/3, pi, 4pi/3, 5pi/3) on a
// white background. Emblem URLs come from football-data.org's public crest
// CDN (same source the app already uses at runtime).
// Run with: npm run generate:icons
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');

// slug order maps 1:1 to angles [0, 60, 120, 180, 240, 300] degrees.
// Each entry also crops out the league wordmark, keeping just the graphic
// mark, so the icon stays legible at small sizes (favicon, home screen).
// crop is [x0, y0, x1, y1] as fractions of the source image.
const EMBLEMS = [
  { url: 'https://crests.football-data.org/PL.png', crop: [0, 0, 0.34, 1] },        // premierleague - 0
  { url: 'https://crests.football-data.org/laliga.png', crop: [0, 0, 1, 0.65] },    // laliga - 60
  { url: 'https://crests.football-data.org/BL1.png', crop: [0, 0, 1, 0.75] },       // bundesliga - 120
  { url: 'https://crests.football-data.org/c111.png', crop: [0, 0, 1, 0.66] },      // seriea - 180
  { url: 'https://crests.football-data.org/FL1.png', crop: [0, 0, 1, 0.56] },       // ligue1 - 240
  { url: 'https://crests.football-data.org/PPL.png', crop: [0, 0, 1, 1] },          // ligaportugal - 300
];

const MASTER_SIZE = 1024;
const CENTER = MASTER_SIZE / 2;
const RADIUS = 250;
const LOGO_BOX = 190;

async function fetchBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function buildMaster() {
  const buffers = await Promise.all(EMBLEMS.map((e) => fetchBuffer(e.url)));

  const composites = await Promise.all(buffers.map(async (buf, i) => {
    const angle = (Math.PI / 3) * i; // 0, pi/3, 2pi/3, pi, 4pi/3, 5pi/3
    const cx = CENTER + RADIUS * Math.cos(angle);
    const cy = CENTER - RADIUS * Math.sin(angle);

    const meta = await sharp(buf).metadata();
    const [x0, y0, x1, y1] = EMBLEMS[i].crop;
    const left = Math.round(x0 * meta.width);
    const top = Math.round(y0 * meta.height);
    const width = Math.round((x1 - x0) * meta.width);
    const height = Math.round((y1 - y0) * meta.height);

    const extracted = await sharp(buf)
      .extract({ left, top, width, height })
      .png()
      .toBuffer();
    const cropped = await sharp(extracted).trim().toBuffer();

    const resized = await sharp(cropped)
      .resize(LOGO_BOX, LOGO_BOX, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    return { input: resized, left: Math.round(cx - LOGO_BOX / 2), top: Math.round(cy - LOGO_BOX / 2) };
  }));

  return sharp({
    create: {
      width: MASTER_SIZE,
      height: MASTER_SIZE,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

async function main() {
  const outDir = path.join(root, 'public/icons');
  fs.mkdirSync(outDir, { recursive: true });

  const master = await buildMaster();

  const iconTargets = [
    { file: 'icon-16.png', size: 16 },
    { file: 'icon-32.png', size: 32 },
    { file: 'icon-192.png', size: 192 },
    { file: 'icon-512.png', size: 512 },
    { file: 'icon-maskable-512.png', size: 512 },
    { file: 'apple-touch-icon.png', size: 180 },
  ];

  for (const { file, size } of iconTargets) {
    await sharp(master)
      .resize(size, size)
      .flatten({ background: '#ffffff' })
      .png()
      .toFile(path.join(outDir, file));
    console.log('wrote', path.join('public/icons', file));
  }

  const ogLogo = await sharp(master).resize(560, 560).png().toBuffer();
  await sharp({
    create: { width: 1200, height: 630, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite([{ input: ogLogo, left: Math.round((1200 - 560) / 2), top: Math.round((630 - 560) / 2) }])
    .png()
    .toFile(path.join(root, 'public/og-image.png'));
  console.log('wrote public/og-image.png');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
