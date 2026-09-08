/**
 * A glTF 2.0 binary the bench can hand to Scene3D without shipping a model in
 * the repository.
 *
 * One tetrahedron with flat normals, roughly a kilobyte. Small on purpose: the
 * scene scenarios measure what mounting a model costs the runtime — the loader
 * modules, the renderer, the first draw — not how long a large mesh takes to
 * decode, and a fixture generated from code cannot drift from what the results
 * say it was. The layout follows the specification's binary container: a
 * 12-byte header, a JSON chunk padded with spaces, a BIN chunk padded with
 * zeros.
 */

const MAGIC = 0x46546c67; // 'glTF'
const JSON_CHUNK = 0x4e4f534a; // 'JSON'
const BIN_CHUNK = 0x004e4942; // 'BIN\0'
const FLOAT = 5126;
const ARRAY_BUFFER = 34962;

/** Unit-ish tetrahedron: four faces, each its own three vertices so normals stay flat. */
function tetrahedron() {
  const s = 0.8;
  const corners = [
    [s, s, s],
    [s, -s, -s],
    [-s, s, -s],
    [-s, -s, s],
  ];
  const faces = [
    [0, 1, 2],
    [0, 3, 1],
    [0, 2, 3],
    [1, 3, 2],
  ];
  const positions = [];
  const normals = [];
  for (const [a, b, c] of faces) {
    const [pa, pb, pc] = [corners[a], corners[b], corners[c]];
    const u = pb.map((v, i) => v - pa[i]);
    const w = pc.map((v, i) => v - pa[i]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(...n) || 1;
    for (const p of [pa, pb, pc]) {
      positions.push(...p);
      normals.push(n[0] / len, n[1] / len, n[2] / len);
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals) };
}

function bounds(array) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < array.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], array[i + k]);
      max[k] = Math.max(max[k], array[i + k]);
    }
  }
  return { min, max };
}

function padTo4(length, fill) {
  const rest = length % 4;
  return rest === 0 ? new Uint8Array(0) : new Uint8Array(4 - rest).fill(fill);
}

/** @returns {Uint8Array} a complete .glb */
export function makeGlb({ color = [0.93, 0.62, 0.2, 1] } = {}) {
  const mesh = tetrahedron();
  const positionBytes = new Uint8Array(mesh.positions.buffer);
  const normalBytes = new Uint8Array(mesh.normals.buffer);
  const bin = new Uint8Array(positionBytes.length + normalBytes.length);
  bin.set(positionBytes, 0);
  bin.set(normalBytes, positionBytes.length);
  const { min, max } = bounds(mesh.positions);
  const count = mesh.positions.length / 3;

  const json = {
    asset: { version: '2.0', generator: 'softn scripts/bench/glb.mjs' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'BenchTetrahedron' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, material: 0 }] }],
    materials: [
      {
        name: 'BenchMaterial',
        pbrMetallicRoughness: { baseColorFactor: color, metallicFactor: 0.1, roughnessFactor: 0.6 },
      },
    ],
    accessors: [
      { bufferView: 0, componentType: FLOAT, count, type: 'VEC3', min, max },
      { bufferView: 1, componentType: FLOAT, count, type: 'VEC3' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes.length, target: ARRAY_BUFFER },
      {
        buffer: 0,
        byteOffset: positionBytes.length,
        byteLength: normalBytes.length,
        target: ARRAY_BUFFER,
      },
    ],
    buffers: [{ byteLength: bin.length }],
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = padTo4(jsonBytes.length, 0x20);
  const binPad = padTo4(bin.length, 0);
  const jsonLength = jsonBytes.length + jsonPad.length;
  const binLength = bin.length + binPad.length;
  const total = 12 + 8 + jsonLength + 8 + binLength;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  view.setUint32(at, MAGIC, true);
  view.setUint32(at + 4, 2, true);
  view.setUint32(at + 8, total, true);
  at += 12;
  view.setUint32(at, jsonLength, true);
  view.setUint32(at + 4, JSON_CHUNK, true);
  at += 8;
  out.set(jsonBytes, at);
  out.set(jsonPad, at + jsonBytes.length);
  at += jsonLength;
  view.setUint32(at, binLength, true);
  view.setUint32(at + 4, BIN_CHUNK, true);
  at += 8;
  out.set(bin, at);
  out.set(binPad, at + bin.length);
  return out;
}
