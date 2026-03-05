/**
 * Fix clothing sprites v6: hair-aware safe clothing generation.
 *
 * Analyzes ALL hair sprites to build a "face gap" mask — pixels where ANY
 * hairstyle is transparent AND body is opaque. Clothing is drawn on all body
 * pixels EXCEPT face gap pixels in the head region (rows 12-22).
 * Below row 22, clothing covers the full body shape.
 *
 * Layer order stays: body(10) → eyes(11) → undergarment(12) → outfit(13) → hair(14)
 * Face shows through because clothing is transparent at face-gap pixels.
 */

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const BUNDLE = path.join(__dirname, '..', 'bundles', 'TheOffice');
const CLOTHES_DIR = path.join(BUNDLE, 'assets', 'character', 'clothes');
const CHAR_DIR = path.join(BUNDLE, 'assets', 'character');
const HAIR_DIR = path.join(BUNDLE, 'assets', 'character', 'hair');
const BASE_SPRITE = path.join(CHAR_DIR, 'char1_walk.png');

const FRAME_W = 32;
const FRAME_H = 32;
const FRAMES = 8;
const DIRS = 4;
const HEAD_REGION_END = 22; // rows 0-22 = head region where face gaps matter

// --- Color palettes per outfit (10 variants each) ---

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
  'pants_suit_walk.png': [
    { shirt: [62, 58, 72],   se: [40, 38, 46],   pants: [52, 48, 58],   pe: [34, 32, 38],   shoe: [24, 22, 28] },
    { shirt: [55, 72, 102],  se: [35, 46, 65],   pants: [45, 58, 82],   pe: [30, 38, 54],   shoe: [20, 26, 38] },
    { shirt: [78, 95, 125],  se: [50, 60, 78],   pants: [62, 78, 100],  pe: [42, 50, 65],   shoe: [28, 34, 46] },
    { shirt: [100, 82, 62],  se: [64, 52, 40],   pants: [80, 65, 48],   pe: [52, 42, 32],   shoe: [36, 28, 22] },
    { shirt: [55, 85, 80],   se: [34, 54, 50],   pants: [44, 68, 64],   pe: [28, 44, 42],   shoe: [20, 30, 28] },
    { shirt: [85, 95, 65],   se: [54, 60, 42],   pants: [68, 76, 50],   pe: [46, 50, 34],   shoe: [30, 34, 22] },
    { shirt: [128, 68, 75],  se: [82, 44, 48],   pants: [105, 55, 60],  pe: [68, 36, 40],   shoe: [46, 24, 26] },
    { shirt: [85, 72, 110],  se: [54, 46, 70],   pants: [68, 56, 88],   pe: [44, 36, 58],   shoe: [30, 26, 40] },
    { shirt: [120, 62, 58],  se: [76, 40, 38],   pants: [98, 50, 46],   pe: [64, 34, 30],   shoe: [42, 22, 20] },
    { shirt: [125, 118, 102],se: [80, 75, 65],   pants: [102, 95, 82],  pe: [66, 62, 54],   shoe: [46, 42, 36] },
  ],
};

// --- Step 1: Extract body shape mask from char1_walk.png ---

async function getBodyMask() {
  const { data, info } = await sharp(BASE_SPRITE).raw().toBuffer({ resolveWithObject: true });
  const w = info.width, ch = info.channels;

  // mask[dir][frame][row] = sorted array of col indices where body is opaque
  const mask = [];
  for (let dir = 0; dir < DIRS; dir++) {
    const dirMask = [];
    for (let frame = 0; frame < FRAMES; frame++) {
      const rows = {};
      const fx = frame * FRAME_W;
      const fy = dir * FRAME_H;
      for (let ly = 0; ly < FRAME_H; ly++) {
        const cols = [];
        for (let lx = 0; lx < FRAME_W; lx++) {
          const idx = ((fy + ly) * w + (fx + lx)) * ch;
          if (data[idx + 3] > 0) cols.push(lx);
        }
        if (cols.length > 0) rows[ly] = cols;
      }
      dirMask.push(rows);
    }
    mask.push(dirMask);
  }
  return mask;
}

// --- Step 2: Find face gap pixels across ALL hair sprites ---
// A pixel is a "face gap" if body is opaque AND ANY hair sprite is transparent there.
// Only checked in the head region (rows 12 to HEAD_REGION_END).

