/**
 * Lossless SQLite Value Transport Codec (`SqlValue` <-> XDB JSON).
 *
 * Prevents IEEE-754 precision loss on signed 64-bit SQLite integers, preserves
 * financial decimal precision/scale via canonical exact-string mapping, keeps
 * binary BLOBs intact via hex encoding, and distinguishes `NULL` from `""` and `0`.
 *
 * Key design detail: XDB WASM's `execute_json()` already serializes exact 64-bit
 * integer literals into its returned JSON string (e.g. `9007199254740993`). Using
 * standard `JSON.parse()` silently rounded those to `9007199254740992`. The exact
 * JSON parser below reads integer lexemes directly before they touch IEEE-754.
 */

import type { SqlValue, SqlValueMode } from './types';

export const SQLITE_I64_MIN = -9223372036854775808n;
export const SQLITE_I64_MAX = 9223372036854775807n;
export const SQLITE_U64_MAX = 18446744073709551615n;
const MIN_SAFE_BIGINT = -9007199254740991n;
const MAX_SAFE_BIGINT = 9007199254740991n;

const INTEGER_RE = /^[+-]?\d+$/;
const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const HEX_RE = /^(?:[0-9a-fA-F]{2})*$/;
const HEX_TABLE: readonly string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export interface SqlParamEncodeOptions {
  /**
   * How to handle unsigned 64-bit integers above `2^63 - 1` (`9223372036854775807`):
   * - `'reject'` (default): throw a RangeError so overflows never silently wrap or round.
   * - `'text'`: store exact decimal digits as SQLite TEXT.
   */
  unsignedOverflow?: 'reject' | 'text';
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    out += HEX_TABLE[bytes[i]];
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = String(hex ?? '').trim();
  if (!HEX_RE.test(clean)) {
    throw new RangeError('Invalid hex string for SQLite BLOB value');
  }
  const len = clean.length / 2;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Construct a lossless typed 64-bit integer `SqlValue`. */
export function sqlInt(value: bigint | number | string): { type: 'integer'; value: string } {
  if (typeof value === 'bigint') {
    return { type: 'integer', value: value.toString() };
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || !Number.isFinite(value)) {
      throw new RangeError(`Expected integer value for sqlInt, got ${String(value)}`);
    }
    return { type: 'integer', value: String(value) };
  }
  const s = String(value).trim();
  if (!INTEGER_RE.test(s)) {
    throw new RangeError(`Invalid integer literal for sqlInt: ${JSON.stringify(value)}`);
  }
  return { type: 'integer', value: BigInt(s).toString() };
}

/** Construct a lossless typed decimal `SqlValue` (mapped to exact TEXT storage in SQLite). */
export function sqlDecimal(value: string | number): { type: 'decimal'; value: string } {
  const s = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : String(value).trim();
  if (!s || !DECIMAL_RE.test(s)) {
    throw new RangeError(`Invalid decimal literal for sqlDecimal: ${JSON.stringify(value)}`);
  }
  return { type: 'decimal', value: s };
}

/** Construct a lossless typed BLOB `SqlValue`. */
export function sqlBlob(value: Uint8Array | ArrayBuffer | string): { type: 'blob'; hex: string } {
  if (typeof value === 'string') {
    const clean = value.trim().toLowerCase();
    if (!HEX_RE.test(clean)) {
      throw new RangeError('Invalid hex string for sqlBlob');
    }
    return { type: 'blob', hex: clean };
  }
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return { type: 'blob', hex: bytesToHex(bytes) };
}

/** Convert a `SqlValue` integer (number or tagged integer) into an exact `bigint`. */
export function sqlValueToBigInt(value: SqlValue): bigint {
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (value && typeof value === 'object' && value.type === 'integer') return BigInt(value.value);
  throw new TypeError(`Expected integer SqlValue, got ${typeof value}`);
}

