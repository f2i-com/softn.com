/**
 * Which app's saved data this page may use is the native side's decision
 * (src-tauri/src/data_identity.rs), not the page's.
 *
 * The page that draws a bundle holds the IPC, so a call cannot be told apart
 * by who made it, and this page's registry (installations.ts) can be read and
 * rewritten by anything running in it. The native side therefore binds the
 * data the data commands reach from what it witnessed itself: the file the
 * person chose, the digest of the bytes it read from that file, and its own
 * record of which digests the person let use which app's data. The registry
 * here still runs the upgrade steps (staging, backup, rollback, recovery);
 * before any of them touches data, that data is bound there.
 */
import { REGISTRY_KEY } from './installations';
import type { InstallationChoice, LoaderDecision } from './upgradeFlow';

export type NativeInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export function nativeInvoke(): NativeInvoke | undefined {
  // @ts-expect-error - Tauri invoke
  return typeof window === 'undefined' ? undefined : window.__TAURI__?.core?.invoke as NativeInvoke | undefined;
}

function required(invoke: NativeInvoke | undefined): NativeInvoke {
  if (!invoke) throw new Error('the native database is not available in this environment');
  return invoke;
}

/**
 * Hand this page's registry to the native side. It takes it once, at the
 * first start that has its own record and before any bundle has been read in
 * that run, when nothing but this runtime's code has run in the page; every
 * later call is refused there, which is the ordinary answer and not an error.
 * Must run before the app is drawn (main.tsx).
 */
export async function handOverRegistry(
  invoke: NativeInvoke | undefined = nativeInvoke(),
  storage?: Pick<Storage, 'getItem'>
): Promise<void> {
  if (!invoke) return;
  let registry: string | null;
  try {
    registry = (storage ?? globalThis.localStorage)?.getItem(REGISTRY_KEY) ?? null;
  } catch {
    // Unreadable now: leave the import for a start where it can be read,
    // rather than telling the native side there is nothing to import.
    return;
  }
  try {
    await invoke('import_installations', { registry });
  } catch {
    // Already imported, or no longer taken: the native record is the authority.
  }
}

/**
 * Bind `dataId` for the bundle open now (`bundleId`, the digest this page
 * computed from the bytes the native side handed it). Its own data, and data
 * the person let it use before, bind without a question; another installed
 * app's data is asked about in a native dialog. Throws when refused.
 *
 * `start` marks the last bind, just before the app is handed the page: from
 * then on the native side binds no other data and puts no question for this
 * open, since what runs in the page may be the app's.
 */
export async function bindDataIdentity(
  bundleId: string,
  dataId: string,
  manifest: { name?: unknown; version?: unknown },
  start = false,
  invoke: NativeInvoke | undefined = nativeInvoke()
): Promise<void> {
  await required(invoke)('bind_data_identity', {
    bundleId,
    dataId,
    name: typeof manifest.name === 'string' ? manifest.name : undefined,
    version: typeof manifest.version === 'string' ? manifest.version : undefined,
    start,
  });
}

/**
 * "Is this a new version of an installed app?" (audit SN-03), put by the
 * native side in its own dialog: the answer decides whether this package may
 * read and change another app's records, so it must be one the page cannot
 * give. An upgrade answer arrives with that data already bound.
 */
export async function chooseDataIdentity(
  question: InstallationChoice,
  invoke: NativeInvoke | undefined = nativeInvoke()
): Promise<LoaderDecision> {
  const answer = (await required(invoke)('choose_data_identity', {
    bundleId: question.bundleId,
    candidates: question.candidates.map(candidate => candidate.dataId),
  })) as { kind?: unknown; dataId?: unknown } | null;
  if (answer?.kind === 'upgrade' && typeof answer.dataId === 'string') return { kind: 'upgrade', dataId: answer.dataId };
  if (answer?.kind === 'new') return { kind: 'new' };
  return { kind: 'cancel' };
}
