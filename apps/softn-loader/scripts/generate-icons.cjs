/**
 * Generate SoftN Loader Icons
 *
 * Resizes Square310x310Logo.png source to all required icon sizes.
 */

const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const iconsDir = path.join(__dirname, '..', 'src-tauri', 'icons');
const sourceFile = path.join(iconsDir, 'Square310x310Logo.png');

let sourceImg;

function createIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(sourceImg, 0, 0, size, size);
  return canvas.toBuffer('image/png');
}

async function main() {
sourceImg = await loadImage(sourceFile);

if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

// Generate all icon sizes
const sizes = [
  { name: '32x32.png', size: 32 },
  { name: '64x64.png', size: 64 },
  { name: '128x128.png', size: 128 },
  { name: '128x128@2x.png', size: 256 },
  { name: 'icon.png', size: 256 },
  { name: 'Square30x30Logo.png', size: 30 },
  { name: 'Square44x44Logo.png', size: 44 },
  { name: 'Square71x71Logo.png', size: 71 },
  { name: 'Square89x89Logo.png', size: 89 },
  { name: 'Square107x107Logo.png', size: 107 },
  { name: 'Square142x142Logo.png', size: 142 },
  { name: 'Square150x150Logo.png', size: 150 },
  { name: 'Square284x284Logo.png', size: 284 },
  { name: 'StoreLogo.png', size: 50 },
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

// Generate Android icons
const androidSizes = [
  { dir: 'mipmap-mdpi', size: 48 },
  { dir: 'mipmap-hdpi', size: 72 },
  { dir: 'mipmap-xhdpi', size: 96 },
  { dir: 'mipmap-xxhdpi', size: 144 },
  { dir: 'mipmap-xxxhdpi', size: 192 },
];

for (const { dir, size } of androidSizes) {
  const dirPath = path.join(iconsDir, 'android', dir);
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
  for (const name of ['ic_launcher.png', 'ic_launcher_foreground.png', 'ic_launcher_round.png']) {
    const png = createIcon(size);
    fs.writeFileSync(path.join(dirPath, name), png);
  }
  console.log(`Created: android/${dir}/ icons (${size}x${size})`);
}

// Generate iOS icons
const iosSizes = [
  { name: 'AppIcon-20x20@1x.png', size: 20 },
  { name: 'AppIcon-20x20@2x.png', size: 40 },
  { name: 'AppIcon-20x20@2x-1.png', size: 40 },
  { name: 'AppIcon-20x20@3x.png', size: 60 },
  { name: 'AppIcon-29x29@1x.png', size: 29 },
  { name: 'AppIcon-29x29@2x.png', size: 58 },
  { name: 'AppIcon-29x29@2x-1.png', size: 58 },
  { name: 'AppIcon-29x29@3x.png', size: 87 },
  { name: 'AppIcon-40x40@1x.png', size: 40 },
  { name: 'AppIcon-40x40@2x.png', size: 80 },
  { name: 'AppIcon-40x40@2x-1.png', size: 80 },
  { name: 'AppIcon-40x40@3x.png', size: 120 },
  { name: 'AppIcon-60x60@2x.png', size: 120 },
  { name: 'AppIcon-60x60@3x.png', size: 180 },
  { name: 'AppIcon-76x76@1x.png', size: 76 },
  { name: 'AppIcon-76x76@2x.png', size: 152 },
  { name: 'AppIcon-83.5x83.5@2x.png', size: 167 },
  { name: 'AppIcon-512@2x.png', size: 1024 },
];

const iosDir = path.join(iconsDir, 'ios');
if (!fs.existsSync(iosDir)) fs.mkdirSync(iosDir, { recursive: true });
for (const { name, size } of iosSizes) {
  const png = createIcon(size);
  fs.writeFileSync(path.join(iosDir, name), png);
  console.log(`Created: ios/${name} (${size}x${size})`);
}

console.log('\nIcons generated successfully!');
}

main().catch(err => { console.error(err); process.exit(1); });