function encodeSingleParam(value: unknown, options?: SqlParamEncodeOptions): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RangeError(`SQLite parameter cannot be ${String(value)}`);
    }
    return value;
  }
  if (typeof value === 'bigint') {
    if (value >= SQLITE_I64_MIN && value <= SQLITE_I64_MAX) {
      return { __i64: value.toString() };
    }
    if (value > SQLITE_I64_MAX && value <= SQLITE_U64_MAX && options?.unsignedOverflow === 'text') {
      return value.toString();
    }
    throw new RangeError(`Integer ${value.toString()} is outside signed 64-bit SQLite INTEGER range`);
  }
  if (value instanceof Uint8Array) {
    return { hex: bytesToHex(value) };
  }
  if (value instanceof ArrayBuffer) {
    return { hex: bytesToHex(new Uint8Array(value)) };
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Pass through native XDB wire encodings directly
    if (typeof obj.__i64 === 'string' && Object.keys(obj).length === 1) {
      const bi = BigInt(obj.__i64);
      if (bi < SQLITE_I64_MIN || bi > SQLITE_I64_MAX) {
        if (bi > SQLITE_I64_MAX && bi <= SQLITE_U64_MAX && options?.unsignedOverflow === 'text') {
          return bi.toString();
        }
        throw new RangeError(`Integer ${bi.toString()} is outside signed 64-bit SQLite INTEGER range`);
      }
      return { __i64: bi.toString() };
    }
    if (Array.isArray(obj.__blob) && Object.keys(obj).length === 1) {
      return { __blob: obj.__blob };
    }
    if (typeof obj.hex === 'string' && Object.keys(obj).length === 1) {
      if (!HEX_RE.test(obj.hex)) throw new RangeError('Invalid hex blob parameter');
      return { hex: obj.hex.toLowerCase() };
    }
    // Public typed SqlValue variants
    if (obj.type === 'integer') {
      const raw = typeof obj.value === 'string' ? obj.value.trim() : typeof obj.value === 'bigint' ? obj.value.toString() : String(obj.value ?? '').trim();
      if (!INTEGER_RE.test(raw)) {
        throw new RangeError(`Invalid typed integer value: ${JSON.stringify(obj.value)}`);
      }
      const bi = BigInt(raw);
      if (bi >= SQLITE_I64_MIN && bi <= SQLITE_I64_MAX) {
        return { __i64: bi.toString() };
      }
      if (bi > SQLITE_I64_MAX && bi <= SQLITE_U64_MAX && options?.unsignedOverflow === 'text') {
        return bi.toString();
      }
      throw new RangeError(`Integer ${bi.toString()} exceeds signed 64-bit SQLite INTEGER range`);
    }
    if (obj.type === 'decimal') {
      const raw = typeof obj.value === 'string' ? obj.value.trim() : String(obj.value ?? '').trim();
      if (!DECIMAL_RE.test(raw)) {
        throw new RangeError(`Invalid typed decimal value: ${JSON.stringify(obj.value)}`);
      }
      // SQLite does not have a native arbitrary-precision decimal storage class;
      // preserve exact precision and scale canonically as TEXT.
      return raw;
    }
    if (obj.type === 'blob') {
      if (typeof obj.hex !== 'string' || !HEX_RE.test(obj.hex)) {
        throw new RangeError('Invalid typed blob hex payload');
      }
      return { hex: obj.hex.toLowerCase() };
    }
  }
  throw new TypeError(`Unsupported SQLite parameter value: ${typeof value}`);
}

/**
 * Translate a parameter list/object (which may contain `SqlValue` tagged objects,
 * `bigint`, or `Uint8Array`) into XDB-compatible JSON parameter encoding.
 */
export function encodeSqlParams(params: unknown, options?: SqlParamEncodeOptions): string | null {
  if (params === undefined || params === null) return null;
  if (Array.isArray(params)) {
    return JSON.stringify(params.map((item) => encodeSingleParam(item, options)));
  }
  if (typeof params === 'object') {
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = encodeSingleParam(v, options);
    }
    return JSON.stringify(out);
  }
  throw new TypeError('SQLite parameters must be an array or plain object');
}

/**
 * Normalize an already-serialized JSON parameter string so typed `SqlValue` objects
 * (`{ type: 'integer' | 'decimal' | 'blob', ... }`) are lowered to XDB's native wire
 * encodings (`__i64`, exact TEXT, `hex`) before calling `WasmConnection.execute_json()`.
 */
export function normalizeSqlParamsJson(paramsJson: string | undefined | null, options?: SqlParamEncodeOptions): string | null {
  if (!paramsJson || !paramsJson.trim()) return null;
  // Fast path: if none of the typed value markers appear, keep exact raw JSON untouched
  // (avoids parsing large legacy param arrays unnecessarily).
  if (!paramsJson.includes('"type"') && !paramsJson.includes('"__i64"')) {
    return paramsJson;
  }
  const parsed = JSON.parse(paramsJson) as unknown;
  return encodeSqlParams(parsed, options);
}

// ---------------------------------------------------------------------------
// Exact Lossless JSON Parser for XDB `execute_json()` output
// ---------------------------------------------------------------------------

