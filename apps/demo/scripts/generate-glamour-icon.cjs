/**
 * Generate GlamourStudio Icon
 *
 * Creates a simple icon.png for the GlamourStudio bundle.
 * Uses raw PNG generation without external dependencies.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Create a 128x128 RGBA image with a gradient rounded square and "G" letter
function createIcon() {
  const size = 128;
  const pixels = Buffer.alloc(size * size * 4);

  // Colors for gradient (pink to purple)
  const startColor = { r: 190, g: 24, b: 93 };   // #be185d
  const endColor = { r: 147, g: 51, b: 234 };    // #9333ea

  // Draw the icon
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;

      // Calculate distance from center for rounded rect
      const cx = size / 2;
      const cy = size / 2;
      const rectSize = 100;
      const cornerRadius = 24;
      const halfRect = rectSize / 2;

      // Check if inside rounded rect
      let dx = Math.abs(x - cx);
      let dy = Math.abs(y - cy);

      let inside = false;
      if (dx < halfRect - cornerRadius && dy < halfRect) {
        inside = true;
      } else if (dx < halfRect && dy < halfRect - cornerRadius) {
        inside = true;
      } else if (dx < halfRect && dy < halfRect) {
        // Check corner radius
        const cornerDx = dx - (halfRect - cornerRadius);
        const cornerDy = dy - (halfRect - cornerRadius);
        if (cornerDx > 0 && cornerDy > 0) {
          inside = Math.sqrt(cornerDx * cornerDx + cornerDy * cornerDy) < cornerRadius;
        } else {
          inside = true;
        }
      }

      if (inside) {
        // Gradient based on position (diagonal)
        const t = ((x + y) / (size * 2));
        const r = Math.round(startColor.r + (endColor.r - startColor.r) * t);
        const g = Math.round(startColor.g + (endColor.g - startColor.g) * t);
        const b = Math.round(startColor.b + (endColor.b - startColor.b) * t);

        // Check if we should draw the "G" letter
        const letterCx = size / 2;
        const letterCy = size / 2;
        const letterRadius = 32;
        const letterThickness = 12;

        // Distance from letter center
        const letterDx = x - letterCx;
        const letterDy = y - letterCy;
        const dist = Math.sqrt(letterDx * letterDx + letterDy * letterDy);

        // Check if in the "G" shape (circle with gap on right + horizontal bar)
        const angle = Math.atan2(letterDy, letterDx) * 180 / Math.PI;
        const isInRing = dist > letterRadius - letterThickness / 2 && dist < letterRadius + letterThickness / 2;
        const isInGap = angle > -50 && angle < 50;
        const isInBar = letterDy > -letterThickness / 2 && letterDy < letterThickness / 2 &&
                        letterDx > 0 && letterDx < letterRadius + letterThickness / 2;

        if ((isInRing && !isInGap) || isInBar) {
          // White letter
          pixels[idx] = 255;
          pixels[idx + 1] = 255;
          pixels[idx + 2] = 255;
          pixels[idx + 3] = 255;
        } else {
          // Gradient background
          pixels[idx] = r;
          pixels[idx + 1] = g;
          pixels[idx + 2] = b;
          pixels[idx + 3] = 255;
        }
      } else {
        // Transparent
        pixels[idx] = 0;
        pixels[idx + 1] = 0;
        pixels[idx + 2] = 0;
        pixels[idx + 3] = 0;
      }
    }
  }

  return { pixels, width: size, height: size };
}

// Create PNG from RGBA pixels
function createPNG(pixels, width, height) {
  // PNG signature
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // CRC32 function
  function crc32(data) {
    let crc = 0xffffffff;
    const table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c;
    }
    for (let i = 0; i < data.length; i++) {
      crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  // Create chunk
  function createChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);

    const typeBuffer = Buffer.from(type);
    const crcData = Buffer.concat([typeBuffer, data]);
    const crcValue = crc32(crcData);

    const crcBuffer = Buffer.alloc(4);
    crcBuffer.writeUInt32BE(crcValue, 0);

    return Buffer.concat([length, typeBuffer, data, crcBuffer]);
  }

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);  // bit depth
  ihdr.writeUInt8(6, 9);  // color type (RGBA)
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // interlace

  const ihdrChunk = createChunk('IHDR', ihdr);

  // IDAT chunk - raw pixel data with filter bytes
  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0; // filter byte (none)
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = y * (1 + width * 4) + 1 + x * 4;
      rawData[dstIdx] = pixels[srcIdx];
      rawData[dstIdx + 1] = pixels[srcIdx + 1];
      rawData[dstIdx + 2] = pixels[srcIdx + 2];
      rawData[dstIdx + 3] = pixels[srcIdx + 3];
    }
  }

  const compressed = zlib.deflateSync(rawData, { level: 9 });
  const idatChunk = createChunk('IDAT', compressed);

  // IEND chunk
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// Generate and write icon
const { pixels, width, height } = createIcon();
const png = createPNG(pixels, width, height);

const outputPath = path.join(__dirname, '..', 'bundles', 'GlamourStudio', 'icon.png');
fs.writeFileSync(outputPath, png);

console.log(`Created: ${outputPath} (${png.length} bytes)`);
console.log('GlamourStudio icon generated successfully!');
