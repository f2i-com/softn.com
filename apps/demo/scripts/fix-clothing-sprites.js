/**
 * Fix clothing sprites with face-safe shirt rendering.
 *
 * Shirt (rows 15-23): EDGE COLUMNS ONLY — outer 3px each side, center transparent
 *   → jacket/vest silhouette, face shows through center gaps
 * Pants (rows 24-28): FULL WIDTH — clearly visible leg coverage
 * Shoes (rows 29-31): FULL WIDTH
 *
 * Each outfit type has unique colors for visual variety.
 */

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const BUNDLE = path.join(__dirname, '..', 'bundles', 'TheOffice');
const CLOTHES_DIR = path.join(BUNDLE, 'assets', 'character', 'clothes');
const BASE_SPRITE = path.join(BUNDLE, 'assets', 'character', 'char1_walk.png');

const FRAME_W = 32;
const FRAME_H = 32;
const FRAMES = 8;
const DIRS = 4;

const OUTFIT_PALETTES = {
  'basic_walk.png': [
    { shirt: [78, 75, 85],   se: [50, 48, 55],   pants: [58, 55, 62],   pe: [38, 36, 42],   shoe: [28, 26, 30] },
    { shirt: [68, 88, 122],  se: [42, 55, 78],   pants: [50, 65, 95],   pe: [32, 42, 62],   shoe: [22, 28, 42] },
    { shirt: [95, 115, 150], se: [60, 72, 95],   pants: [68, 85, 112],  pe: [45, 55, 72],   shoe: [30, 36, 50] },
    { shirt: [115, 92, 68],  se: [72, 58, 42],   pants: [88, 72, 52],   pe: [58, 48, 34],   shoe: [38, 30, 22] },
    { shirt: [65, 98, 92],   se: [40, 62, 58],   pants: [48, 75, 72],   pe: [32, 50, 48],   shoe: [22, 34, 32] },
    { shirt: [98, 108, 72],  se: [62, 68, 45],   pants: [78, 85, 55],   pe: [52, 56, 36],   shoe: [34, 38, 24] },
    { shirt: [158, 82, 92],  se: [102, 52, 58],  pants: [122, 62, 68],  pe: [80, 40, 45],   shoe: [52, 28, 30] },
    { shirt: [105, 88, 135], se: [66, 55, 85],   pants: [78, 65, 105],  pe: [52, 42, 68],   shoe: [34, 28, 46] },
    { shirt: [148, 75, 70],  se: [95, 48, 45],   pants: [115, 58, 52],  pe: [75, 38, 34],   shoe: [48, 24, 22] },
    { shirt: [158, 148, 132],se: [102, 95, 85],  pants: [122, 115, 100],pe: [80, 75, 65],   shoe: [52, 48, 42] },
  ],
  'stripe_walk.png': [
    { shirt: [92, 88, 102],  se: [58, 55, 65],   pants: [58, 55, 62],   pe: [38, 36, 42],   shoe: [28, 26, 30] },
    { shirt: [82, 105, 142], se: [52, 66, 90],   pants: [50, 65, 95],   pe: [32, 42, 62],   shoe: [22, 28, 42] },
    { shirt: [112, 132, 168],se: [70, 82, 105],  pants: [68, 85, 112],  pe: [45, 55, 72],   shoe: [30, 36, 50] },
    { shirt: [132, 108, 82], se: [82, 68, 52],   pants: [88, 72, 52],   pe: [58, 48, 34],   shoe: [38, 30, 22] },
    { shirt: [78, 115, 108], se: [48, 72, 68],   pants: [48, 75, 72],   pe: [32, 50, 48],   shoe: [22, 34, 32] },
    { shirt: [115, 125, 85], se: [72, 78, 52],   pants: [78, 85, 55],   pe: [52, 56, 36],   shoe: [34, 38, 24] },
    { shirt: [175, 95, 108], se: [110, 60, 68],  pants: [122, 62, 68],  pe: [80, 40, 45],   shoe: [52, 28, 30] },
    { shirt: [122, 102, 155],se: [76, 64, 98],   pants: [78, 65, 105],  pe: [52, 42, 68],   shoe: [34, 28, 46] },
    { shirt: [168, 88, 82],  se: [105, 55, 52],  pants: [115, 58, 52],  pe: [75, 38, 34],   shoe: [48, 24, 22] },
    { shirt: [172, 162, 145],se: [108, 102, 92], pants: [122, 115, 100],pe: [80, 75, 65],   shoe: [52, 48, 42] },
  ],
  'sporty_walk.png': [
    { shirt: [105, 102, 118],se: [65, 62, 75],   pants: [58, 55, 62],   pe: [38, 36, 42],   shoe: [28, 26, 30] },
    { shirt: [95, 122, 165], se: [60, 76, 102],  pants: [50, 65, 95],   pe: [32, 42, 62],   shoe: [22, 28, 42] },
    { shirt: [128, 148, 185],se: [80, 92, 115],  pants: [68, 85, 112],  pe: [45, 55, 72],   shoe: [30, 36, 50] },
    { shirt: [148, 122, 95], se: [92, 76, 58],   pants: [88, 72, 52],   pe: [58, 48, 34],   shoe: [38, 30, 22] },
    { shirt: [92, 132, 125], se: [56, 82, 78],   pants: [48, 75, 72],   pe: [32, 50, 48],   shoe: [22, 34, 32] },
    { shirt: [132, 142, 98], se: [82, 88, 60],   pants: [78, 85, 55],   pe: [52, 56, 36],   shoe: [34, 38, 24] },
    { shirt: [192, 108, 118],se: [120, 68, 74],  pants: [122, 62, 68],  pe: [80, 40, 45],   shoe: [52, 28, 30] },
    { shirt: [138, 118, 172],se: [86, 74, 108],  pants: [78, 65, 105],  pe: [52, 42, 68],   shoe: [34, 28, 46] },
    { shirt: [185, 98, 92],  se: [115, 62, 58],  pants: [115, 58, 52],  pe: [75, 38, 34],   shoe: [48, 24, 22] },
    { shirt: [188, 178, 158],se: [118, 112, 100],pants: [122, 115, 100],pe: [80, 75, 65],   shoe: [52, 48, 42] },
  ],
  'suit_walk.png': [
    { shirt: [55, 52, 62],   se: [35, 34, 40],   pants: [48, 45, 52],   pe: [32, 30, 35],   shoe: [22, 20, 25] },
    { shirt: [48, 62, 88],   se: [30, 40, 56],   pants: [40, 52, 75],   pe: [26, 34, 48],   shoe: [18, 22, 35] },
    { shirt: [68, 82, 108],  se: [42, 52, 68],   pants: [55, 68, 88],   pe: [36, 44, 58],   shoe: [24, 30, 42] },
    { shirt: [88, 72, 52],   se: [56, 46, 34],   pants: [72, 58, 42],   pe: [48, 38, 28],   shoe: [32, 24, 18] },
    { shirt: [45, 72, 68],   se: [28, 46, 44],   pants: [38, 60, 56],   pe: [25, 40, 38],   shoe: [18, 28, 26] },
    { shirt: [75, 82, 55],   se: [48, 52, 35],   pants: [62, 68, 45],   pe: [42, 45, 30],   shoe: [28, 32, 20] },
    { shirt: [115, 58, 65],  se: [72, 38, 42],   pants: [95, 48, 55],   pe: [62, 32, 36],   shoe: [42, 22, 24] },
    { shirt: [72, 60, 95],   se: [45, 38, 60],   pants: [58, 48, 78],   pe: [38, 32, 52],   shoe: [26, 22, 36] },
    { shirt: [108, 52, 48],  se: [68, 34, 32],   pants: [88, 42, 40],   pe: [58, 28, 26],   shoe: [38, 20, 18] },
    { shirt: [112, 105, 92], se: [72, 68, 58],   pants: [92, 86, 75],   pe: [60, 56, 48],   shoe: [42, 38, 34] },
  ],
  'dress_walk.png': [
    { shirt: [115, 82, 98],  se: [72, 52, 62],   pants: [92, 65, 78],   pe: [60, 42, 50],   shoe: [38, 28, 34] },
    { shirt: [98, 122, 162], se: [62, 76, 102],  pants: [78, 98, 130],  pe: [50, 62, 84],   shoe: [34, 42, 58] },
    { shirt: [132, 152, 185],se: [82, 95, 115],  pants: [105, 122, 148],pe: [68, 78, 95],   shoe: [46, 52, 65] },
    { shirt: [145, 118, 92], se: [92, 74, 58],   pants: [118, 95, 72],  pe: [76, 62, 48],   shoe: [50, 40, 30] },
    { shirt: [92, 135, 128], se: [58, 84, 80],   pants: [72, 108, 102], pe: [48, 70, 66],   shoe: [32, 48, 44] },
    { shirt: [142, 152, 105],se: [88, 95, 66],   pants: [112, 122, 82], pe: [72, 78, 54],   shoe: [48, 52, 36] },
    { shirt: [198, 112, 125],se: [124, 70, 78],  pants: [158, 88, 98],  pe: [102, 58, 64],  shoe: [68, 38, 42] },
    { shirt: [142, 122, 178],se: [88, 76, 112],  pants: [115, 98, 142], pe: [74, 62, 92],   shoe: [50, 42, 62] },
    { shirt: [192, 105, 98], se: [120, 66, 62],  pants: [155, 82, 78],  pe: [100, 54, 50],  shoe: [65, 36, 34] },
    { shirt: [195, 182, 162],se: [122, 115, 102],pants: [155, 145, 128],pe: [100, 95, 82],  shoe: [68, 62, 55] },
  ],
};

