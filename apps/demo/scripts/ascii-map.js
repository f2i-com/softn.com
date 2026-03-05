const sharp = require('sharp');

async function run() {
  const img = sharp('bundles/TheOffice/assets/office_32x32.png');
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  
  const COLS = 16;
  const ROWS = Math.floor(info.height / 32);
  const CHANNELS = info.channels;
  
  for (let r = 0; r < ROWS; r++) {
    let rowStr = `${r.toString().padStart(2, ' ')}: `;
    for (let c = 0; c < COLS; c++) {
      const px = c * 32 + 16;
      const py = r * 32 + 16;
      const offset = (py * info.width + px) * CHANNELS;
      const a_val = CHANNELS === 4 ? data[offset + 3] : 255;
      
      rowStr += (a_val > 50) ? '[]' : '..';
    }
    console.log(rowStr);
  }
}
run();
