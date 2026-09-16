/**
 * Is this file a copy of the ZIPP engine? Decided by what the module exports,
 * not by its name: Vite renames the engine (`zipp_wasm_bg-<hash>.wasm`), and a
 * copy under a name nobody thought to look for would otherwise ship unchecked.
 *
 * Reads the export section directly; nothing is compiled, so scanning every
 * entry of a release archive costs a few milliseconds. The import section is
 * read the same way, for the one question a second build of the engine has to
 * answer before it may run under the first build's glue: does it ask the host
 * for exactly the same things?
 */
import { createHash } from 'node:crypto';

/** Exports the engine has and no other module in a SoftN build does (gpu-lab kernels, the WASI guest). */
export const ZIPP_ENGINE_EXPORTS = ['zippProfile', 'zipp_start', 'engine_evalInContext'];

/** The kinds an import or export description names, in the binary's numbering, spelt as `WebAssembly.Module.imports` spells them. */
const KINDS = ['function', 'table', 'memory', 'global', 'tag'];

/**
 * Find section `id` in a WebAssembly binary and hand `read` a cursor over it;
 * null for anything that is not a module, or a module read past its end.
 * A module without the section answers `read` of an empty section: [].
 */
function wasmSection(bytes, id, read) {
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
      const section = b[offset++];
      const end = leb() + offset;
      if (end > b.length) return null;
      if (section === id) {
        const cursor = {
          leb,
          byte: () => {
            if (offset >= end) throw new RangeError('read past the section');
            return b[offset++];
          },
          name: () => {
            const length = leb();
            if (offset + length > end) throw new RangeError('read past the section');
            const text = decoder.decode(b.subarray(offset, offset + length));
            offset += length;
            return text;
          },
        };
        return read(cursor);
      }
      offset = end;
    }
    return [];
  } catch {
    return null;
  }
}

/** The export names of a WebAssembly binary, or null for anything that is not one. */
export function wasmExportNames(bytes) {
  return wasmSection(bytes, 7, ({ leb, name, byte }) => {
    const names = [];
    for (let count = leb(); count > 0; count--) {
      names.push(name());
      byte(); // the kind
      leb(); // the index
    }
    return names;
  });
}

/** A limits record (a table's or memory's), read and discarded. */
function skipLimits({ leb, byte }) {
  const flags = byte();
  leb(); // min
  if (flags & 0x01) leb(); // max
}

/**
 * The imports of a WebAssembly binary as `module.name:kind` strings, in the
 * order the module declares them, or null for anything that is not one. The
 * type of a function import is an index into the module's own type section
 * and means nothing across two modules, so it is not part of the answer; the
 * glue binds imports by module and name, and that is what has to agree.
 */
export function wasmImportNames(bytes) {
  return wasmSection(bytes, 2, (cursor) => {
    const { leb, name, byte } = cursor;
    const names = [];
    for (let count = leb(); count > 0; count--) {
      const module = name();
      const field = name();
      const kind = byte();
      if (kind === 0) leb(); // the type index
      else if (kind === 1) {
        byte(); // the reference type
        skipLimits(cursor);
      } else if (kind === 2) skipLimits(cursor);
      else if (kind === 3) {
        byte(); // the value type
        byte(); // mutability
      } else if (kind === 4) {
        byte(); // the attribute
        leb(); // the type index
      } else throw new RangeError(`unknown import kind ${kind}`);
      names.push(`${module}.${field}:${KINDS[kind]}`);
    }
    return names;
  });
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
 * The one place in the archive each variant of the engine may be, by the id
 * the install's SOURCE.json records it under (`variants.<id>`). A variant is
 * another build of the same release — the JavaScript-only `web` build beside
 * the web-python one FormLogic has always taken — and it ships as a tree of
 * its own at the top level, never inside `zipp/`, so `zipp/` stays exactly
 * the primary install and a reader that knows nothing of variants sees what
 * it always saw.
 */
export const VARIANT_ENGINE_COPIES = {
  web: 'zipp-web/zipp_wasm_bg.wasm',
};

/**
 * The engine in an archive's entries (name to bytes, or to {data, mode}):
 * every copy, found by its exports, is the installed release `source`
 * (its SOURCE.json), every known place holds one, and the native runtime's
 * glue is zipp/'s. A variant the install records may be at its one place and
 * nowhere else, and must be there; a copy anywhere else has to be the primary
 * engine, whatever it is called. Returns the copies and what is wrong, as
 * sentences.
 */
export function archiveEngineProblems(entries, source, { known = KNOWN_ENGINE_COPIES, variantPlaces = VARIANT_ENGINE_COPIES } = {}) {
  const bytesOf = (name) => {
    const value = entries.get(name);
    return value === undefined || value instanceof Uint8Array ? value : value.data;
  };
  const problems = [];
  // Path -> the variant that belongs there. Every other path expects the primary digest.
  const variantAt = new Map();
  for (const [id, record] of Object.entries(source.variants ?? {})) {
    const place = variantPlaces[id];
    if (!place) problems.push(`SOURCE.json records a ${id} variant of the engine, and the archive has no place for one`);
    else if (!/^[0-9a-f]{64}$/.test(record?.sha256 ?? '')) problems.push(`SOURCE.json records the ${id} variant without a sha256`);
    else variantAt.set(place, { id, sha256: record.sha256 });
  }
  const copies = [...entries.keys()].filter((name) => isZippEngineWasm(bytesOf(name)));
  for (const name of copies) {
    const digest = createHash('sha256').update(bytesOf(name)).digest('hex');
    const variant = variantAt.get(name);
    if (variant) {
      if (digest !== variant.sha256) problems.push(`${name} is a ZIPP engine, but not the ${variant.id} variant of ZIPP ${source.release} (${variant.sha256.slice(0, 12)})`);
    } else if (digest !== source.sha256) problems.push(`${name} is a ZIPP engine, but not ZIPP ${source.release} (${source.sha256.slice(0, 12)})`);
  }
  for (const pattern of known) if (!copies.some((name) => pattern.test(name))) problems.push(`no ZIPP engine matches ${pattern}; FormLogic takes a copy from there`);
  for (const [name, { id }] of variantAt) if (!copies.includes(name)) problems.push(`no ZIPP engine at ${name}; SOURCE.json records the ${id} variant there`);
  const [nativeGlue, zippGlue] = [bytesOf('native-runtime/wasm/zipp_wasm.mjs'), bytesOf('zipp/zipp_wasm.js')];
  if (!nativeGlue || !zippGlue || !Buffer.from(nativeGlue).equals(Buffer.from(zippGlue))) problems.push('native-runtime/wasm/zipp_wasm.mjs is not zipp/zipp_wasm.js');
  return { copies, problems };
}
