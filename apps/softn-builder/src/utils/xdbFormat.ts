/**
 * The .xdb entry, read and written in one place.
 *
 * Two exporters each wrote their own idea of the format: the single-file one
 * recorded the schema, the multi-file one did not, and a normal project with
 * a UI file and a logic file took the multi-file path — so the schema the
 * Data view had built came back as nothing but the columns of the first row.
 * Both minted `seed-N` ids and fresh timestamps for every record on every
 * export, which meant a save that changed nothing re-identified every record
 * the app had, broke every reference between them, and made the runtime's
 * seeding (which skips ids it already holds) insert them all a second time.
 *
 * What the runtime reads (packages/@softn/core/src/bundle/bundle.ts,
 * parseXDBFile): `{ collection, records: [{ id, data, created_at, updated_at }] }`,
 * where a record without `data` is taken as flat (`{ id, ...fields }`), an
 * unknown key is ignored, and `deleted` is not read at all — every listed
 * record is seeded as live. The `schema` block is the Builder's own and the
 * runtime ignores it; it is what makes reopening lossless.
 *
 * Identity policy:
 *  - A record read from a bundle keeps its id and created_at for good, and its
 *    updated_at until its data changes. Only a record made in the Data view
 *    gets a new id — a UUID v4 as the runtime mints — and it gets it when it
 *    is made, not at export, so two exports of the same rows agree.
 *  - A record with `deleted: true` is a tombstone: kept verbatim, not shown in
 *    the Data view, and written back unchanged after the live rows. It is
 *    never edited and never resurrected by the Builder; what the runtime does
 *    with the flag is the runtime's.
 *  - A row deleted in the Data view is dropped from the export rather than
 *    written as a tombstone, because the runtime seeds every listed record as
 *    live: a tombstone written here would come back as a live row.
 *  - There is no "import as new" (re-identify) operation. Re-identification is
 *    a migration with reference rewriting, and nothing in the Builder needs it
 *    yet; it is not offered rather than offered by accident.
 */

import type { SchemaField } from '../types/builder';

/** A record as the .xdb carries it. Unknown keys are kept and written back. */
export interface XdbRecordEnvelope {
  id: string;
  collection?: string;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  deleted?: boolean;
  [extra: string]: unknown;
}

/**
 * What the Builder remembers about a live row beyond its data: the identity
 * it was read with, the data as it was read (to tell an edit from a no-op),
 * and any envelope keys the format does not name.
 */
export interface RecordIdentity {
  id: string;
  created_at: string;
  updated_at: string;
  /** The data as imported or created, for change detection; never edited. */
  data: Record<string, unknown>;
  /** Envelope keys other than id/collection/data/created_at/updated_at/deleted. */
  extra: Record<string, unknown>;
}

export interface XdbSchema {
  alias: string;
  fields: SchemaField[];
}

/** One collection as the exporter writes it. */
export interface XdbCollection {
  name: string;
  schema: XdbSchema;
  records: XdbRecordEnvelope[];
}

/** What reading an .xdb entry yields. */
export interface ParsedXdb {
  collection: string;
  /** The schema block when the entry carries one (Builder-written bundles do). */
  schema: XdbSchema | null;
  /** Live records, in file order, envelopes normalized to the nested form. */
  records: XdbRecordEnvelope[];
  /** Records marked `deleted: true`, verbatim, in file order. */
  tombstones: XdbRecordEnvelope[];
  /** Records the runtime would also skip: no string id, or unusable data. */
  skipped: number;
}

const ENVELOPE_KEYS = new Set(['id', 'collection', 'data', 'created_at', 'updated_at', 'deleted']);

/** A record id as the runtime mints one (packages/@softn/core/src/runtime/xdb.ts, generateId). */
export function newRecordId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = (Math.random() * 256) | 0;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The identity of a row made in the Data view just now. */
export function freshIdentity(data: Record<string, unknown>, now = new Date().toISOString()): RecordIdentity {
  return { id: newRecordId(), created_at: now, updated_at: now, data, extra: {} };
}

/** The identity of a record read from a bundle. */
export function identityOf(record: XdbRecordEnvelope): RecordIdentity {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!ENVELOPE_KEYS.has(key)) extra[key] = value;
  }
  return {
    id: record.id,
    created_at: record.created_at,
    updated_at: record.updated_at,
    data: record.data,
    extra,
  };
}

