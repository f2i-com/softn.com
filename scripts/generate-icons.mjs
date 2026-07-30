#!/usr/bin/env node
/**
 * Draw the SoftN mark into the icons an installable app needs.
 *
 *   node scripts/generate-icons.mjs [appDir] [--ground #rrggbb] [--svg-only]
 *
 * appDir defaults to the cwd. --ground is the colour behind the mark, and must
 * match the app's own background_color: a maskable icon is drawn full-bleed onto
 * the splash screen, so a ground that disagrees with it shows as a seam.
 * --svg-only writes the favicon and skips the PNGs, for the landing page, which
 * wants the same mark in its tab but is not installable and would only be
 * shipping three unreferenced bitmaps.
 *
 * This replaces three near-identical copies, one per app, which is how the
 * problem it fixes got in: Studio's copy still resized a blue PNG from the old
 * palette long after the web runtime's copy had been rewritten to draw the mark,
 * so the two apps installed under logos from different products.
 *
 * The geometry lives here rather than in each favicon.svg, and this script
 * writes that SVG too. A comment saying "geometry copied from favicon.svg" is
 * only true until someone edits one of them; generating both from one source
 * makes drifting apart impossible rather than merely discouraged.
 *
 * PNG and not SVG for the manifest: Chrome on Android accepts neither an SVG
 * install icon nor an SVG maskable one, so a manifest offering only vectors is
 * declaring a maskable icon no launcher will ever mask.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

// The mark, on the 32x32 grid it is authored on. Coral brackets because they
// are the language, a mint dot because it is the thing that runs — the same
// rule the landing page and Studio's drawn Mark follow.
const GRID = 32;
const groundFlag = process.argv.indexOf('--ground');
const GROUND = groundFlag !== -1 ? process.argv[groundFlag + 1] : '#101317';
if (!/^#[0-9a-fA-F]{6}$/.test(GROUND)) throw new Error(`--ground must be #rrggbb, got ${GROUND}`);
const CORAL = '#FF8A4C';
const MINT = '#35E0C0';
const CORNER = 7; // grid units
const STROKE = 2.4;
const DOT_R = 2.8;
const BRACKETS = [
  [[9, 11.5], [5.5, 16], [9, 20.5]],
  [[23, 11.5], [26.5, 16], [23, 20.5]],
];

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}">
  <rect width="${GRID}" height="${GRID}" rx="${CORNER}" fill="${GROUND}"/>
${BRACKETS.map(
  ([a, b, c]) =>
    `  <path d="M${a[0]} ${a[1]} ${b[0]} ${b[1]} ${c[0]} ${c[1]}" fill="none" stroke="${CORAL}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"/>`,
).join('\n')}
  <circle cx="${GRID / 2}" cy="${GRID / 2}" r="${DOT_R}" fill="${MINT}"/>
</svg>
`;

/** Draw the glyph — brackets and dot, no tile — inset by a fraction of the canvas. */
function drawGlyph(ctx, size, inset) {
  const scale = (size * (1 - inset * 2)) / GRID;
  ctx.save();
  ctx.translate(size * inset, size * inset);
  ctx.scale(scale, scale);

  ctx.lineWidth = STROKE;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = CORAL;
  for (const [a, b, c] of BRACKETS) {
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.stroke();
  }

  ctx.fillStyle = MINT;
  ctx.beginPath();
  ctx.arc(GRID / 2, GRID / 2, DOT_R, 0, Math.PI * 2);
  ctx.fill();

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
  ctx.fillStyle = GROUND;

  if (maskable) {
    // A launcher crops a maskable icon to whatever shape it likes, so the ground
    // bleeds to the edges and the glyph stays inside the 80% safe zone. At this
    // inset the glyph's furthest corner sits at 26% of the canvas from centre,
    // comfortably inside the 40% the spec guarantees.
    ctx.fillRect(0, 0, size, size);
    drawGlyph(ctx, size, 0.18);
  } else {
    roundedRectPath(ctx, size, (size * CORNER) / GRID);
    ctx.fill();
    drawGlyph(ctx, size, 0);
  }

  return canvas.toBuffer('image/png');
}

/** Read the IHDR chunk back off disk, so a truncated or mis-sized write is caught here. */
function verify(filepath, expectedSize) {
  const written = fs.readFileSync(filepath);
  if (written.length === 0) throw new Error(`${filepath} is empty`);
  if (written.subarray(1, 4).toString('latin1') !== 'PNG') throw new Error(`${filepath} is not a PNG`);
  const width = written.readUInt32BE(16);
  const height = written.readUInt32BE(20);
  if (expectedSize !== null && (width !== expectedSize || height !== expectedSize)) {
    throw new Error(`${filepath} is ${width}x${height}, expected ${expectedSize}x${expectedSize}`);
  }
  return { width, height, bytes: written.length };
}

