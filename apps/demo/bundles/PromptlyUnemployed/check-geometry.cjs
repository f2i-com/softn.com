// Scene3D fills in defaults for missing dimensions: radius 0.5, width/height/
// depth 1, colour white. So a sphere that forgets its radius does not vanish —
// it becomes a one-metre white ball parked in the middle of the furniture.
// This walks every scene builder and fails on any object that would inherit one.
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'logic');
const src = ['data.logic', 'dialogue.logic', 'world.logic', 'main.logic']
  .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');

const sandbox = {
  window: { addEventListener() {}, removeEventListener() {} },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  navigator: { clipboard: { writeText() {} } },
  softn: { audio: { play() {}, stop() {}, stopAll() {}, setVolume() {} } },
  console, Math, Date, JSON, String, Number, Array, Object, parseInt, parseFloat,
};

// Which fields Scene3D actually reads for each geometry.
const NEEDS = {
  sphere: ['radius'],
  icosahedron: ['radius'],
  octahedron: ['radius'],
  dodecahedron: ['radius'],
  ring: ['radius'],
  torus: ['radius'],
  cylinder: ['radius', 'height'],
  cone: ['radius', 'height'],
  box: ['width', 'height', 'depth'],
  plane: ['width', 'height'],
};

const SCENES = ['buildOffice', 'buildBoxes', 'buildMeeting', 'buildFlat', 'buildBakery', 'buildDream'];

const exposed = SCENES.map((n) => `${n}: typeof ${n} === 'function' ? ${n} : null`).join(', ');
const fn = new Function(
  ...Object.keys(sandbox),
  `${src}\n;return { ${exposed}, getObjects: function () { return objects } };`
);
const api = fn(...Object.values(sandbox));

const problems = [];
let checked = 0;

for (const name of SCENES) {
  if (!api[name]) { problems.push(`${name}: builder not found`); continue; }
  try { api[name](); } catch (err) { problems.push(`${name}: threw ${err.message}`); continue; }

  for (const obj of api.getObjects() || []) {
    checked++;
    const type = obj.type || '(missing type)';
    const needs = NEEDS[type];
    if (!needs) { problems.push(`${name}/${obj.id}: unknown type "${type}" — renders as a 1m box`); continue; }

    for (const field of needs) {
      const v = obj[field];
      if (v === undefined || v === null) {
        problems.push(`${name}/${obj.id}: ${type} has no ${field} — Scene3D substitutes ${field === 'radius' ? '0.5 (a 1m ball)' : '1'}`);
      } else if (typeof v !== 'number' || !isFinite(v)) {
        problems.push(`${name}/${obj.id}: ${type} ${field} is ${JSON.stringify(v)}`);
      }
    }
    if (!obj.color) problems.push(`${name}/${obj.id}: no colour — renders white`);
    const p = obj.position;
    if (!p || ['x', 'y', 'z'].some((k) => typeof p[k] !== 'number' || !isFinite(p[k]))) {
      problems.push(`${name}/${obj.id}: bad position ${JSON.stringify(p)}`);
    }
  }
}

console.log(`checked ${checked} objects across ${SCENES.length} scenes`);
if (problems.length === 0) {
  console.log('ALL GEOMETRY COMPLETE');
  process.exit(0);
}
console.log(`\n${problems.length} problem(s):`);
for (const p of problems) console.log('  ' + p);
process.exit(1);
