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

/** The engines that are a build of ZIPP: the parent posts their bytes, and the shell asks them what they run. */
export type ZippEngineId = Exclude<EngineId, 'host-js'>;

/**
 * The engines the ZIPP entry document (`index.html`) serves: the
 * JavaScript-and-Python build every hosted app has always run on, and the
 * same release's JavaScript-only build beside it. Both run under this
 * document's one glue and its one policy; they differ in the bytes the parent
 * posts, and in what the loaded engine then says it can run.
 *
 * It is the document, not the build, that decides: the engine has to be known
 * before the shell writes its Content-Security-Policy, and a meta policy can
 * only ever be tightened afterwards. A second document with a different policy
 * is how another kind of engine is served — see
 * {@link HOST_JS_DOCUMENT_ENGINES}.
 */
export const ZIPP_DOCUMENT_ENGINES: readonly EngineId[] = ['zipp-web-python', 'zipp-web'];

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
export const RUNTIME_ENGINES: readonly EngineId[] = ['host-js', 'zipp-web', 'zipp-web-python'];

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

/**
 * How a FormLogic has to read an app's logic languages before it installs this
 * archive.
 *
 * `softn-release.json` carries this as `protocols.logicLanguages`, beside the
 * native, editor-bridge and hosted-engine numbers, and the packager reads it
 * from here rather than keeping a number of its own. An archive that declares
 * it treats a client logic file's name as a language declaration, so a
 * FormLogic that would hand a `.py` file to a JavaScript engine has to learn
 * the rule before it can install the runtime that follows it.
 */
export const LOGIC_LANGUAGES_PROTOCOL = 1;

/**
 * Capabilities this runtime has beyond the engines it serves, for a FormLogic
 * to switch on. `hosted-runtime/runtime-manifest.json` names exactly this
 * list — the packager reads this declaration out of this file, the way it
 * reads {@link RUNTIME_ENGINES} — so what an installed runtime can be asked
 * for and what it says it can be asked for cannot drift apart.
 *
 * `python-logic/1` is the contract in {@link bundleLanguages} and
 * {@link requireBundleLanguages}: a client logic file whose name ends `.py` is
 * Python, an app's languages are derived from those names and nothing else,
 * and an engine that cannot run one of them is refused by name rather than
 * handed the file.
 *
 * Written out rather than computed for the same reason the engine list is: the
 * packager reads it without running anything.
 */
export const RUNTIME_FEATURES: readonly string[] = ['python-logic/1'];

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
 * Languages an engine id promises — exactly these, no more and no fewer.
 * ZIPP ships as more than one build from one glue, so the id the parent names
 * and the bytes it sends can disagree in either direction: the Python build
 * posted under the JavaScript-only name is as wrong as the reverse, because
 * the owner chose the smaller engine and a parent that quietly ran the larger
 * one would make that choice a lie. The shell checks the engine's own profile
 * against this rather than trusting either side's records.
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
 * Refuse an engine whose loaded profile does not run exactly what its id
 * promises.
 *
 * The check is the engine's own answer, taken after it has loaded, so a parent
 * that names `zipp-web-python` and posts the JavaScript-only build is caught
 * here rather than at the first Python file, and the reason names the language
 * that is missing; and a parent that names `zipp-web` and posts the Python
 * build is caught the same way, with the reason naming the language the
 * smaller engine was chosen not to have.
 */
export function requireEngineLanguages(engine: EngineId, languages: readonly string[]): void {
  const required = ENGINE_REQUIRED_LANGUAGES[engine];
  const missing = required.filter((name) => !languages.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `The ${engine} engine must run ${missing.join(' and ')}, and the supplied engine does not`
    );
  }
  const extra = languages.filter((name) => !required.includes(name));
  if (extra.length > 0) {
    throw new Error(
      `The ${engine} engine runs ${required.join(' and ') || 'nothing'} only, and the supplied engine also runs ${extra.join(' and ')}`
    );
  }
}

/**
 * What each engine can actually execute.
 *
 * Deliberately not {@link ENGINE_REQUIRED_LANGUAGES}, which is the other
 * direction: that map says what a loaded engine's own profile has to REPORT
 * before the shell will believe the parent sent the bytes it named, and
 * `host-js` reports nothing because it has no profile to read. This map says
 * what the engine RUNS, which for `host-js` is the document's own JavaScript.
 * Merging them would make a Python bundle on `host-js` pass, because an empty
 * requirement is satisfied by anything.
 */
export const ENGINE_LANGUAGES: Record<EngineId, readonly string[]> = {
  'zipp-web-python': ['javascript', 'python'],
  'zipp-web': ['javascript'],
  'host-js': ['javascript'],
};

/** A client logic file with this name ending is Python. */
export const PYTHON_LOGIC_SUFFIX = '.py';