/**
 * The 1200x630 card a link unfurls into on social and in chat.
 *
 * Drawn in the site's own faces, not a system fallback: the file is committed,
 * so whatever machine generates it decides what everyone sees, and "whatever
 * sans this laptop had" is not the brand. @fontsource ships only woff/woff2,
 * which GlobalFonts.register accepts.
 */
function createOgCard() {
  const W = 1200;
  const H = 630;
  const faces = [
    ['SoftN Display', '@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2'],
    ['SoftN Body', '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2'],
    ['SoftN Mono', '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2'],
  ];
  for (const [alias, rel] of faces) {
    const file = path.join(repoRoot, 'node_modules', rel);
    if (!fs.existsSync(file)) throw new Error(`OG card needs ${rel}, which is not installed`);
    GlobalFonts.register(fs.readFileSync(file), alias);
  }

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = GROUND;
  ctx.fillRect(0, 0, W, H);

  const pad = 96;

  // The mark, at the top, drawn from the same geometry as the icons.
  ctx.save();
  ctx.translate(pad, pad);
  ctx.scale(104 / GRID, 104 / GRID);
  ctx.fillStyle = GROUND;
  ctx.restore();
  ctx.save();
  ctx.translate(pad, pad);
  const markScale = 104 / GRID;
  ctx.scale(markScale, markScale);
  ctx.lineWidth = STROKE;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = CORAL;
  for (const [a, b, c] of BRACKETS) {
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.stroke();
  }
  ctx.fillStyle = MINT;
  ctx.beginPath();
  ctx.arc(GRID / 2, GRID / 2, DOT_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = '#f2f0ec';
  ctx.font = '600 96px "SoftN Display"';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('SoftN', pad, 330);

  ctx.fillStyle = '#8b94a2';
  ctx.font = '400 38px "SoftN Body"';
  ctx.fillText('A UI language, and the runtime that runs it.', pad, 396);

  // The three things the page actually claims, in the mono eyebrow treatment.
  ctx.font = '400 24px "SoftN Mono"';
  const chips = ['86 components', 'sandboxed JS in WASM', 'local-first P2P'];
  const gap = 16;
  const boxes = chips.map((chip) => ({ chip, w: ctx.measureText(chip).width + 40 }));
  const total = boxes.reduce((sum, b) => sum + b.w, 0) + gap * (boxes.length - 1);
  // Measured, not eyeballed. The first draft ran the last chip off the right
  // edge, and a social card is only ever looked at after it has been shared.
  if (total > W - pad * 2) {
    throw new Error(`OG chips need ${Math.ceil(total)}px but only ${W - pad * 2}px is available; shorten them`);
  }
  let x = pad;
  for (const { chip, w } of boxes) {
    ctx.strokeStyle = '#262c36';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, 470, w, 56, 28);
    ctx.stroke();
    ctx.fillStyle = '#838c9a';
    ctx.fillText(chip, x + 20, 505);
    x += w + gap;
  }

  // Coral into mint: the language, then the machine.
  const rule = ctx.createLinearGradient(pad, 0, W - pad, 0);
  rule.addColorStop(0, CORAL);
  rule.addColorStop(1, MINT);
  ctx.fillStyle = rule;
  ctx.fillRect(0, H - 10, W, 10);

  return canvas.toBuffer('image/png');
}

const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--ground');
const appDir = path.resolve(positional[0] || process.cwd());
const publicDir = path.join(appDir, 'public');
fs.mkdirSync(publicDir, { recursive: true });

fs.writeFileSync(path.join(publicDir, 'favicon.svg'), SVG);
console.log(`Created: favicon.svg (${GRID}x${GRID} grid)`);

if (process.argv.includes('--touch')) {
  // iOS ignores an SVG favicon when someone adds the page to their home screen
  // and falls back to a screenshot unless a PNG is offered at this exact name.
  const filepath = path.join(publicDir, 'apple-touch-icon.png');
  fs.writeFileSync(filepath, createIcon(180, false));
  const { width, height, bytes } = verify(filepath, 180);
  console.log(`Created: apple-touch-icon.png (${width}x${height}, ${bytes} bytes)`);
}

if (process.argv.includes('--og')) {
  const filepath = path.join(publicDir, 'og.png');
  fs.writeFileSync(filepath, createOgCard());
  const { width, height, bytes } = verify(filepath, null);
  console.log(`Created: og.png (${width}x${height}, ${bytes} bytes)`);
}

if (!process.argv.includes('--svg-only')) {
  for (const { name, size, maskable } of [
    { name: 'pwa-192x192.png', size: 192, maskable: false },
    { name: 'pwa-512x512.png', size: 512, maskable: false },
    { name: 'pwa-maskable-512x512.png', size: 512, maskable: true },
  ]) {
    const filepath = path.join(publicDir, name);
    fs.writeFileSync(filepath, createIcon(size, maskable));
    const { width, height, bytes } = verify(filepath, size);
    console.log(`Created: ${name} (${width}x${height}, ${bytes} bytes)`);
  }
}

console.log(`\nIcons written to ${path.relative(process.cwd(), publicDir).replace(/\\/g, '/') || publicDir}`);
