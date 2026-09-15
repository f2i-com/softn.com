/**
 * Is this file a copy of the ZIPP engine? Decided by what the module exports,
 * not by its name: Vite renames the engine (`zipp_wasm_bg-<hash>.wasm`), and a
 * copy under a name nobody thought to look for would otherwise ship unchecked.
 *
 * Reads the export section directly; nothing is compiled, so scanning every
 * entry of a release archive costs a few milliseconds.
 */
import { createHash } from 'node:crypto';

/** Exports the engine has and no other module in a SoftN build does (gpu-lab kernels, the WASI guest). */
export const ZIPP_ENGINE_EXPORTS = ['zippProfile', 'zipp_start', 'engine_evalInContext'];

/** The export names of a WebAssembly binary, or null for anything that is not one. */
export function wasmExportNames(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 8 || b[0] !== 0x00 || b[1] !== 0x61 || b[2] !== 0x73 || b[3] !== 0x6d) return null;
  let offset = 8;
  const leb = () => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      if (offset >= b.length || shift > 28) throw new RangeError('malformed LEB128');
      const byte = b[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return value;
    }
  };
  const decoder = new TextDecoder();
  try {
    while (offset < b.length) {
      const id = b[offset++];
      const end = leb() + offset;
      if (end > b.length) return null;
      if (id === 7) {
        const names = [];
        for (let count = leb(); count > 0; count--) {
          const length = leb();
          if (offset + length > end) return null;
          names.push(decoder.decode(b.subarray(offset, offset + length)));
          offset += length + 1; // the name, then the kind byte
          leb(); // the index
        }
        return names;
      }
      offset = end;
    }
    return [];
  } catch {
    return null;
  }
}

export function isZippEngineWasm(bytes) {
  const names = wasmExportNames(bytes);
  return names !== null && ZIPP_ENGINE_EXPORTS.every((name) => names.includes(name));
}

/** Where FormLogic takes a copy of the engine from in softn-formlogic-runtime-<tag>.zip; each must hold one. */
export const KNOWN_ENGINE_COPIES = [
  /^zipp\/zipp_wasm_bg\.wasm$/,
  /^native-runtime\/wasm\/zipp_wasm_bg\.wasm$/,
  ...['hosted-runtime', 'app-editors/builder', 'app-editors/studio'].flatMap((prefix) => [
    new RegExp(`^${prefix}/assets/zipp_wasm_bg-[^/]+\\.wasm$`),
    new RegExp(`^${prefix}/assets/core-runtime/zipp_wasm_bg\\.wasm$`),
  ]),
];

/**
 * The engine in an archive's entries (name to bytes, or to {data, mode}):
 * every copy, found by its exports, is the installed release `source`
 * (its SOURCE.json), every known place holds one, and the native runtime's
 * glue is zipp/'s. Returns the copies and what is wrong, as sentences.
 */
export function archiveEngineProblems(entries, source, { known = KNOWN_ENGINE_COPIES } = {}) {
  const bytesOf = (name) => {
    const value = entries.get(name);
    return value === undefined || value instanceof Uint8Array ? value : value.data;
  };
  const problems = [];
  const copies = [...entries.keys()].filter((name) => isZippEngineWasm(bytesOf(name)));
  for (const name of copies) {
    if (createHash('sha256').update(bytesOf(name)).digest('hex') !== source.sha256) problems.push(`${name} is a ZIPP engine, but not ZIPP ${source.release} (${source.sha256.slice(0, 12)})`);
  }
  for (const pattern of known) if (!copies.some((name) => pattern.test(name))) problems.push(`no ZIPP engine matches ${pattern}; FormLogic takes a copy from there`);
  const [nativeGlue, zippGlue] = [bytesOf('native-runtime/wasm/zipp_wasm.mjs'), bytesOf('zipp/zipp_wasm.js')];
  if (!nativeGlue || !zippGlue || !Buffer.from(nativeGlue).equals(Buffer.from(zippGlue))) problems.push('native-runtime/wasm/zipp_wasm.mjs is not zipp/zipp_wasm.js');
  return { copies, problems };
}
