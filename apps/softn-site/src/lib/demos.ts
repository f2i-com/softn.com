import { unzipSync } from 'fflate';

/** One entry of `/demos/index.json`, which the web runtime generates and serves. */
export interface Demo {
  id: string;
  file: string;
  name: string;
  description: string;
  primary?: string;
  size: number;
}

/**
 * The order the shelf presents them in. Small and instantly legible first, so
 * the first thing anyone opens costs a few kilobytes and explains itself;
 * the heavyweights that pull down a language model sit at the far end.
 * Anything the runtime ships that is not listed here still appears, after these.
 */
const SHELF_ORDER = [
  'snake-game',
  // Second because it is the one that makes the point fastest: a console,
  // running a real cartridge, written in the same .logic as everything else.
  'pocket',
  'showcase',
  'glamour-studio',
  'maze-escape-3d',
  'three-demo',
  'device-kit',
  'texas-holdem',
  'gpu-demo',
  'notes',
  'the-office',
  'ai-chat',
];

export const DEFAULT_DEMO_ID = 'snake-game';

function rank(id: string): number {
  const i = SHELF_ORDER.indexOf(id);
  return i === -1 ? SHELF_ORDER.length : i;
}

export async function loadDemoIndex(signal?: AbortSignal): Promise<Demo[]> {
  const resp = await fetch('/demos/index.json', { signal });
  if (!resp.ok) throw new Error(`/demos/index.json responded ${resp.status}`);
  const raw: unknown = await resp.json();
  if (!Array.isArray(raw)) throw new Error('/demos/index.json is not an array');
  const demos = (raw as Demo[])
    .filter((d) => d && typeof d.file === 'string' && typeof d.name === 'string')
    .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
  // An index that parses but lists nothing would leave the player waiting for a
  // selection that can never arrive, so it is treated as a broken index rather
  // than as an empty one.
  if (demos.length === 0) throw new Error('/demos/index.json lists no bundles');
  return demos;
}

export interface DemoSource {
  path: string;
  source: string;
}

const sourceCache = new Map<string, DemoSource>();

/**
 * Pull the entry `.ui` file straight out of the bundle the runtime is running.
 *
 * The point of reading it here rather than checking a copy into this app is
 * that the two panels of the player cannot drift: the source on the left is
 * literally the file executing on the right.
 */
export async function loadDemoSource(file: string, signal?: AbortSignal): Promise<DemoSource> {
  const cached = sourceCache.get(file);
  if (cached) return cached;

  const resp = await fetch(`/demos/${file}`, { signal });
  if (!resp.ok) throw new Error(`/demos/${file} responded ${resp.status}`);
  const bytes = new Uint8Array(await resp.arrayBuffer());

  const entries = unzipSync(bytes);
  const decoder = new TextDecoder();

  const manifestBytes = entries['manifest.json'];
  if (!manifestBytes) throw new Error(`${file} has no manifest.json`);
  const manifest = JSON.parse(decoder.decode(manifestBytes)) as { main?: string };

  const path = manifest.main || 'ui/main.ui';
  const mainBytes = entries[path];
  if (!mainBytes) throw new Error(`${file} names ${path} as its entry but does not contain it`);

  const result: DemoSource = { path, source: decoder.decode(mainBytes) };
  sourceCache.set(file, result);
  return result;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
