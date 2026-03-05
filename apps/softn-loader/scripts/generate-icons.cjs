/**
 * Generate SoftN Loader Icons
 *
 * Creates proper PNG icons using canvas text rendering.
 */

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');

function createIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Clear with transparency
  ctx.clearRect(0, 0, size, size);

  // Match the HTML example proportions:
  // 80x80 container, 20px border-radius (25%), 2.5rem font (50%)
  const padding = size * 0.05; // Small padding from edge
  const rectSize = size - padding * 2;
  const cornerRadius = rectSize * 0.25; // 25% of rect size like the HTML
  const offset = padding;

  // Create gradient (pink to purple) - matching the HTML gradient
  const gradient = ctx.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, '#be185d');
  gradient.addColorStop(1, '#9333ea');

  // Draw rounded rect
  ctx.beginPath();
  ctx.roundRect(offset, offset, rectSize, rectSize, cornerRadius);
  ctx.fillStyle = gradient;
  ctx.fill();

  // Draw the "S" letter - 50% of container size like the HTML (2.5rem in 80px = ~50%)
  const fontSize = rectSize * 0.5;
  ctx.font = `700 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif`;
  ctx.fillStyle = 'white';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Center the S in the rounded rect
  ctx.fillText('S', size / 2, size / 2);

  return canvas.toBuffer('image/png');
}

// Output directory
const iconsDir = path.join(__dirname, '..', 'src-tauri', 'icons');

if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

// Generate all icon sizes
const sizes = [
  { name: '32x32.png', size: 32 },
  { name: '128x128.png', size: 128 },
  { name: '128x128@2x.png', size: 256 },
  { name: 'icon.png', size: 256 },
];

for (const { name, size } of sizes) {
  const png = createIcon(size);
  const filepath = path.join(iconsDir, name);
  fs.writeFileSync(filepath, png);
  console.log(`Created: ${name} (${size}x${size}, ${png.length} bytes)`);
}

// Generate ICO file (Windows icon with multiple sizes embedded as PNG)
function createIco() {
  const icoSizes = [16, 32, 48, 256];
  const images = icoSizes.map((size) => createIcon(size));

  // ICO Header: 6 bytes
  // - Reserved: 2 bytes (0)
  // - Type: 2 bytes (1 = ICO)
  // - Count: 2 bytes (number of images)
  const headerSize = 6;
  const dirEntrySize = 16;
  const dirSize = dirEntrySize * images.length;

  let dataOffset = headerSize + dirSize;
  const entries = [];

  for (let i = 0; i < images.length; i++) {
    const size = icoSizes[i];
    const png = images[i];

    entries.push({
      width: size >= 256 ? 0 : size, // 0 means 256
      height: size >= 256 ? 0 : size,
      colors: 0,
      reserved: 0,
      planes: 1,
      bitCount: 32,
      size: png.length,
      offset: dataOffset,
      data: png,
    });

    dataOffset += png.length;
  }

  // Build ICO buffer
  const totalSize = headerSize + dirSize + images.reduce((sum, img) => sum + img.length, 0);
  const ico = Buffer.alloc(totalSize);

  // Write header
  ico.writeUInt16LE(0, 0); // Reserved
  ico.writeUInt16LE(1, 2); // Type (1 = ICO)
  ico.writeUInt16LE(images.length, 4); // Count

  // Write directory entries
  let offset = headerSize;
  for (const entry of entries) {
    ico.writeUInt8(entry.width, offset);
    ico.writeUInt8(entry.height, offset + 1);
    ico.writeUInt8(entry.colors, offset + 2);
    ico.writeUInt8(entry.reserved, offset + 3);
    ico.writeUInt16LE(entry.planes, offset + 4);
    ico.writeUInt16LE(entry.bitCount, offset + 6);
    ico.writeUInt32LE(entry.size, offset + 8);
    ico.writeUInt32LE(entry.offset, offset + 12);
    offset += dirEntrySize;
  }

  // Write image data
  for (const entry of entries) {
    entry.data.copy(ico, entry.offset);
  }

  return ico;
}

const ico = createIco();
fs.writeFileSync(path.join(iconsDir, 'icon.ico'), ico);
console.log(`Created: icon.ico (${ico.length} bytes)`);

// Generate ICNS file (macOS icon)
function createIcns() {
  // ICNS format:
  // - Header: 'icns' + 4-byte size
  // - Entries: 4-byte type + 4-byte size + data
  // Modern ICNS uses PNG for large sizes

  const icnsTypes = [
    { type: 'icp4', size: 16 }, // 16x16
    { type: 'icp5', size: 32 }, // 32x32
    { type: 'icp6', size: 64 }, // 64x64
    { type: 'ic07', size: 128 }, // 128x128
    { type: 'ic08', size: 256 }, // 256x256
    { type: 'ic09', size: 512 }, // 512x512
    { type: 'ic10', size: 1024 }, // 1024x1024
  ];

  const entries = [];
  for (const { type, size } of icnsTypes) {
    const png = createIcon(size);
    entries.push({ type, data: png });
  }

  // Calculate total size
  const headerSize = 8;
  let totalSize = headerSize;
  for (const entry of entries) {
    totalSize += 8 + entry.data.length; // type + size + data
  }

  const icns = Buffer.alloc(totalSize);

  // Write header
  icns.write('icns', 0);
  icns.writeUInt32BE(totalSize, 4);

  // Write entries
  let offset = headerSize;
  for (const entry of entries) {
    icns.write(entry.type, offset);
    icns.writeUInt32BE(8 + entry.data.length, offset + 4);
    entry.data.copy(icns, offset + 8);
    offset += 8 + entry.data.length;
  }

  return icns;
}

const icns = createIcns();
fs.writeFileSync(path.join(iconsDir, 'icon.icns'), icns);
console.log(`Created: icon.icns (${icns.length} bytes)`);

console.log('\nIcons generated successfully!');
