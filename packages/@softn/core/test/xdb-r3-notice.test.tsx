/**
 * The storage notice on the desktop, where writes are native commands that
 * land a moment later (audit round 3).
 *
 * The notice says "Saving N changes…" while writes are unacknowledged
 * (`pendingWrites`), but a native write starting or landing told no one: the
 * line did not appear while a write was on its way, and one captured while a
 * write was pending (any other status change did that) stayed after the write
 * had landed, saying a saved change was still being saved.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { XDBService, type XDBStorageStatus } from '../src/runtime/xdb';
import { XDBStorageNotice } from '../src/runtime/xdb-storage-notice';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let gate: Promise<void> | null = null;

beforeEach(() => {
  gate = null;
  const rows = new Map<string, Record<string, unknown>>();
  const invoke = vi.fn(async (cmd: string, args: Record<string, any> = {}) => {
    if (cmd === 'create_record' && gate) await gate;
    switch (cmd) {
      case 'get_collections':
        return [];
      case 'get_collection':
        return [];
      case 'get_network_status':
        if (gate) await gate;
        return { peer_id: '', connected_peers: [], is_running: false };
      case 'create_record': {
        const row = { id: args.payload.id, collection: args.payload.collection, data: args.payload.data, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), deleted: false };
        rows.set(row.id, row);
        return row;
      }
      default:
        throw new Error(`Unexpected command: ${cmd}`);
    }
  });
  (globalThis as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke }, event: { listen: vi.fn(async () => () => {}) } };
});

afterEach(() => {
  delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
});

const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });
};

describe('the storage notice on the desktop', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('says a native write is being saved while it is, and stops once it has landed', async () => {
    const xdb = new XDBService(undefined, 'r3-notice');
    await xdb.isReady;
    const told: XDBStorageStatus[] = [];
    const off = xdb.subscribeStorage((status) => told.push(status));
    await act(async () => {
      root.render(<XDBStorageNotice xdb={xdb} />);
    });
    expect(container.textContent).toBe('');

    let release!: () => void;
    gate = new Promise<void>((resolve) => { release = resolve; });
    await act(async () => {
      xdb.create('notes', { text: 'on its way' });
    });
    await settle();
    expect(container.textContent).toContain('Saving 1 change');
    expect(told.at(-1)?.pendingWrites).toBe(1);

    release();
    await settle();
    expect(xdb.getStorageStatus().pendingWrites).toBe(0);
    expect(told.at(-1)?.pendingWrites).toBe(0);
    expect(container.textContent).toBe('');
    off();
    xdb.destroy();
  });

  // Reading the network status went through the tracker of unsaved writes: while it was read,
  // the store said a change was being saved, and leaving the page asked to be confirmed.
  it('does not count reading the network status as a change being saved', async () => {
    const xdb = new XDBService(undefined, 'r3-notice-status');
    await xdb.isReady;
    let release!: () => void;
    gate = new Promise<void>((resolve) => { release = resolve; });
    const reading = xdb.getNetworkStatus();
    expect(xdb.getStorageStatus().pendingWrites).toBe(0);
    expect(xdb.hasPendingWrites()).toBe(false);
    release();
    await reading;
    xdb.destroy();
  });
});