/**
 * The languages an app's logic is written in, from its client file names.
 *
 * The name is the whole declaration. Nothing inside a bundle can claim a
 * language its files do not, a manifest that says otherwise is not consulted,
 * and FormLogic derives the same list from the same client files on its own
 * side — so the shell's answer and the server's are the same answer, reached
 * the same way, and an app cannot be one thing to the engine chooser and
 * another to the engine.
 *
 * `javascript` is always there: an app's markup and its template expressions
 * are evaluated on this side whatever its `.logic` files are written in.
 *
 * DELIBERATELY BROADER than the composer's rule. `composeBundleSource` marks a
 * bundle Python only for a `.py` the markup or the manifest actually
 * references as logic; this counts ANY client file ending `.py`, referenced or
 * not. So a JavaScript app that ships an unreferenced `example.py` as an asset
 * is refused on `zipp-web` and `host-js` although it would have run. That is
 * the conservative side, and it is chosen on purpose: FormLogic's server-side
 * `languagesOf` applies this same any-client-filename rule when it decides
 * which engines to offer, and the one thing the two sides must never do is
 * disagree — an app that is Python to the chooser and JavaScript to the shell,
 * or the reverse, is an app whose engine was picked for a different app.
 * Narrowing this to the composer's rule would need the server narrowed in the
 * same commit; do not do one without the other.
 */
export function bundleLanguages(paths: Iterable<string>): readonly string[] {
  for (const path of paths) {
    if (typeof path === 'string' && path.toLowerCase().endsWith(PYTHON_LOGIC_SUFFIX)) {
      return ['javascript', 'python'];
    }
  }
  return ['javascript'];
}

/**
 * Refuse an engine that cannot run the languages this app's logic is in.
 *
 * Neither `zipp-web` nor `host-js` can execute Python at all — one is ZIPP's
 * JavaScript-only build, the other is this document's own JavaScript engine —
 * so an app with a `.py` logic file arriving on either of them is a decision
 * that was already wrong when it was made. It is refused by name, the way an
 * engine a document does not serve is, rather than started on an engine that
 * would fail somewhere later with a syntax error about the author's Python.
 */
export function requireBundleLanguages(engine: EngineId, languages: readonly string[]): void {
  const missing = languages.filter((name) => !ENGINE_LANGUAGES[engine].includes(name));
  if (missing.length > 0) {
    throw new Error(
      `This app's logic is written in ${missing.join(' and ')}, and the ${engine} engine does not run ${missing.length > 1 ? 'those languages' : 'that language'}`
    );
  }
}

/**
 * The identity a ZIPP engine is announced with: the bytes the parent must
 * post, named by the release they came from. The primary engine's is the
 * install's own record; a variant's is the same record with the variant's
 * digest, because it is the same release built again.
 */
export interface ZippIdentity {
  version: string;
  sha256: string;
  release?: string;
}

/** The shape of the install's SOURCE.json this module reads: the primary record and its variants. */
export interface ZippInstallRecord {
  version: string;
  sha256: string;
  release?: string;
  variants?: { web?: { sha256: string } };
}

/**
 * One identity per ZIPP engine id, from the installed release's SOURCE.json.
 *
 * `zipp-web-python` is the install itself. `zipp-web` is its `variants.web`
 * record — the JavaScript-only build of the same release, verified against the
 * same SHA256SUMS and installed beside it — and is absent when the install has
 * none, which only a local engine build (`--install-local`) can be: a release
 * install is refused without it.
 */
export type ZippIdentities = { 'zipp-web-python': ZippIdentity } & Partial<Record<ZippEngineId, ZippIdentity>>;

export function zippIdentities(source: ZippInstallRecord): ZippIdentities {
  const primary: ZippIdentity = { version: source.version, sha256: source.sha256, release: source.release };
  const web = source.variants?.web;
  return {
    'zipp-web-python': primary,
    ...(web && typeof web.sha256 === 'string' ? { 'zipp-web': { ...primary, sha256: web.sha256 } } : {}),
  };
}

/**
 * The engines of `served` this build can really serve: every non-ZIPP one,
 * and every ZIPP one whose bytes the install can name. A ZIPP engine without
 * an identity is dropped from what the document accepts AND announces, in one
 * place, so a parent is never invited to ask for bytes nobody can vouch for
 * and never refused something it was invited to ask for.
 */
export function servableEngines(served: readonly EngineId[], identities: Partial<Record<ZippEngineId, ZippIdentity>>): readonly EngineId[] {
  return served.filter((id) => id === HOST_JS_DOCUMENT || identities[id as ZippEngineId] !== undefined);
}

/**
 * The `engines` map a document announces in `formlogic:ready`, built from the
 * same list it accepts in `init`, so a parent can never be invited to ask for
 * something it would then be refused.
 *
 * A ZIPP engine is described by its identity — the release, and the digest of
 * the bytes the parent must send for that id. `host-js` is described by
 * `true`: it runs on this document's own JavaScript, so there are no engine
 * bytes to name and nothing for the parent to fetch. A ZIPP id with no
 * identity is not announced; callers pass a list {@link servableEngines} has
 * already reduced, and the two agree by construction.
 */
export function readyEngines<T>(served: readonly EngineId[], identities: Partial<Record<ZippEngineId, T>>): Record<string, T | true> {
  const engines: Record<string, T | true> = {};
  for (const id of served) {
    if (id === HOST_JS_DOCUMENT) engines[id] = true;
    else {
      const identity = identities[id as ZippEngineId];
      if (identity !== undefined) engines[id] = identity;
    }
  }
  return engines;
}
