// Regenerates public/icons/*.png and public/og-image.png: the 6 league logos
// (public/leagues/*.png, text-free, built by generate-league-logos.js) arranged in
// a circle (angles 0, pi/3, 2pi/3, pi, 4pi/3, 5pi/3) on a white background.
// Run with: npm run generate:icons
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');

// slug order maps 1:1 to angles [0, 60, 120, 180, 240, 300] degrees.
const SLUGS = ['premierleague', 'laliga', 'bundesliga', 'seriea', 'ligue1', 'ligaportugal'];

const MASTER_SIZE = 1024;
const CENTER = MASTER_SIZE / 2;
const RADIUS = 250;
const LOGO_BOX = 190;

async function buildMaster() {
  const composites = await Promise.all(SLUGS.map(async (slug, i) => {
    const angle = (Math.PI / 3) * i; // 0, pi/3, 2pi/3, pi, 4pi/3, 5pi/3
    const cx = CENTER + RADIUS * Math.cos(angle);
    const cy = CENTER - RADIUS * Math.sin(angle);

    const file = path.join(root, 'public/leagues', `${slug}.png`);
    if (!fs.existsSync(file)) throw new Error(`missing ${file} - run: npm run generate:league-logos`);

    const resized = await sharp(file)
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