export interface ParsedXdbExecuteResult {
  columns: string[];
  rows: SqlValue[][];
  changes: number;
  lastInsertRowid: string;
  lastInsertRowidNumber: number;
}

class ExactJsonScanner {
  private pos = 0;
  private readonly len: number;

  constructor(private readonly src: string) {
    this.len = src.length;
  }

  skipWs(): void {
    while (this.pos < this.len) {
      const c = this.src.charCodeAt(this.pos);
      if (c === 32 || c === 9 || c === 10 || c === 13) this.pos++;
      else break;
    }
  }

  peek(): number {
    this.skipWs();
    return this.pos < this.len ? this.src.charCodeAt(this.pos) : -1;
  }

  expect(ch: string): void {
    this.skipWs();
    if (this.pos >= this.len || this.src[this.pos] !== ch) {
      throw new SyntaxError(`Expected '${ch}' at position ${this.pos}`);
    }
    this.pos++;
  }

  parseString(): string {
    this.expect('"');
    const start = this.pos;
    while (this.pos < this.len) {
      const c = this.src.charCodeAt(this.pos);
      if (c === 34) {
        const s = this.src.slice(start, this.pos);
        this.pos++;
        return s;
      }
      if (c === 92) {
        // Backslash escape: collect prefix and continue slowly
        return this.parseEscapedString(this.src.slice(start, this.pos));
      }
      this.pos++;
    }
    throw new SyntaxError('Unterminated JSON string');
  }

