/**
 * XDB Tauri Compatibility Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { XDBService } from '../src/runtime/xdb';

type XDBRecord = {
  id: string;
  collection: string;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  deleted: boolean;
};

function makeRecord(
  id: string,
  collection: string,
  data: Record<string, unknown>,
  overrides: Partial<XDBRecord> = {}
): XDBRecord {
  const now = new Date().toISOString();
  return {
    id,
    collection,
    data,
    created_at: now,
    updated_at: now,
    deleted: false,
    ...overrides,
  };
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('XDB Service (Tauri mode)', () => {
  let backend: Map<string, XDBRecord[]>;
  let listeners: Map<string, (event: { payload: unknown }) => void>;
  let invokeMock: any;

  beforeEach(() => {
    backend = new Map();
    listeners = new Map();
    invokeMock = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case 'get_collections':
          return Array.from(backend.keys());
        case 'get_collection': {
          const collection = String(args?.collection ?? '');
          return backend.get(collection) ?? [];
        }
        case 'create_record': {
          const payload = args?.payload as { collection: string; data: Record<string, unknown> };
          const record = makeRecord(
            `tauri-${Math.random().toString(36).slice(2)}`,
            payload.collection,
            payload.data
          );
          const records = backend.get(payload.collection) ?? [];
          records.push(record);
          backend.set(payload.collection, records);
          return record;
        }
        case 'update_record': {
          const payload = args?.payload as { id: string; data: Record<string, unknown> };
          for (const [collection, records] of backend.entries()) {
            const index = records.findIndex((r) => r.id === payload.id);
            if (index !== -1) {
              const updated = {
                ...records[index],
                data: { ...records[index].data, ...payload.data },
                updated_at: new Date().toISOString(),
              };
              records[index] = updated;
              backend.set(collection, records);
              return updated;
            }
          }
          throw new Error('Record not found');
        }
        case 'delete_record': {
          const id = String(args?.id ?? '');
          for (const [collection, records] of backend.entries()) {
            const index = records.findIndex((r) => r.id === id);
            if (index !== -1) {
              records[index] = {
                ...records[index],
                deleted: true,
                updated_at: new Date().toISOString(),
              };
              backend.set(collection, records);
              return true;
            }
          }
          return false;
        }
        case 'upsert_record': {
          const record = args?.record as XDBRecord;
          const records = backend.get(record.collection) ?? [];
          const index = records.findIndex((r) => r.id === record.id);
          if (index !== -1) {
            records[index] = record;
          } else {
            records.push(record);
          }
          backend.set(record.collection, records);
          return record;
        }
        case 'get_record': {
          const id = String(args?.id ?? '');
          for (const records of backend.values()) {
            const record = records.find((r) => r.id === id);
            if (record) return record;
          }
          throw new Error('Record not found');
        }
        default:
          throw new Error(`Unexpected command: ${cmd}`);
      }
    });

    (globalThis as unknown as { window: Window }).window = globalThis as unknown as Window;
    (globalThis as any).__TAURI__ = {
      core: { invoke: invokeMock },
      event: {
        listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
          listeners.set(event, handler);
          return () => listeners.delete(event);
        }),
      },
    };
  });

  afterEach(() => {
    listeners.clear();
    backend.clear();
    delete (globalThis as any).__TAURI__;
  });

  it('hydrates from SQLite backend into in-memory cache', async () => {
    backend.set('tasks', [makeRecord('1', 'tasks', { title: 'A' })]);

    const xdb = new XDBService(undefined, 'test-xdb');
    await flushPromises();
    await flushPromises();

    const records = xdb.getAll('tasks');
    expect(records).toHaveLength(1);
    expect(records[0].data.title).toBe('A');
  });

  it('rehydrates collection on sync event', async () => {
    backend.set('tasks', [makeRecord('1', 'tasks', { title: 'A' })]);
    const xdb = new XDBService(undefined, 'test-xdb');
    await flushPromises();
    await flushPromises();

    backend.set('tasks', [
      makeRecord('1', 'tasks', { title: 'A' }),
      makeRecord('2', 'tasks', { title: 'B' }),
    ]);

    const handler = listeners.get('xdb-sync-event');
    expect(handler).toBeDefined();
    handler?.({ payload: { type: 'sync_update', collection: 'tasks' } });

    await flushPromises();
    await flushPromises();

    const records = xdb.getAll('tasks');
    expect(records).toHaveLength(2);
  });

  it('persists writeRecord via upsert_record', async () => {
    const xdb = new XDBService(undefined, 'test-xdb');
    await flushPromises();

    const record = makeRecord('1', 'tasks', { title: 'From Yjs' });
    xdb.writeRecord('tasks', record);

    expect(invokeMock).toHaveBeenCalledWith('upsert_record', { record });
  });

  it('createAsync uses Tauri backend and updates cache', async () => {
    const xdb = new XDBService(undefined, 'test-xdb');
    await flushPromises();

    const record = await xdb.createAsync('tasks', { title: 'Created' });
    expect(record.id).toBeDefined();
    expect(invokeMock).toHaveBeenCalledWith('create_record', {
      payload: { collection: 'tasks', data: { title: 'Created' } },
    });

    const records = xdb.getAll('tasks');
    expect(records).toHaveLength(1);
    expect(records[0].data.title).toBe('Created');
  });
});
