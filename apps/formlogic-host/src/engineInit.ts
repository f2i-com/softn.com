/**
 * Which engine a `formlogic:init` is asking for, and whether this document can
 * serve it.
 *
 * FormLogic will let an app's owner choose the engine their app's `.logic`
 * runs on. The choice is made by the parent from server state and arrives in
 * `formlogic:init`; a bundle can never select its own engine. This module is
 * the pure part of accepting that message — no DOM, no messages, no engine —
 * so it can be read, tested and reasoned about on its own.
 *
 * Everything here is additive. `init.engine` is optional and absent means
 * {@link DEFAULT_ENGINE}, so a FormLogic that predates the choice gets exactly
 * what it got before, and a FormLogic that asks for an engine this build does
 * not serve is told so instead of being quietly given a different one.
 */

/** The engines FormLogic can ask a hosted-runtime document to run. */
export type EngineId = 'zipp-web-python' | 'zipp-web' | 'host-js';

/**
 * What an `init` without an `engine` means: the ZIPP JavaScript-and-Python
 * WASM engine, which is what every hosted app has always run on.
 */
export const DEFAULT_ENGINE: EngineId = 'zipp-web-python';

/**
 * The engines the ZIPP entry document (`index.html`) serves.
 *
 * It is the document, not the build, that decides: the engine has to be known
 * before the shell writes its Content-Security-Policy, and a meta policy can
 * only ever be tightened afterwards. A second document with a different policy
 * is how another kind of engine will be served.
 */
export const ZIPP_DOCUMENT_ENGINES: readonly EngineId[] = ['zipp-web-python'];

/**
 * Every engine an archive built from this checkout can serve: the union of
 * what its entry documents serve, sorted.
 *
 * `hosted-runtime/runtime-manifest.json` names exactly this list — the packager
 * reads this declaration out of this file, the way it reads the editor bridge
 * protocol out of the editor's own source — so an installed runtime says which
 * engines it can be asked for, and a FormLogic offering an owner a choice has
 * something to check that choice against before it mounts a frame.
 *
 * Written out rather than computed so the packager can read it without running
 * anything; `engine-init.test.mjs` fails if it ever stops being the union of
 * the document lists above.
 */
export const RUNTIME_ENGINES: readonly EngineId[] = ['zipp-web-python'];

/** Every document list, for the test that keeps {@link RUNTIME_ENGINES} honest. */
export const DOCUMENT_ENGINE_LISTS: ReadonlyArray<readonly EngineId[]> = [ZIPP_DOCUMENT_ENGINES];

/**
 * Languages an engine id promises. ZIPP ships as more than one build from one
 * glue, so the id the parent names and the bytes it sends can disagree; the
 * shell checks the engine's own profile against this rather than trusting
 * either side's records.
 */
export const ENGINE_REQUIRED_LANGUAGES: Record<EngineId, readonly string[]> = {
  'zipp-web-python': ['javascript', 'python'],
  'zipp-web': ['javascript'],
  'host-js': [],
};

/** Engine bytes are between an empty WASM header and the archive's own limit. */
const MIN_ENGINE_BYTES = 8;
const MAX_ENGINE_BYTES = 32 * 1024 * 1024;

/** A value from another realm, in a message, said as one short phrase. */
function describe(value: unknown): string {
  return typeof value === 'string' ? `"${value.slice(0, 40)}"` : String(value).slice(0, 40);
}

/**
 * The engine an `init` is asking this document for, or a refusal.
 *
 * Absent means {@link DEFAULT_ENGINE}: an older FormLogic sends no `engine`
 * and gets the engine it has always got. Anything the document does not serve
 * is refused by name rather than substituted, because the parent chose it for
 * a reason and silently running something else would make its decision a lie.
 */
export function acceptEngine(requested: unknown, served: readonly EngineId[]): EngineId {
  const id = requested === undefined || requested === null ? DEFAULT_ENGINE : requested;
  if (typeof id !== 'string' || !served.includes(id as EngineId)) {
    throw new Error(`This app runtime does not run the ${describe(id)} engine`);
  }
  return id as EngineId;
}

/**
 * The ZIPP engine bytes the parent cloned in, or a refusal.
 *
 * The parent fetches the engine once per page, checks its SHA-256 and posts a
 * copy; this only bounds what arrives, so a wrong or missing field cannot
 * reach the loader.
 */
export function acceptZippBytes(value: unknown): ArrayBuffer {
  if (
    !(value instanceof ArrayBuffer) ||
    value.byteLength < MIN_ENGINE_BYTES ||
    value.byteLength > MAX_ENGINE_BYTES
  ) {
    throw new Error('The parent must supply the matching ZIPP engine bytes');
  }
  return value;
}

/**
 * Refuse an engine whose loaded profile cannot run what its id promises.
 *
 * The check is the engine's own answer, taken after it has loaded, so a parent
 * that names `zipp-web-python` and posts the JavaScript-only build is caught
 * here rather than at the first Python file, and the reason names the language
 * that is missing.
 */
export function requireEngineLanguages(engine: EngineId, languages: readonly string[]): void {
  const missing = ENGINE_REQUIRED_LANGUAGES[engine].filter((name) => !languages.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `The ${engine} engine must run ${missing.join(' and ')}, and the supplied engine does not`
    );
  }
}

/**
 * The `engines` map this document announces in `formlogic:ready`, built from
 * {@link ZIPP_DOCUMENT_ENGINES} so the announcement and the runtime manifest
 * cannot name different sets. Every engine here is ZIPP, so each is described
 * by the installed release's identity; a parent reads it to learn both which
 * engines it may ask for and which bytes each one wants.
 */
export function zippReadyEngines<T>(identity: T): Record<string, T> {
  const engines: Record<string, T> = {};
  for (const id of ZIPP_DOCUMENT_ENGINES) engines[id] = identity;
  return engines;
}
