// Regression: every scene spawn must be clear of wall geometry.
const fs = require('fs');
const dir = __dirname + '/';
const w = fs.readFileSync(dir + 'logic/world.logic', 'utf8');
const m = fs.readFileSync(dir + 'logic/main.logic', 'utf8');

function grid(name) {
  const start = w.indexOf('let ' + name + ' = [');
  const end = w.indexOf(']', start);
  return w.slice(start, end).split('\n').slice(1)
    .map(s => s.trim().replace(/["',]/g, '')).filter(Boolean);
}
const G = {
  OFFICE_ROWS: grid('OFFICE_ROWS'),
  FLAT_ROWS: grid('FLAT_ROWS'),
  BAKERY_ROWS: grid('BAKERY_ROWS'),
  DREAM_ROWS: grid('DREAM_ROWS'),
};
const CELL = 2, R = 0.35;
function solid(rows, px, pz) {
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      if (rows[r][c] !== '#') continue;
      if (px + R > c * CELL - 1 && px - R < c * CELL + 1 &&
          pz + R > r * CELL - 1 && pz - R < r * CELL + 1) return 'row' + r + ' col' + c;
    }
  }
  return null;
}

const checks = [];
for (const name of Object.keys(G)) {
  const rows = G[name];
  for (let r = 0; r < rows.length; r++) {
    const c = rows[r].indexOf('S');
    if (c >= 0) checks.push([name + ' spawn', rows, c * CELL, r * CELL]);
  }
}
// Hand-set spawns written directly in main.logic.
const hand = [...m.matchAll(/playerX = ([\d.]+)\s*\n\s*playerZ = ([\d.]+)/g)].map(x => [parseFloat(x[1]), parseFloat(x[2])]);
for (const [x, z] of hand) checks.push(['hand spawn (office grid)', G.OFFICE_ROWS, x, z]);

let bad = 0;
for (const [label, rows, x, z] of checks) {
  const hit = solid(rows, x, z);
  if (hit) { bad++; console.log('FAIL ' + label + ' (' + x + ',' + z + ') inside ' + hit); }
  else console.log('ok   ' + label + ' (' + x + ',' + z + ')');
}
console.log(bad === 0 ? 'ALL SPAWNS CLEAR' : bad + ' BAD SPAWN(S)');
process.exit(bad === 0 ? 0 : 1);