// Shirt edge width per outfit (cols from each side that get colored)
const EDGE_WIDTH = {
  'basic_walk.png': 3,
  'stripe_walk.png': 3,
  'sporty_walk.png': 3,
  'suit_walk.png': 4,
  'dress_walk.png': 5,  // dress shows more clothing
};

async function extractBodyMasks() {
  const base = await sharp(BASE_SPRITE).raw().toBuffer({ resolveWithObject: true });
  const w = base.info.width;
  const ch = base.info.channels;

  const masks = [];
  for (let dir = 0; dir < DIRS; dir++) {
    const dirMasks = [];
    for (let frame = 0; frame < FRAMES; frame++) {
      const rows = {};
      const fx = frame * FRAME_W;
      const fy = dir * FRAME_H;
      for (let ly = 15; ly <= 31; ly++) {
        const y = fy + ly;
        const cols = [];
        for (let lx = 0; lx < FRAME_W; lx++) {
          const idx = (y * w + (fx + lx)) * ch;
          if (base.data[idx + 3] > 0) cols.push(lx);
        }
        if (cols.length > 0) {
          rows[ly] = { cols, minX: cols[0], maxX: cols[cols.length - 1] };
        }
      }
      dirMasks.push(rows);
    }
    masks.push(dirMasks);
  }
  return masks;
}

