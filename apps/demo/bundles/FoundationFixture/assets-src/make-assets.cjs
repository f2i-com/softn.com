/**
 * Hand-authors the fixture's two assets:
 *
 *   assets/models/spinner.glb — one cube, one material, one 2s "Spin" clip
 *   assets/audio/beep.wav     — 0.5s 440 Hz sine, 16-bit mono 24 kHz
 *
 * Authored bytes, not exported ones, so every header field is accountable and
 * the fixture carries no toolchain provenance. No embedded textures — the
 * material is factors only; texture round-tripping is outside this fixture's
 * scope. This script lives beside assets/, not inside it, and is absent from
 * the manifest, so the bundle never carries it.
 *
 * Usage: node make-assets.cjs — writes both files, then re-reads them and
 * exits non-zero if any header field or alignment is off.
 */

const fs = require('fs');
const path = require('path');

const assetsDir = path.join(__dirname, '..', 'assets');

// ── spinner.glb ─────────────────────────────────────────────────────────────

// 24 vertices, 4 per face, so each face keeps its own flat normal. Winding is
// CCW viewed from outside — the cross product of each face's first two edges
// must equal its normal, or the cube renders inside-out.
const FACES = [
  { n: [1, 0, 0], v: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]] },
  { n: [-1, 0, 0], v: [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]] },
  { n: [0, 1, 0], v: [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]] },
  { n: [0, -1, 0], v: [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]] },
  { n: [0, 0, 1], v: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { n: [0, 0, -1], v: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
];

const positions = new Float32Array(24 * 3);
const normals = new Float32Array(24 * 3);
const indices = new Uint16Array(36);
FACES.forEach((face, f) => {
  face.v.forEach((vert, i) => {
    positions.set(vert, (f * 4 + i) * 3);
    normals.set(face.n, (f * 4 + i) * 3);
  });
  // Two CCW triangles per quad: (0,1,2) and (0,2,3)
  indices.set([f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3], f * 6);
});

// "Spin": one full turn about Y over 2s, LINEAR, 4 keyframes. A Y rotation of
// θ is the quaternion (0, sin(θ/2), 0, cos(θ/2)); four evenly spaced stops
// keep every linear segment under 180°, which slerp-from-lerp requires.
const CLIP_SECONDS = 2;
const KEYFRAMES = 4;
const times = new Float32Array(KEYFRAMES);
const rotations = new Float32Array(KEYFRAMES * 4);
for (let k = 0; k < KEYFRAMES; k++) {
  const theta = (k / (KEYFRAMES - 1)) * 2 * Math.PI;
  times[k] = (k / (KEYFRAMES - 1)) * CLIP_SECONDS;
  rotations.set([0, Math.sin(theta / 2), 0, Math.cos(theta / 2)], k * 4);
}

// Buffer layout. Each section must start 4-byte aligned; the 72-byte index
// block lands on a multiple of 4 already, so no padding is needed between any
// of them — but the offsets are still computed, not assumed.
const sections = [positions, normals, indices, times, rotations].map((arr) => Buffer.from(arr.buffer));
const offsets = [];
let running = 0;
for (const s of sections) {
  if (running % 4 !== 0) throw new Error(`section at ${running} is not 4-byte aligned`);
  offsets.push(running);
  running += s.length;
}
const bin = Buffer.concat(sections);

const gltf = {
  asset: { version: '2.0', generator: 'FoundationFixture make-assets.cjs' },
  scene: 0,
  scenes: [{ name: 'Scene', nodes: [0] }],
  nodes: [{ name: 'Spinner', mesh: 0 }],
  meshes: [{ name: 'SpinnerCube', primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
  materials: [{
    name: 'SpinnerMaterial',
    pbrMetallicRoughness: { baseColorFactor: [0.39, 0.46, 0.95, 1.0], metallicFactor: 0.3, roughnessFactor: 0.45 },
  }],
  animations: [{
    name: 'Spin',
    samplers: [{ input: 3, interpolation: 'LINEAR', output: 4 }],
    channels: [{ sampler: 0, target: { node: 0, path: 'rotation' } }],
  }],
  accessors: [
    // POSITION requires min/max; so does an animation sampler's input.
    { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-1, -1, -1], max: [1, 1, 1] },
    { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
    { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' },
    { bufferView: 3, componentType: 5126, count: KEYFRAMES, type: 'SCALAR', min: [0], max: [CLIP_SECONDS] },
    { bufferView: 4, componentType: 5126, count: KEYFRAMES, type: 'VEC4' },
  ],
  bufferViews: [
    { buffer: 0, byteOffset: offsets[0], byteLength: sections[0].length, target: 34962 },
    { buffer: 0, byteOffset: offsets[1], byteLength: sections[1].length, target: 34962 },
    { buffer: 0, byteOffset: offsets[2], byteLength: sections[2].length, target: 34963 },
    // Animation data may not carry a GL buffer target.
    { buffer: 0, byteOffset: offsets[3], byteLength: sections[3].length },
    { buffer: 0, byteOffset: offsets[4], byteLength: sections[4].length },
  ],
  buffers: [{ byteLength: bin.length }],
};

function buildGlb(json, binChunk) {
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf-8');
  // JSON chunks pad with spaces, BIN chunks with zeros — the spec assigns each
  // chunk type its own filler.
  const jsonPadded = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const binPadded = Buffer.concat([binChunk, Buffer.alloc((4 - (binChunk.length % 4)) % 4, 0x00)]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // 'glTF'
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + binPadded.length, 8);

  const jsonChunkHeader = Buffer.alloc(8);
  jsonChunkHeader.writeUInt32LE(jsonPadded.length, 0);
  jsonChunkHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'

  const binChunkHeader = Buffer.alloc(8);
  binChunkHeader.writeUInt32LE(binPadded.length, 0);
  binChunkHeader.writeUInt32LE(0x004e4942, 4); // 'BIN\0'

  return Buffer.concat([header, jsonChunkHeader, jsonPadded, binChunkHeader, binPadded]);
}

// ── beep.wav ────────────────────────────────────────────────────────────────

const SAMPLE_RATE = 24000;
const FREQ_HZ = 440;
const DURATION_S = 0.5;
const AMPLITUDE = 0.6;
const FADE_SAMPLES = Math.round(SAMPLE_RATE * 0.005); // 5ms ramps so start/stop do not click

function buildWav() {
  const count = Math.round(SAMPLE_RATE * DURATION_S);
  const data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    let s = Math.sin((2 * Math.PI * FREQ_HZ * i) / SAMPLE_RATE) * AMPLITUDE;
    if (i < FADE_SAMPLES) s *= i / FADE_SAMPLES;
    if (count - 1 - i < FADE_SAMPLES) s *= (count - 1 - i) / FADE_SAMPLES;
    data.writeInt16LE(Math.round(s * 32767), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// ── write, then verify from a re-read ───────────────────────────────────────

let failed = false;
function check(cond, msg) {
  if (cond) {
    console.log(`  ok: ${msg}`);
  } else {
    console.error(`  FAIL: ${msg}`);
    failed = true;
  }
}

const glbPath = path.join(assetsDir, 'models', 'spinner.glb');
const wavPath = path.join(assetsDir, 'audio', 'beep.wav');
fs.mkdirSync(path.dirname(glbPath), { recursive: true });
fs.mkdirSync(path.dirname(wavPath), { recursive: true });
fs.writeFileSync(glbPath, buildGlb(gltf, bin));
fs.writeFileSync(wavPath, buildWav());

console.log(`spinner.glb (${fs.statSync(glbPath).size} bytes)`);
const glb = fs.readFileSync(glbPath);
check(glb.readUInt32LE(0) === 0x46546c67, 'magic is glTF');
check(glb.readUInt32LE(4) === 2, 'container version is 2');
check(glb.readUInt32LE(8) === glb.length, 'header length matches file size');
const jsonLen = glb.readUInt32LE(12);
check(glb.readUInt32LE(16) === 0x4e4f534a, 'chunk 0 type is JSON');
check(jsonLen % 4 === 0, 'JSON chunk length is 4-byte aligned');
const binOffset = 20 + jsonLen;
const binLen = glb.readUInt32LE(binOffset);
check(glb.readUInt32LE(binOffset + 4) === 0x004e4942, 'chunk 1 type is BIN');
check(binLen % 4 === 0, 'BIN chunk length is 4-byte aligned');
check(binOffset + 8 + binLen === glb.length, 'chunks account for every byte');
const reread = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf-8'));
check(reread.animations?.[0]?.name === 'Spin', 'animation clip "Spin" present');
check(reread.buffers?.[0]?.byteLength <= binLen, 'declared buffer fits the BIN chunk');

console.log(`beep.wav (${fs.statSync(wavPath).size} bytes)`);
const wav = fs.readFileSync(wavPath);
check(wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE', 'RIFF/WAVE tags');
check(wav.readUInt32LE(4) === wav.length - 8, 'RIFF size matches file size');
check(wav.readUInt16LE(20) === 1 && wav.readUInt16LE(22) === 1, 'PCM, mono');
check(wav.readUInt32LE(24) === SAMPLE_RATE && wav.readUInt16LE(34) === 16, '24 kHz, 16-bit');
check(wav.readUInt32LE(40) === wav.length - 44, 'data chunk covers the samples');

process.exit(failed ? 1 : 0);
