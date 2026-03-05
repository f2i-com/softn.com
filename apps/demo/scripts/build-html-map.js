const fs = require('fs');

const COLS = 16;
const ROWS = 65;

let html = `<html><body style="background: black; color: white;">`;
html += `<div style="display: grid; grid-template-columns: repeat(16, 32px); gap: 1px;">`;

for (let i = 0; i < COLS * ROWS; i++) {
  const r = Math.floor(i / COLS);
  const c = i % COLS;
  const bgX = -(c * 32);
  const bgY = -(r * 32);
  
  html += `<div style="
    width: 32px; 
    height: 32px; 
    background-image: url('assets/office_32x32.png'); 
    background-position: ${bgX}px ${bgY}px;
    position: relative;
    border: 1px solid #333;
  ">
    <span style="
      position: absolute; 
      top: 0; left: 0; 
      font-size: 8px; 
      background: rgba(0,0,0,0.5); 
      color: white;
    ">${i}</span>
  </div>`;
}

html += `</div></body></html>`;
fs.writeFileSync('bundles/TheOffice/map.html', html);
