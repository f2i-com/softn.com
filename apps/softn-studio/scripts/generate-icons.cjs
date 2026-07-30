/**
 * Generate SoftN Studio PWA Icons
 *
 * Resizes public/studio-icon.png into the sizes the web app manifest declares.
 */

const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const publicDir = path.join(__dirname, '..', 'public');
const sourceFile = path.join(publicDir, 'studio-icon.png');

// Matches theme_color/background_color in the generated manifest, so a masked
// icon blends into the splash screen instead of showing a seam.
const BACKGROUND = '#09090b';

// A maskable icon may be cropped to a circle of 80% of its width, so the logo
// has to fit inside that circle. studio-icon.png is a rounded square whose
// corners reach sqrt(2) * (half - radius) + radius from the centre; at 64% of
// the canvas that lands just inside the 80% circle.
const MASKABLE_LOGO_SCALE = 0.64;

let sourceImg;

function createIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(sourceImg, 0, 0, size, size);
  return canvas.toBuffer('image/png');
}

function createMaskableIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, size, size);
  const logoSize = Math.round(size * MASKABLE_LOGO_SCALE);
  const offset = Math.round((size - logoSize) / 2);
  ctx.drawImage(sourceImg, offset, offset, logoSize, logoSize);
  return canvas.toBuffer('image/png');
}

/** Reads the IHDR chunk back off disk so a truncated or mis-sized write is caught here. */
function verify(filepath, expectedSize) {
  const written = fs.readFileSync(filepath);
  if (written.length === 0) throw new Error(`${filepath} is empty`);
  if (written.subarray(1, 4).toString('latin1') !== 'PNG') throw new Error(`${filepath} is not a PNG`);
  const width = written.readUInt32BE(16);
  const height = written.readUInt32BE(20);
  if (width !== expectedSize || height !== expectedSize) {
    throw new Error(`${filepath} is ${width}x${height}, expected ${expectedSize}x${expectedSize}`);
  }
  return { width, height, bytes: written.length };
}

async function main() {
  sourceImg = await loadImage(sourceFile);

  const icons = [
    { name: 'pwa-192x192.png', size: 192, maskable: false },
    { name: 'pwa-512x512.png', size: 512, maskable: false },
    { name: 'pwa-maskable-512x512.png', size: 512, maskable: true },
  ];

  for (const { name, size, maskable } of icons) {
    const png = maskable ? createMaskableIcon(size) : createIcon(size);
    const filepath = path.join(publicDir, name);
    fs.writeFileSync(filepath, png);
    const { width, height, bytes } = verify(filepath, size);
    console.log(`Created: ${name} (${width}x${height}, ${bytes} bytes)`);
  }

  console.log('\nIcons generated successfully!');
}

main().catch((err) => { console.error(err); process.exit(1); });
