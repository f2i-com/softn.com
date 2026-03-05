const sharp = require('sharp');

async function run() {
  const img = sharp('bundles/TheOffice/assets/office_32x32.png');
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  
  const COLS = 16;
  const TILE_SIZE = 32;
  const CHANNELS = info.channels;
  
  // We want to look at rows 22 to 26 (indices 352 to 431)
  const START_ROW = 22;
  const END_ROW = 26;
  
  for (let r = START_ROW; r <= END_ROW; r++) {
    for (let c = 0; c < COLS; c++) {
      const idx = r * COLS + c;
      // Let's sample the center pixel of each tile
      const px = c * TILE_SIZE + 16;
      const py = r * TILE_SIZE + 16;
      const offset = (py * info.width + px) * CHANNELS;
      
      const r_val = data[offset];
      const g_val = data[offset + 1];
      const b_val = data[offset + 2];
      const a_val = CHANNELS === 4 ? data[offset + 3] : 255;
      
      // Let's also check the edges (top, right, bottom, left) to see if it connects
      const topOffset = ((r * TILE_SIZE) * info.width + px) * CHANNELS;
      const bottomOffset = ((r * TILE_SIZE + 31) * info.width + px) * CHANNELS;
      
      const a_top = CHANNELS === 4 ? data[topOffset + 3] : 255;
      const a_bottom = CHANNELS === 4 ? data[bottomOffset + 3] : 255;
      
      console.log(`Tile ${idx.toString().padStart(3, ' ')} (${r},${c}): rgba(${r_val},${g_val},${b_val},${a_val}) | a_top:${a_top} a_bot:${a_bottom}`);
    }
  }
}
run();
