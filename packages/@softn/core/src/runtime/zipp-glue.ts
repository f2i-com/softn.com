/**
 * ZIPP's JavaScript bindings (the "glue" wasm-bindgen writes beside the
 * engine), and where this realm takes them from.
 *
 * A glue and its engine are one pair: the glue's imports are the engine's,
 * by names that change with every ZIPP build. Core carries the glue of the
 * ZIPP it was released with, and uses it unless a host supplies another. A
 * host that serves a ZIPP of its own (FormLogic, from its /zipp/ folder)
 * names that ZIPP's glue here, with its digest, before anything starts ZIPP,
 * and sends the engine that goes with it; core then runs that pair, so the
 * host can take a newer ZIPP without a new SoftN.
 *
 * Every name core takes from a glue is in {@link ZIPP_GLUE_EXPORTS}. A host
 * glue without one of them is refused by name when it loads, before an engine
 * is started on it.
 */
import * as bundledGlue from '../../wasm-zipp/zipp_wasm.js';
import { sha256Hex } from '../bundle/crypto';

export type ZippGlue = typeof bundledGlue;

/** What core calls in a glue: a host's glue must export each of these, as a function. */
export const ZIPP_GLUE_EXPORTS = [
  'default',
  'Engine',
  'accelGuestCall',
  'addPythonPackage',
  'zipp_install_panic_hook',
  'zippProfile',
] as const;

/** What core calls where a glue has it: `pythonPackages` (a build that cannot say has no Python packages). */
export const ZIPP_GLUE_OPTIONAL_EXPORTS = ['pythonPackages'] as const;

/** A glue a host serves: its address, and the SHA-256 of its bytes where the host knows it. */
export interface ZippGlueSource {
  url: string;
  sha256?: string;
}

let configured: ZippGlueSource | undefined;
let awaited: Promise<ZippGlueSource | null> | undefined;
let loaded: ZippGlue | undefined;
let loading: Promise<ZippGlue> | undefined;
let frozen = false;

function checked(source: ZippGlueSource): ZippGlueSource {
  if (!source || typeof source.url !== 'string' || !source.url) throw new TypeError('The ZIPP glue needs an address');
  if (source.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(source.sha256)) throw new TypeError('The ZIPP glue digest must be 64 lowercase hex digits');
  return { url: source.url, ...(source.sha256 ? { sha256: source.sha256 } : {}) };
}

/**
 * Run the glue at `source.url` instead of the one core carries. Called before
 * anything starts ZIPP in this realm, with the engine of the same ZIPP
 * (`configureZippWasmSource` or `awaitZippWasmSource`). With `sha256`, the
 * glue's bytes are checked before it is imported; a worker the page starts is
 * given the same address and trusts the page's check.
 */
export function configureZippGlue(source: ZippGlueSource): void {
  if (frozen) throw new Error('The ZIPP glue must be configured before initialization starts');
  configured = checked(source);
}

/**
 * The glue will come from a host that has not sent it yet (a hosted editor
 * learns it when its host connects), as `awaitZippWasmSource` waits for the
 * engine. `null` means the host named none, and core's own glue runs.
 */
export function awaitZippGlue(source: Promise<ZippGlueSource | null>): void {
  if (frozen) throw new Error('The ZIPP glue must be configured before initialization starts');
  awaited = source;
}

/** The host's glue, once a host that was going to name one has. */
async function hostSource(): Promise<ZippGlueSource | undefined> {
  if (!configured && awaited) {
    const given = await awaited;
    if (given && !configured) configured = checked(given);
  }
  return configured;
}

/**
 * Where a host's glue comes from, for a worker this realm starts, or null for the glue core
 * carries. Loaded here first, so its digest has been checked before a worker is told its address
 * (a worker is given no digest, and trusts this realm's check); a glue that fails its check is
 * never handed on.
 */
export async function zippGlueForWorker(): Promise<string | null> {
  frozen = true;
  const source = await hostSource();
  if (!source) return null;
  await loadZippGlue();
  return source.url;
}

/** Whether this realm runs a host's glue (a ZIPP of the host's own) rather than the one core carries. */
export function runsHostGlue(): boolean {
  return loaded !== undefined && loaded !== bundledGlue;
}

/** The glue a worker's page named (a worker's realm has started nothing), or nothing for core's own. */
export function adoptZippGlue(url: string | null | undefined): void {
  if (!frozen && typeof url === 'string' && url) configureZippGlue({ url });
}

/** The names of `ZIPP_GLUE_EXPORTS` a glue lacks. */
export function missingGlueExports(glue: Record<string, unknown>): string[] {
  return ZIPP_GLUE_EXPORTS.filter((name) => typeof glue[name] !== 'function');
}

async function importHostGlue(source: ZippGlueSource): Promise<ZippGlue> {
  if (source.sha256) {
    let response: Response;
    try {
      response = await fetch(source.url, { credentials: 'omit' });
    } catch (error) {
      throw new Error(`The ZIPP glue (${source.url}) could not be fetched: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new Error(`The ZIPP glue (${source.url}) answered ${response.status}`);
    const digest = await sha256Hex(new Uint8Array(await response.arrayBuffer()));
    if (digest !== source.sha256) throw new Error(`The ZIPP glue (${source.url}) is not the one its host named (${digest.slice(0, 12)}, expected ${source.sha256.slice(0, 12)})`);
  }
  const glue = (await import(/* @vite-ignore */ source.url)) as Record<string, unknown>;
  const missing = missingGlueExports(glue);
  if (missing.length) throw new Error(`The ZIPP glue (${source.url}) does not export ${missing.join(', ')}, which SoftN calls; this ZIPP is not one this SoftN runs`);
  return glue as unknown as ZippGlue;
}

/**
 * The glue this realm runs, loaded once: core's own, or the host's checked
 * and imported. Fixes the choice. A failed load (offline for a moment) can be
 * tried again; it cannot switch to another glue.
 */
export function loadZippGlue(): Promise<ZippGlue> {
  frozen = true;
  if (loaded) return Promise.resolve(loaded);
  loading ??= (async () => {
    const source = await hostSource();
    return (loaded = source ? await importHostGlue(source) : bundledGlue);
  })().catch((error: unknown) => { loading = undefined; throw error; });
  return loading;
}

/**
 * The glue in use, once {@link loadZippGlue} has settled: every engine and
 * call in core goes through it. Before a host's glue has loaded, asking is a
 * mistake in core (an engine started before ZIPP was), and throws.
 */
export function zippGlue(): ZippGlue {
  if (loaded) return loaded;
  if (!configured && !awaited) return bundledGlue;
  throw new Error('ZIPP was used before its glue loaded');
}
