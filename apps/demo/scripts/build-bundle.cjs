/**
 * Build .softn Bundle(s)
 *
 * Usage:
 *   node scripts/build-bundle.cjs              — build all bundles (auto-discover)
 *   node scripts/build-bundle.cjs Showcase     — build only Showcase.softn
 */

const fs = require('fs');
const path = require('path');

// Binary file extensions
const binaryExtensions = [
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.svg', '.bmp', '.avif', '.tiff', '.tif',
  '.glb', '.obj', '.fbx', '.stl', '.3ds', '.dae', '.bin',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.hdr', '.exr', '.pdf',
  '.onnx',
];

function isBinary(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return binaryExtensions.includes(ext);
}

function collectFilesRecursive(rootDir, baseDir) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const dirEntries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of dirEntries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else {
        out.push(path.relative(baseDir, abs).replace(/\\/g, '/'));
      }
    }
  }
  return out;
}

// CRC-32 calculation
function crc32(data) {
  let crc = 0xffffffff;
  const table = new Uint32Array(256);

  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }

  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

// Create ZIP file
function createZip(entries) {
  const chunks = [];
  const centralDirectory = [];
  let offset = 0;

  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, 'utf-8');
    const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data);

    // Local file header
    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc32(dataBuffer), 14);
    localHeader.writeUInt32LE(dataBuffer.length, 18);
    localHeader.writeUInt32LE(dataBuffer.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBytes.copy(localHeader, 30);

    chunks.push(localHeader);
    chunks.push(dataBuffer);

    // Central directory entry
    const cdEntry = Buffer.alloc(46 + nameBytes.length);
    cdEntry.writeUInt32LE(0x02014b50, 0);
    cdEntry.writeUInt16LE(20, 4);
    cdEntry.writeUInt16LE(20, 6);
    cdEntry.writeUInt16LE(0, 8);
    cdEntry.writeUInt16LE(0, 10);
    cdEntry.writeUInt16LE(0, 12);
    cdEntry.writeUInt16LE(0, 14);
    cdEntry.writeUInt32LE(crc32(dataBuffer), 16);
    cdEntry.writeUInt32LE(dataBuffer.length, 20);
    cdEntry.writeUInt32LE(dataBuffer.length, 24);
    cdEntry.writeUInt16LE(nameBytes.length, 28);
    cdEntry.writeUInt16LE(0, 30);
    cdEntry.writeUInt16LE(0, 32);
    cdEntry.writeUInt16LE(0, 34);
    cdEntry.writeUInt16LE(0, 36);
    cdEntry.writeUInt32LE(0, 38);
    cdEntry.writeUInt32LE(offset, 42);
    nameBytes.copy(cdEntry, 46);

    centralDirectory.push(cdEntry);
    offset += localHeader.length + dataBuffer.length;
  }

  const cdStart = offset;
  for (const entry of centralDirectory) {
    chunks.push(entry);
    offset += entry.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.size, 8);
  eocd.writeUInt16LE(entries.size, 10);
  eocd.writeUInt32LE(offset - cdStart, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);

  chunks.push(eocd);

  return Buffer.concat(chunks);
}

/**
 * Build a single bundle by name.
 */
function buildBundle(bundleName) {
  const bundlesDir = path.join(__dirname, '..', 'bundles');
  const sourceDir = path.join(bundlesDir, bundleName);

  const manifestPath = path.join(sourceDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`ERROR: manifest.json not found in bundles/${bundleName}/`);
    return false;
  }

  console.log(`Building ${bundleName}.softn bundle...`);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const entries = new Map();

  // Add manifest
  entries.set('manifest.json', JSON.stringify(manifest, null, 2));

  // Add permission.json if present
  const permPath = path.join(sourceDir, 'permission.json');
  if (fs.existsSync(permPath)) {
    entries.set('permission.json', fs.readFileSync(permPath, 'utf-8'));
  }

  // Collect all files from manifest, ensuring main and icon are included
  const fileSet = new Set([
    ...(manifest.files.ui || []),
    ...(manifest.files.logic || []),
    ...(manifest.files.xdb || []),
    ...(manifest.files.assets || []),
  ]);
  // Always include files physically under assets/ so new media files are picked up
  // even if manifest.files.assets is stale.
  const discoveredAssets = collectFilesRecursive(path.join(sourceDir, 'assets'), sourceDir);
  for (const a of discoveredAssets) {
    fileSet.add(a);
  }
  if (manifest.main) fileSet.add(manifest.main);
  if (manifest.icon) fileSet.add(manifest.icon);
  const allFiles = [...fileSet];

  // Add each file
  for (const filePath of allFiles) {
    const fullPath = path.join(sourceDir, filePath);
    if (!fs.existsSync(fullPath)) {
      console.warn(`  WARNING: File not found: ${filePath}`);
      continue;
    }

    if (isBinary(filePath)) {
      entries.set(filePath, fs.readFileSync(fullPath));
    } else {
      entries.set(filePath, fs.readFileSync(fullPath, 'utf-8'));
    }
  }

  // Create the ZIP bundle
  const bundleData = createZip(entries);

  // Write output
  const outputPath = path.join(bundlesDir, `${bundleName}.softn`);
  fs.writeFileSync(outputPath, bundleData);

  console.log(`Bundle created: ${outputPath}`);
  console.log(`Size: ${(bundleData.length / 1024).toFixed(2)} KB`);
  console.log('Contents:');
  for (const [name] of entries) {
    console.log(`  - ${name}`);
  }
  console.log('');

  return true;
}

// --- Main ---

const bundleName = process.argv[2];

if (bundleName) {
  // Build a specific bundle
  const success = buildBundle(bundleName);
  if (!success) process.exit(1);
} else {
  // Auto-discover all bundles with manifest.json
  const bundlesDir = path.join(__dirname, '..', 'bundles');
  const entries = fs.readdirSync(bundlesDir, { withFileTypes: true });

  const bundleNames = entries
    .filter((e) => e.isDirectory())
    .filter((e) => fs.existsSync(path.join(bundlesDir, e.name, 'manifest.json')))
    .map((e) => e.name);

  if (bundleNames.length === 0) {
    console.log('No bundles found with manifest.json');
    process.exit(0);
  }

  console.log(`Found ${bundleNames.length} bundle(s): ${bundleNames.join(', ')}\n`);

  let allSuccess = true;
  for (const name of bundleNames) {
    if (!buildBundle(name)) {
      allSuccess = false;
    }
  }

  if (!allSuccess) process.exit(1);
}