async function fixOutfit(filename, masks) {
  const filepath = path.join(CLOTHES_DIR, filename);
  const meta = await sharp(filepath).metadata();
  const raw = await sharp(filepath).raw().toBuffer();
  const w = meta.width, h = meta.height, ch = meta.channels;
  const buf = Buffer.from(raw);
  const VARIANTS = Math.floor(w / (FRAME_W * FRAMES));
  const palettes = OUTFIT_PALETTES[filename];
  const edgeW = EDGE_WIDTH[filename] || 3;

  console.log(`${filename}: ${VARIANTS} variants, shirt edge=${edgeW}px`);

  for (let variant = 0; variant < VARIANTS; variant++) {
    const pal = palettes[variant] || palettes[0];

    for (let dir = 0; dir < DIRS; dir++) {
      for (let frame = 0; frame < FRAMES; frame++) {
        const rows = masks[dir][frame];
        const ox = (variant * FRAMES + frame) * FRAME_W;
        const oy = dir * FRAME_H;

        for (let ly = 15; ly <= 31; ly++) {
          const rd = rows[ly];
          if (!rd) continue;

          for (const lx of rd.cols) {
            const distL = lx - rd.minX;
            const distR = rd.maxX - lx;
            const distEdge = Math.min(distL, distR);
            const isEdge = (distEdge === 0);

            let color;
            if (ly <= 23) {
              // SHIRT zone: only draw edge columns, leave center for face
              if (distEdge >= edgeW) continue;  // skip center pixels
              color = isEdge ? pal.se : pal.shirt;
            } else if (ly <= 28) {
              // PANTS: full width
              color = isEdge ? pal.pe : pal.pants;
            } else {
              // SHOES: full width
              color = pal.shoe;
            }

            const idx = ((oy + ly) * w + (ox + lx)) * ch;
            buf[idx] = color[0];
            buf[idx + 1] = color[1];
            buf[idx + 2] = color[2];
            buf[idx + 3] = 255;
          }
        }
      }
    }
  }

  await sharp(buf, { raw: { width: w, height: h, channels: ch } }).png().toFile(filepath + '.tmp');
  fs.renameSync(filepath + '.tmp', filepath);
  console.log(`  saved`);
}

async function main() {
  const masks = await extractBodyMasks();
  for (const f of Object.keys(OUTFIT_PALETTES)) await fixOutfit(f, masks);
  console.log('Done!');
}

main().catch(console.error);