async function getFaceGapMask(bodyMask) {
  const hairFiles = fs.readdirSync(HAIR_DIR).filter(f => f.endsWith('_walk.png'));

  // gap[dir][frame] = Set of "row,col" keys
  const gap = [];
  for (let dir = 0; dir < DIRS; dir++) {
    const dg = [];
    for (let frame = 0; frame < FRAMES; frame++) dg.push(new Set());
    gap.push(dg);
  }

  for (const hf of hairFiles) {
    const { data, info } = await sharp(path.join(HAIR_DIR, hf)).raw().toBuffer({ resolveWithObject: true });
    const w = info.width, ch = info.channels;

    for (let dir = 0; dir < DIRS; dir++) {
      for (let frame = 0; frame < FRAMES; frame++) {
        // Use variant 0 only (first 8 frames)
        const fx = frame * FRAME_W;
        const fy = dir * FRAME_H;
        const bodyRows = bodyMask[dir][frame];

        for (let ly = 12; ly <= HEAD_REGION_END; ly++) {
          if (!bodyRows[ly]) continue;
          for (const lx of bodyRows[ly]) {
            const idx = ((fy + ly) * w + (fx + lx)) * ch;
            if (data[idx + 3] === 0) {
              // Hair is transparent here AND body is opaque → face gap
              gap[dir][frame].add(`${ly},${lx}`);
            }
          }
        }
      }
    }
  }

  // Log stats
  let total = 0;
  for (let d = 0; d < DIRS; d++)
    for (let f = 0; f < FRAMES; f++)
      total += gap[d][f].size;
  console.log(`Face gap pixels found: ${total} across all dir/frame combos`);

  return gap;
}

// --- Step 3: Generate clothing for each outfit ---

async function generateClothing(filename, bodyMask, faceGap) {
  const filepath = path.join(CLOTHES_DIR, filename);
  const meta = await sharp(filepath).metadata();
  const w = meta.width, h = meta.height, ch = meta.channels;

  // Start with fully transparent buffer
  const buf = Buffer.alloc(w * h * ch, 0);

  const VARIANTS = Math.floor(w / (FRAME_W * FRAMES));
  const palettes = OUTFIT_PALETTES[filename];

  if (!palettes) {
    console.log(`  SKIP ${filename}: no palette defined`);
    return;
  }

  console.log(`${filename}: ${w}x${h}, ${VARIANTS} variants, ${ch}ch`);

  for (let variant = 0; variant < VARIANTS; variant++) {
    const pal = palettes[variant] || palettes[0];

    for (let dir = 0; dir < DIRS; dir++) {
      for (let frame = 0; frame < FRAMES; frame++) {
        const bodyRows = bodyMask[dir][frame];
        const ox = (variant * FRAMES + frame) * FRAME_W;
        const oy = dir * FRAME_H;

        // Draw clothing on rows 15-31 (shirt starts at row 15 = shoulders)
        for (let ly = 15; ly <= 31; ly++) {
          if (!bodyRows[ly]) continue;

          for (const lx of bodyRows[ly]) {
            // In head region: skip face gap pixels (face shows through)
            if (ly <= HEAD_REGION_END) {
              if (faceGap[dir][frame].has(`${ly},${lx}`)) continue;
            }

            // Determine edge vs fill
            const cols = bodyRows[ly];
            const isEdge = (lx === cols[0] || lx === cols[cols.length - 1]);

            // Pick color based on zone
            let color;
            if (ly <= 23) {
              // Shirt zone
              color = isEdge ? pal.se : pal.shirt;
            } else if (ly <= 28) {
              // Pants zone
              color = isEdge ? pal.pe : pal.pants;
            } else {
              // Shoes zone
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
  console.log(`  ✓ saved ${filename}`);
}

// --- Main ---

async function main() {
  console.log('Step 1: Extracting body shape mask...');
  const bodyMask = await getBodyMask();

  // Log body shape for first frame (dir 0, frame 0)
  const f0 = bodyMask[0][0];
  for (let ly = 10; ly <= 31; ly++) {
    if (f0[ly]) {
      console.log(`  row ${ly}: cols ${f0[ly][0]}-${f0[ly][f0[ly].length - 1]} (${f0[ly].length}px wide)`);
    }
  }

  console.log('\nStep 2: Analyzing hair sprites for face gaps...');
  const faceGap = await getFaceGapMask(bodyMask);

  // Log face gap for first frame
  const gapRows = {};
  for (const key of faceGap[0][0]) {
    const [r, c] = key.split(',').map(Number);
    if (!gapRows[r]) gapRows[r] = [];
    gapRows[r].push(c);
  }
  for (let ly = 12; ly <= HEAD_REGION_END; ly++) {
    if (gapRows[ly]) {
      gapRows[ly].sort((a, b) => a - b);
      console.log(`  face gap row ${ly}: cols ${gapRows[ly][0]}-${gapRows[ly][gapRows[ly].length - 1]} (${gapRows[ly].length}px)`);
    }
  }

  console.log('\nStep 3: Generating clothing sprites...');
  for (const f of Object.keys(OUTFIT_PALETTES)) {
    await generateClothing(f, bodyMask, faceGap);
  }

  console.log('\nDone!');
}

main().catch(console.error);
