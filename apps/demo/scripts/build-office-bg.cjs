/**
 * Build Office Background
 *
 * Composites tiles from office_32x32.png tileset into an office floor plan.
 * Uses sharp for image manipulation.
 *
 * Usage: node scripts/build-office-bg.cjs
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const TILE = 32;
const TILESET_COLS = 16;
const TILESET_PATH = path.resolve(__dirname, '../../../../..', 'TheOffice-UI-App-27thJune2024/assets/office_32x32.png');
const OUTPUT_PATH = path.resolve(__dirname, '../bundles/TheOffice/assets/office_bg.png');

// Map dimensions (tiles)
const MAP_W = 40;
const MAP_H = 25;

// ── Tile index constants ──────────────────────────────
// Tile index = row * 16 + col  (tileset is 16 tiles wide)
// -1 = empty/transparent

// Floor tiles (bottom rows of tileset)
const CARPET_A  = 992;   // row 62, col 0 — gray carpet
const CARPET_B  = 993;   // row 62, col 1 — gray carpet variant
const CARPET_C  = 994;   // row 62, col 2 — gray carpet variant
const CARPET_D  = 995;   // row 62, col 3 — gray carpet variant

const WOOD_A    = 1000;  // row 62, col 8 — tan/wood floor
const WOOD_B    = 1001;  // row 62, col 9 — tan/wood floor variant

const TILE_A    = 1008;  // row 63, col 0 — light tile floor
const TILE_B    = 1009;  // row 63, col 1
const TILE_C    = 1010;  // row 63, col 2
const TILE_D    = 1011;  // row 63, col 3

const DARK_A    = 1012;  // row 63, col 4 — darker floor
const DARK_B    = 1013;  // row 63, col 5

const STONE_A   = 1024;  // row 64, col 0 — stone floor
const STONE_B   = 1025;  // row 64, col 1
const STONE_C   = 1026;  // row 64, col 2

const BRICK_A   = 1032;  // row 64, col 8 — brick/tan
const BRICK_B   = 1033;  // row 64, col 9

// Wall-frame tiles (rows ~56-58)
const WALL_LINE_H  = 912;  // row 57, col 0 — horizontal wall line
const WALL_LINE_V  = 913;  // row 57, col 1 — vertical wall line
const WALL_CORNER_TL = 914; // row 57, col 2
const WALL_CORNER_TR = 915;
const WALL_CORNER_BL = 916;
const WALL_CORNER_BR = 917;
const WALL_T_DOWN = 918;
const WALL_T_UP = 919;
const WALL_T_RIGHT = 920;
const WALL_T_LEFT = 921;
const WALL_CROSS = 922;
const WALL_DOOR_H = 923;

// Furniture (various rows in upper tileset)
// Row 0-1: Desks (large tan desks, 2×2 each)
const DESK_TL  = 0;   // top-left of 2×2 desk
const DESK_TR  = 1;
const DESK_BL  = 16;
const DESK_BR  = 17;

const DESK2_TL = 2;
const DESK2_TR = 3;
const DESK2_BL = 18;
const DESK2_BR = 19;

const DESK3_TL = 4;
const DESK3_TR = 5;
const DESK3_BL = 20;
const DESK3_BR = 21;

// Chairs (row 4 area)
const CHAIR_1  = 64;  // office chair facing down
const CHAIR_2  = 65;  // office chair facing right
const CHAIR_3  = 66;  // another chair variant
const CHAIR_4  = 67;  // another

// Plant
const PLANT_1  = 68;  // potted plant
const PLANT_2  = 69;  // bigger plant

// Screens / monitors (row 4-5)
const MONITOR_1 = 70;
const MONITOR_2 = 71;
const SCREEN_1  = 72;
const PRINTER_1 = 73;
const MONITOR_3 = 74;
const MONITOR_4 = 75;

// Row 5: Brown chairs, framed items
const BROWN_CHAIR_1 = 80;
const BROWN_CHAIR_2 = 81;
const BROWN_CHAIR_3 = 82;
const BROWN_CHAIR_4 = 83;

// Art / decorations (row 6)
const ART_1 = 96;
const ART_2 = 97;
const ART_3 = 98;

// Colored seats (row 8)
const SEAT_BLUE   = 128;
const SEAT_GRAY   = 129;
const SEAT_GREEN  = 130;
const SEAT_GOLD   = 131;

// Couches (row 9)
const COUCH_L  = 144;  // left end
const COUCH_M  = 145;  // middle
const COUCH_R  = 146;  // right end

// Bookshelf / cabinet
const CABINET_1 = 147;
const CABINET_2 = 148;

// Vending machines (row 12)
const VENDING_1 = 192;
const VENDING_2 = 193;

// Partitions / dividers (row ~25-27 area - wider horizontal pieces)
// These appear as long gray horizontal bars
const DIVIDER_L = 400;
const DIVIDER_M = 401;
const DIVIDER_R = 402;

// ── The Office Floor Plan ─────────────────────────────
// Two layers: bg (floor) and obj (furniture on top)

function createFloorLayer() {
  const map = [];
  for (let y = 0; y < MAP_H; y++) {
    const row = [];
    for (let x = 0; x < MAP_W; x++) {
      // Default: gray carpet
      // Use slight variation for visual interest
      const variants = [CARPET_A, CARPET_B, CARPET_C, CARPET_D];
      const hash = ((x * 7 + y * 13) % 4);
      row.push(variants[hash]);
    }
    map.push(row);
  }

  // Michael's office (top-left) — wood floor
  for (let y = 1; y <= 7; y++) {
    for (let x = 1; x <= 9; x++) {
      const v = [WOOD_A, WOOD_B][(x + y) % 2];
      map[y][x] = v;
    }
  }

  // Conference room (top-right) — tile floor
  for (let y = 1; y <= 7; y++) {
    for (let x = 28; x <= 38; x++) {
      const v = [TILE_A, TILE_B, TILE_C, TILE_D][(x + y) % 4];
      map[y][x] = v;
    }
  }

  // Break room (bottom-right) — different floor
  for (let y = 18; y <= 23; y++) {
    for (let x = 30; x <= 38; x++) {
      const v = [TILE_A, TILE_C][(x + y) % 2];
      map[y][x] = v;
    }
  }

  return map;
}

function createObjectLayer() {
  const map = [];
  for (let y = 0; y < MAP_H; y++) {
    map.push(new Array(MAP_W).fill(-1));
  }

  // ── Walls ──
  // Top wall
  for (let x = 0; x < MAP_W; x++) map[0][x] = WALL_LINE_H;
  // Bottom wall
  for (let x = 0; x < MAP_W; x++) map[MAP_H - 1][x] = WALL_LINE_H;
  // Left wall
  for (let y = 0; y < MAP_H; y++) map[y][0] = WALL_LINE_V;
  // Right wall
  for (let y = 0; y < MAP_H; y++) map[y][MAP_W - 1] = WALL_LINE_V;
  // Corners
  map[0][0] = WALL_CORNER_TL;
  map[0][MAP_W - 1] = WALL_CORNER_TR;
  map[MAP_H - 1][0] = WALL_CORNER_BL;
  map[MAP_H - 1][MAP_W - 1] = WALL_CORNER_BR;

  // ── Michael's office walls (top-left, 10×8 room) ──
  // Right wall of office
  for (let y = 0; y <= 8; y++) map[y][10] = WALL_LINE_V;
  // Bottom wall of office
  for (let x = 0; x <= 10; x++) map[8][x] = WALL_LINE_H;
  // Door gap
  map[8][5] = -1;
  map[8][6] = -1;
  // Corner
  map[0][10] = WALL_T_DOWN;
  map[8][0] = WALL_T_RIGHT;
  map[8][10] = WALL_CORNER_BR;

  // ── Conference room walls (top-right, 12×8 room) ──
  // Left wall
  for (let y = 0; y <= 8; y++) map[y][27] = WALL_LINE_V;
  // Bottom wall
  for (let x = 27; x < MAP_W; x++) map[8][x] = WALL_LINE_H;
  // Door gap
  map[8][32] = -1;
  map[8][33] = -1;
  // Corners
  map[0][27] = WALL_T_DOWN;
  map[8][27] = WALL_CORNER_BL;
  map[8][MAP_W - 1] = WALL_T_LEFT;

  // ── Break room (bottom-right, separated by wall) ──
  for (let y = 17; y < MAP_H; y++) map[y][29] = WALL_LINE_V;
  for (let x = 29; x < MAP_W; x++) map[17][x] = WALL_LINE_H;
  map[17][29] = WALL_CORNER_TL;
  map[17][MAP_W - 1] = WALL_T_LEFT;
  map[MAP_H - 1][29] = WALL_T_UP;
  // Door
  map[17][34] = -1;
  map[17][35] = -1;

  // ── Furniture: Michael's office ──
  // Desk
  map[3][3] = DESK_TL;
  map[3][4] = DESK_TR;
  map[4][3] = DESK_BL;
  map[4][4] = DESK_BR;
  // Chair behind desk
  map[5][3] = CHAIR_1;
  // Monitor on desk
  map[3][5] = MONITOR_1;
  // Plant in corner
  map[1][1] = PLANT_1;
  // Art on wall area
  map[1][5] = ART_1;

  // ── Furniture: Conference room ──
  // Long table (4×2)
  map[3][31] = DESK2_TL;
  map[3][32] = DESK2_TR;
  map[4][31] = DESK2_BL;
  map[4][32] = DESK2_BR;
  map[3][33] = DESK2_TL;
  map[3][34] = DESK2_TR;
  map[4][33] = DESK2_BL;
  map[4][34] = DESK2_BR;
  // Chairs around table
  map[2][31] = CHAIR_2;
  map[2][32] = CHAIR_3;
  map[2][33] = CHAIR_2;
  map[2][34] = CHAIR_3;
  map[5][31] = CHAIR_4;
  map[5][32] = CHAIR_1;
  map[5][33] = CHAIR_4;
  map[5][34] = CHAIR_1;
  // Screen/whiteboard
  map[1][32] = SCREEN_1;
  map[1][33] = MONITOR_3;

  // ── Open plan desk clusters (middle area) ──
  // Row 1 of desks (y=10-11)
  for (let cluster = 0; cluster < 4; cluster++) {
    const bx = 3 + cluster * 6;
    // Desk pair (facing each other)
    map[10][bx] = DESK3_TL;
    map[10][bx + 1] = DESK3_TR;
    map[11][bx] = DESK3_BL;
    map[11][bx + 1] = DESK3_BR;
    // Monitor
    map[10][bx + 2] = MONITOR_2;
    // Chairs
    map[9][bx] = CHAIR_2;
    map[12][bx] = CHAIR_1;
  }

  // Row 2 of desks (y=14-15)
  for (let cluster = 0; cluster < 4; cluster++) {
    const bx = 3 + cluster * 6;
    map[14][bx] = DESK_TL;
    map[14][bx + 1] = DESK_TR;
    map[15][bx] = DESK_BL;
    map[15][bx + 1] = DESK_BR;
    map[14][bx + 2] = MONITOR_4;
    map[13][bx] = CHAIR_3;
    map[16][bx] = CHAIR_4;
  }

  // Row 3 of desks (y=19-20, left side only — break room takes right)
  for (let cluster = 0; cluster < 3; cluster++) {
    const bx = 3 + cluster * 6;
    map[19][bx] = DESK2_TL;
    map[19][bx + 1] = DESK2_TR;
    map[20][bx] = DESK2_BL;
    map[20][bx + 1] = DESK2_BR;
    map[19][bx + 2] = MONITOR_1;
    map[18][bx] = CHAIR_2;
    map[21][bx] = CHAIR_1;
  }

  // ── Reception desk (center top, below wall) ──
  map[10][28] = DESK_TL;
  map[10][29] = DESK_TR;
  map[11][28] = DESK_BL;
  map[11][29] = DESK_BR;
  map[12][28] = CHAIR_1;
  map[10][30] = MONITOR_2;

  // ── Break room furniture ──
  // Table
  map[19][33] = DESK3_TL;
  map[19][34] = DESK3_TR;
  map[20][33] = DESK3_BL;
  map[20][34] = DESK3_BR;
  // Vending machine
  map[18][37] = VENDING_1;
  map[18][38] = VENDING_2;
  // Chairs
  map[21][33] = SEAT_BLUE;
  map[21][34] = SEAT_GREEN;
  map[19][36] = SEAT_GOLD;

  // ── Decorations ──
  // Plants along corridors
  map[9][27] = PLANT_2;
  map[16][27] = PLANT_1;
  map[9][0] = PLANT_1;
  // Printer station
  map[16][1] = PRINTER_1;
  // Couch in waiting area
  map[22][1] = COUCH_L;
  map[22][2] = COUCH_M;
  map[22][3] = COUCH_R;
  // Art
  map[9][15] = ART_2;
  map[9][20] = ART_3;

  return map;
}

async function extractTile(tilesetBuffer, tilesetMeta, tileIndex) {
  if (tileIndex < 0) return null;

  const col = tileIndex % TILESET_COLS;
  const row = Math.floor(tileIndex / TILESET_COLS);
  const left = col * TILE;
  const top = row * TILE;

  // Bounds check
  if (left + TILE > tilesetMeta.width || top + TILE > tilesetMeta.height) {
    return null;
  }

  return sharp(tilesetBuffer)
    .extract({ left, top, width: TILE, height: TILE })
    .png()
    .toBuffer();
}

async function main() {
  console.log('Building office background...');

  if (!fs.existsSync(TILESET_PATH)) {
    console.error('Tileset not found:', TILESET_PATH);
    process.exit(1);
  }

  const tilesetImage = sharp(TILESET_PATH);
  const tilesetMeta = await tilesetImage.metadata();
  const tilesetBuffer = await tilesetImage.toBuffer();

  console.log(`Tileset: ${tilesetMeta.width}x${tilesetMeta.height} (${Math.floor(tilesetMeta.width / TILE)}x${Math.floor(tilesetMeta.height / TILE)} tiles)`);

  const bgLayer = createFloorLayer();
  const objLayer = createObjectLayer();

  // Extract all unique tiles needed
  const tileCache = new Map();
  const allIndices = new Set();

  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (bgLayer[y][x] >= 0) allIndices.add(bgLayer[y][x]);
      if (objLayer[y][x] >= 0) allIndices.add(objLayer[y][x]);
    }
  }

  console.log(`Extracting ${allIndices.size} unique tiles...`);

  for (const idx of allIndices) {
    const buf = await extractTile(tilesetBuffer, tilesetMeta, idx);
    if (buf) {
      tileCache.set(idx, buf);
    } else {
      console.warn(`  Tile ${idx} out of bounds, skipping`);
    }
  }

  // Build composite operations
  const composites = [];

  // Background layer first
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const idx = bgLayer[y][x];
      if (idx >= 0 && tileCache.has(idx)) {
        composites.push({
          input: tileCache.get(idx),
          left: x * TILE,
          top: y * TILE,
        });
      }
    }
  }

  // Object layer on top
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const idx = objLayer[y][x];
      if (idx >= 0 && tileCache.has(idx)) {
        composites.push({
          input: tileCache.get(idx),
          left: x * TILE,
          top: y * TILE,
        });
      }
    }
  }

  console.log(`Compositing ${composites.length} tile placements onto ${MAP_W * TILE}x${MAP_H * TILE} canvas...`);

  // Create canvas and composite all tiles
  await sharp({
    create: {
      width: MAP_W * TILE,
      height: MAP_H * TILE,
      channels: 4,
      background: { r: 45, g: 45, b: 55, alpha: 255 },
    },
  })
    .composite(composites)
    .png()
    .toFile(OUTPUT_PATH);

  const stats = fs.statSync(OUTPUT_PATH);
  console.log(`Done! Output: ${OUTPUT_PATH}`);
  console.log(`Size: ${(stats.size / 1024).toFixed(1)} KB`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
