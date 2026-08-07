// Regenerates public/icons/*.png and public/og-image.png from the SVG sources.
// Run with: npm run generate:icons
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const iconSvg = fs.readFileSync(path.join(root, 'public/icons/icon.svg'));
const ogSvg = fs.readFileSync(path.join(root, 'public/og-image.svg'));

const iconTargets = [
  { file: 'icon-16.png', size: 16 },
  { file: 'icon-32.png', size: 32 },
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  { file: 'icon-maskable-512.png', size: 512 },
  { file: 'apple-touch-icon.png', size: 180 },
];

async function main() {
  const outDir = path.join(root, 'public/icons');
  fs.mkdirSync(outDir, { recursive: true });

  for (const { file, size } of iconTargets) {
    await sharp(iconSvg, { density: 384 })
      .resize(size, size)
      .flatten({ background: '#1e40af' })
      .png()
      .toFile(path.join(outDir, file));
    console.log('wrote', path.join('public/icons', file));
  }

  await sharp(ogSvg).png().toFile(path.join(root, 'public/og-image.png'));
  console.log('wrote public/og-image.png');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