  private parseEscapedString(prefix: string): string {
    let out = prefix;
    while (this.pos < this.len) {
      const c = this.src.charCodeAt(this.pos);
      if (c === 34) {
        this.pos++;
        return out;
      }
      if (c === 92) {
        this.pos++;
        if (this.pos >= this.len) throw new SyntaxError('Unterminated escape in JSON string');
        const esc = this.src[this.pos++];
        switch (esc) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            const hex = this.src.slice(this.pos, this.pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new SyntaxError('Invalid \\u escape in JSON string');
            this.pos += 4;
            out += String.fromCharCode(parseInt(hex, 16));
            break;
          }
          default:
            throw new SyntaxError(`Invalid escape \\${esc}`);
        }
      } else {
        const chunkStart = this.pos;
        while (this.pos < this.len) {
          const ch = this.src.charCodeAt(this.pos);
          if (ch === 34 || ch === 92) break;
          this.pos++;
        }
        out += this.src.slice(chunkStart, this.pos);
      }
    }
    throw new SyntaxError('Unterminated JSON string');
  }

  parseNumberToken(): { raw: string; isInteger: boolean } {
    this.skipWs();
    const start = this.pos;
    let isInteger = true;
    if (this.pos < this.len && this.src.charCodeAt(this.pos) === 45) this.pos++; // '-'
    while (this.pos < this.len) {
      const c = this.src.charCodeAt(this.pos);
      if (c >= 48 && c <= 57) {
        this.pos++;
      } else if (c === 46 || c === 101 || c === 69) {
        isInteger = false;
        this.pos++;
        if ((c === 101 || c === 69) && this.pos < this.len) {
          const sign = this.src.charCodeAt(this.pos);
          if (sign === 43 || sign === 45) this.pos++;
        }
      } else {
        break;
      }
    }
    const raw = this.src.slice(start, this.pos);
    if (!raw || raw === '-') throw new SyntaxError(`Invalid JSON number at position ${start}`);
    return { raw, isInteger };
  }

  parseValue(mode: SqlValueMode, inCell: boolean): unknown {
    const ch = this.peek();
    if (ch === 34) return this.parseString(); // '"'
    if (ch === 110) { // 'null'
      if (this.src.slice(this.pos, this.pos + 4) !== 'null') throw new SyntaxError('Invalid token');
      this.pos += 4;
      return null;
    }
    if (ch === 116) { // 'true'
      if (this.src.slice(this.pos, this.pos + 4) !== 'true') throw new SyntaxError('Invalid token');
      this.pos += 4;
      return true;
    }
    if (ch === 102) { // 'false'
      if (this.src.slice(this.pos, this.pos + 5) !== 'false') throw new SyntaxError('Invalid token');
      this.pos += 5;
      return false;
    }
    if (ch === 91) { // '['
      this.pos++;
      const arr: unknown[] = [];
      if (this.peek() === 93) {
        this.pos++;
        return arr;
      }
      while (this.pos < this.len) {
        arr.push(this.parseValue(mode, inCell));
        const next = this.peek();
        if (next === 44) { this.pos++; continue; } // ','
        if (next === 93) { this.pos++; return arr; } // ']'
        throw new SyntaxError(`Expected ',' or ']' at position ${this.pos}`);
      }
      throw new SyntaxError(`Unterminated array at position ${this.pos}`);
    }
    if (ch === 123) { // '{'
      this.pos++;
      const obj: Record<string, unknown> = {};
      if (this.peek() === 125) {
        this.pos++;
        return obj;
      }
      while (this.pos < this.len) {
        const key = this.parseString();
        this.expect(':');
        const val = this.parseValue(mode, false);
        if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
          obj[key] = val;
        }
        const next = this.peek();
        if (next === 44) { this.pos++; continue; }
        if (next === 125) {
          this.pos++;
          if (inCell && mode !== 'legacy' && typeof obj.hex === 'string' && Object.keys(obj).length === 1) {
            return { type: 'blob', hex: obj.hex };
          }
          return obj;
        }
        throw new SyntaxError(`Expected ',' or '}' at position ${this.pos}`);
      }
      throw new SyntaxError(`Unterminated object at position ${this.pos}`);
    }
    // Number
    const { raw, isInteger } = this.parseNumberToken();
    if (!isInteger || mode === 'legacy') {
      return Number(raw);
    }
    const bi = BigInt(raw);
    if (mode === 'typed') {
      return { type: 'integer', value: bi.toString() };
    }
    // 'lossless': keep safe JS integers as number, preserve unsafe 64-bit integers as exact tagged objects
    if (bi >= MIN_SAFE_BIGINT && bi <= MAX_SAFE_BIGINT) {
      return Number(raw);
    }
    return { type: 'integer', value: bi.toString() };
  }

  parseRoot(mode: SqlValueMode): ParsedXdbExecuteResult {
    this.expect('{');
    let columns: string[] = [];
    let rows: SqlValue[][] = [];
    let changes = 0;
    let lastInsertRowid = '0';
    let lastInsertRowidNumber = 0;

    if (this.peek() === 125) {
      this.pos++;
      return { columns, rows, changes, lastInsertRowid, lastInsertRowidNumber };
    }

    while (this.pos < this.len) {
      const key = this.parseString();
      this.expect(':');
      if (key === 'columns') {
        const parsed = this.parseValue('legacy', false);
        columns = Array.isArray(parsed) ? parsed.map((c) => String(c)) : [];
      } else if (key === 'rows') {
        this.expect('[');
        const outRows: SqlValue[][] = [];
        if (this.peek() !== 93) {
          while (this.pos < this.len) {
            this.expect('[');
            const row: SqlValue[] = [];
            if (this.peek() !== 93) {
              while (this.pos < this.len) {
                row.push(this.parseValue(mode, true) as SqlValue);
                const c = this.peek();
                if (c === 44) { this.pos++; continue; }
                if (c === 93) { this.pos++; break; }
                throw new SyntaxError(`Expected ',' or ']' in row at position ${this.pos}`);
              }
            } else {
              this.pos++;
            }
            outRows.push(row);
            const c = this.peek();
            if (c === 44) { this.pos++; continue; }
            if (c === 93) { this.pos++; break; }
            throw new SyntaxError(`Expected ',' or ']' in rows at position ${this.pos}`);
          }
        } else {
          this.pos++;
        }
        rows = outRows;
      } else if (key === 'changes') {
        const { raw } = this.parseNumberToken();
        changes = Number(raw);
      } else if (key === 'lastInsertRowid') {
        const { raw } = this.parseNumberToken();
        lastInsertRowid = raw;
        lastInsertRowidNumber = Number(raw);
      } else {
        this.parseValue('legacy', false);
      }
      const next = this.peek();
      if (next === 44) { this.pos++; continue; }
      if (next === 125) { this.pos++; break; }
      throw new SyntaxError(`Expected ',' or '}' at position ${this.pos}`);
    }

    return { columns, rows, changes, lastInsertRowid, lastInsertRowidNumber };
  }
}

/**
 * Parse raw JSON emitted by `WasmConnection.execute_json()` with configurable
 * value transport fidelity (`'legacy' | 'lossless' | 'typed'`).
 */
export function parseXdbResultJson(rawJson: string, mode: SqlValueMode = 'lossless'): ParsedXdbExecuteResult {
  const scanner = new ExactJsonScanner(rawJson);
  return scanner.parseRoot(mode);
}