/**
 * Whether two JSON values are the same value. Key order is not a difference:
 * the Data view rebuilds a row object on every keystroke.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) sorted[k] = (v as Record<string, unknown>)[k];
      return sorted;
    }
    return v;
  });
}

/**
 * The envelope a live row is written with. Identity is kept; updated_at moves
 * only when the data did. A row without identity (a session written before
 * identity was kept, or a hand-made collection) is minted here as a last
 * resort, which is why the stores mint at creation instead.
 */
export function envelopeFor(
  collection: string,
  data: Record<string, unknown>,
  identity: RecordIdentity | undefined,
  now = new Date().toISOString()
): XdbRecordEnvelope {
  if (!identity) {
    return { id: newRecordId(), collection, data, created_at: now, updated_at: now, deleted: false };
  }
  const changed = !sameJson(data, identity.data);
  return {
    id: identity.id,
    collection,
    data,
    created_at: identity.created_at,
    updated_at: changed ? now : identity.updated_at,
    deleted: false,
    ...identity.extra,
  };
}

/** The text of an .xdb entry. Both exporters write exactly this. */
export function serializeXdb(collection: XdbCollection): string {
  const file = {
    collection: collection.name,
    schema: {
      alias: collection.schema.alias,
      fields: collection.schema.fields,
    },
    records: collection.records,
  };
  return JSON.stringify(file, null, 2);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read an .xdb entry the way the runtime does, keeping what the runtime drops.
 * Throws on text that is not a JSON object; the caller decides what a
 * malformed entry means.
 */
export function parseXdb(text: string, fallbackCollection: string): ParsedXdb {
  const parsed: unknown = JSON.parse(text);
  if (!isObject(parsed)) throw new Error('not a JSON object');

  const collection = typeof parsed.collection === 'string' && parsed.collection ? parsed.collection : fallbackCollection;

  let schema: XdbSchema | null = null;
  if (isObject(parsed.schema)) {
    const fields = Array.isArray(parsed.schema.fields) ? (parsed.schema.fields as SchemaField[]) : [];
    const alias = typeof parsed.schema.alias === 'string' && parsed.schema.alias ? parsed.schema.alias : collection;
    schema = { alias, fields };
  }

  const records: XdbRecordEnvelope[] = [];
  const tombstones: XdbRecordEnvelope[] = [];
  let skipped = 0;
  const raw = Array.isArray(parsed.records) ? parsed.records : [];
  for (const candidate of raw) {
    if (!isObject(candidate) || typeof candidate.id !== 'string') {
      skipped += 1;
      continue;
    }
    if (candidate.deleted === true) {
      tombstones.push(candidate as XdbRecordEnvelope);
      continue;
    }
    let data: Record<string, unknown>;
    let rest: Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(candidate, 'data')) {
      if (!isObject(candidate.data)) {
        skipped += 1;
        continue;
      }
      data = candidate.data;
      rest = candidate;
    } else {
      // Flat, as Studio writes seed rows: every key but the identity is data.
      data = Object.fromEntries(
        Object.entries(candidate).filter(([key]) => key !== 'id' && key !== 'collection' && key !== 'created_at' && key !== 'updated_at' && key !== 'createdAt' && key !== 'updatedAt' && key !== 'deleted')
      );
      rest = { id: candidate.id, created_at: candidate.created_at ?? candidate.createdAt, updated_at: candidate.updated_at ?? candidate.updatedAt };
    }
    const rawCreated = rest.created_at ?? rest.createdAt;
    const rawUpdated = rest.updated_at ?? rest.updatedAt;
    const created_at = typeof rawCreated === 'string' ? rawCreated : typeof rawUpdated === 'string' ? rawUpdated : '1970-01-01T00:00:00.000Z';
    const updated_at = typeof rawUpdated === 'string' ? rawUpdated : created_at;
    const envelope: XdbRecordEnvelope = { ...rest, id: candidate.id, data, created_at, updated_at };
    delete envelope.createdAt;
    delete envelope.updatedAt;
    records.push(envelope);
  }

  return { collection, schema, records, tombstones, skipped };
}
