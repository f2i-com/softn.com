/**
 * Generate SoftN Builder PWA Icons
 *
 * Draws the favicon.svg mark into the PNG sizes the web app manifest needs.
 * The mark is redrawn with the canvas API rather than rasterised from the SVG
 * so the maskable variant can inset the glyph inside the platform safe zone.
 */

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');

const publicDir = path.join(__dirname, '..', 'public');

// Geometry copied from public/favicon.svg, which is authored on a 32x32 grid.
const GRID = 32;

function drawMark(ctx, size, inset) {
  const scale = (size * (1 - inset * 2)) / GRID;
  ctx.save();
  ctx.translate(size * inset, size * inset);
  ctx.scale(scale, scale);

  ctx.lineWidth = 2.8;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(10.5, 9);
  ctx.bezierCurveTo(20, 9, 21, 16, 16, 16);
  ctx.bezierCurveTo(11, 16, 12, 23, 21.5, 23);
  ctx.stroke();

  ctx.fillStyle = '#fff';
  for (const [cx, cy] of [[10.5, 9], [21.5, 23]]) {
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function roundedRectPath(ctx, size, radius) {
  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.arcTo(size, 0, size, size, radius);
  ctx.arcTo(size, size, 0, size, radius);
  ctx.arcTo(0, size, 0, 0, radius);
  ctx.arcTo(0, 0, size, 0, radius);
  ctx.closePath();
}

function createIcon(size, maskable) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  const gradient = ctx.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, '#60a5fa');
  gradient.addColorStop(1, '#2563eb');
  ctx.fillStyle = gradient;

  if (maskable) {
    // Maskable icons are cropped to whatever shape the launcher wants, so the
    // background bleeds to the edges and the glyph stays inside the 80% safe
    // zone the spec guarantees.
    ctx.fillRect(0, 0, size, size);
    drawMark(ctx, size, 0.18);
  } else {
    roundedRectPath(ctx, size, (size * 8) / GRID);
    ctx.fill();
    drawMark(ctx, size, 0);
  }

  return canvas.toBuffer('image/png');
}

const icons = [
  { name: 'pwa-192x192.png', size: 192, maskable: false },
  { name: 'pwa-512x512.png', size: 512, maskable: false },
  { name: 'pwa-maskable-512x512.png', size: 512, maskable: true },
];

if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

for (const { name, size, maskable } of icons) {
  const png = createIcon(size, maskable);
  fs.writeFileSync(path.join(publicDir, name), png);
  console.log(`Created: ${name} (${size}x${size}, ${png.length} bytes)`);
}
