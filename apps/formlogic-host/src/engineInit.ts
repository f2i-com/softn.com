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
 * is how another kind of engine is served — see
 * {@link HOST_JS_DOCUMENT_ENGINES}.
 */
export const ZIPP_DOCUMENT_ENGINES: readonly EngineId[] = ['zipp-web-python'];

/**
 * The engines the host-JavaScript entry document (`host.html`) serves.
 *
 * That document is byte for byte `index.html` with one attribute added, and
 * the attribute is the whole reason it exists: `host-js` runs the author's
 * `.logic` as this document's own JavaScript, which needs `'unsafe-eval'` in
 * `script-src`, and a policy cannot be relaxed once written. So the relaxed
 * policy gets its own document, this document serves nothing else, and
 * `index.html` keeps the policy it has always had.
 */
export const HOST_JS_DOCUMENT_ENGINES: readonly EngineId[] = ['host-js'];

/**
 * The `<html data-softn-logic-engine>` value that selects the host-JavaScript
 * document. It is the engine id, so the attribute and the announcement cannot
 * drift apart.
 */
export const HOST_JS_DOCUMENT = 'host-js';

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
export const RUNTIME_ENGINES: readonly EngineId[] = ['host-js', 'zipp-web-python'];

/**
 * How many of the archive's engine documents a FormLogic must understand.
 *
 * `softn-release.json` carries this as `protocols.hostedEngines`, beside the
 * native and editor-bridge protocol numbers, and the packager reads it from
 * here rather than keeping a number of its own. An archive that declares it
 * has more than one hosted-runtime entry document, so a FormLogic that mounts
 * only `index.html` has to learn the second one before it can offer the
 * engines the manifest lists.
 */
export const HOSTED_ENGINES_PROTOCOL = 1;

/** Every document list, for the test that keeps {@link RUNTIME_ENGINES} honest. */
export const DOCUMENT_ENGINE_LISTS: ReadonlyArray<readonly EngineId[]> = [
  ZIPP_DOCUMENT_ENGINES,
  HOST_JS_DOCUMENT_ENGINES,
];

/**
 * Which engines the document carrying `attribute` serves.
 *
 * One value decides all three of the things that have to agree: the policy the
 * shell writes, the `engine` it accepts in `init`, and the `engines` it
 * announces in `ready`. An attribute this build does not know serves nothing —
 * every init is refused and the policy is the strict one — because a document
 * that cannot say what it is must not be the one that relaxes anything.
 */
export function documentEngines(attribute: string | null | undefined): readonly EngineId[] {
  if (attribute === null || attribute === undefined || attribute === '') return ZIPP_DOCUMENT_ENGINES;
  if (attribute === HOST_JS_DOCUMENT) return HOST_JS_DOCUMENT_ENGINES;
  return [];
}

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
 * The `engines` map a document announces in `formlogic:ready`, built from the
 * same list it accepts in `init`, so a parent can never be invited to ask for
 * something it would then be refused.
 *
 * A ZIPP engine is described by the installed release's identity, which is
 * also the bytes the parent must send. `host-js` is described by `true`: it
 * runs on this document's own JavaScript, so there are no engine bytes to
 * name and nothing for the parent to fetch.
 */
export function readyEngines<T>(served: readonly EngineId[], zippIdentity: T): Record<string, T | true> {
  const engines: Record<string, T | true> = {};
  for (const id of served) engines[id] = id === HOST_JS_DOCUMENT ? true : zippIdentity;
  return engines;
}
