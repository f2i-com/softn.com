/* tslint:disable */
/* eslint-disable */

/**
 * A compiled script plus the live VM running it.
 */
export class Engine {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Call the top-level function `name`. Microtasks are drained before this
     * returns, so promise callbacks the call scheduled have already run.
     */
    callFunction(name: string, args: any): any;
    /**
     * Release the callback pending for `call_id` WITHOUT invoking it — the
     * host cancelled or timed the request out. Returns whether one was
     * pending; a later `resolveHostCallback` for the same id then reports
     * `false` and runs nothing.
     */
    cancelHostCallback(call_id: number): boolean;
    /**
     * Deliver `event` to every listener registered for `type`, returning how
     * many ran. The event object is given a no-op `preventDefault` if the host
     * did not supply one, since scripts call it unconditionally.
     */
    dispatchEvent(event_type: string, event: any): number;
    /**
     * Tear the VM down. The engine is unusable afterwards.
     */
    dispose(): void;
    /**
     * Take the `host.call(...)` requests the script has queued, as
     * `[{ id, kind, args }]`, oldest first.
     *
     * The transfer is transactional. A request leaves the guest queue only
     * once its host representation exists: the engine reads a bounded
     * prefix, converts it, and commits exactly that prefix, so a conversion
     * failure leaves the queue intact and is retried with a smaller prefix.
     * Every accepted request therefore ends in one of three states —
     * delivered here exactly once, still queued for the next drain (when the
     * per-drain request or byte allowance is used up), or, for a single
     * request too large to cross even on its own, rejected: it is removed and its
     * callback is invoked with a `RangeError`, so no callback is left
     * pending for a request the host will never see. A host that wants an
     * empty queue keeps draining until this returns an empty array.
     *
     * Until the 11 September 2026 audit's ZIPP-02 the guest helper emptied
     * the queue before its return value crossed the converter, so a
     * conversion failure discarded every queued request while their
     * callbacks stayed registered forever.
     *
     * The transfer is transactional across the WHOLE drain, not only per
     * prefix (the 11 September 2026 close audit's ZA-06):
     *
     * - the peek and commit helpers run without a microtask drain, so no
     *   guest job can touch the queue between a snapshot and its commit,
     *   and the commit names the prefix by its length and its first and
     *   last request ids — a queue that is not what was peeked commits
     *   nothing, and the drain tries again;
     * - a request that has been committed off the queue is delivered by
     *   THIS call whatever happens afterwards. A recoverable failure later
     *   in the same drain (a tampered helper throwing, say) ends the drain
     *   with what was delivered; its cause is thrown by the NEXT
     *   `drainPendingHostCalls`, once, before that drain does anything. A
     *   terminal failure (a resource ceiling) still throws here: the engine
     *   is disposed, so every callback is gone with it and nothing could
     *   be completed anyway.
     *
     * And bounded in attempted WORK, not only in delivered output (ZA-08):
     * at most [`MAX_HOST_CALL_DRAIN_ATTEMPTS`] peeks, retries and
     * rejections, and at most [`MAX_HOST_CALL_DRAIN_WORK_NODES`] nodes and
     * [`MAX_HOST_CALL_DRAIN_WORK_BYTES`] string bytes attempted across them,
     * counted monotonically — a failed attempt's work is not rolled back
     * with its representation budget. Whatever remains waits for the next
     * drain; a host that wants an empty queue keeps draining until this
     * returns an empty array with nothing deferred.
     */
    drainPendingHostCalls(): any;
    /**
     * Evaluate `expr` in the script's global context and return its value
     * as a JSON PROJECTION: the result is passed through the guest's
     * `JSON.stringify` and parsed on the host side. That contract differs
     * from the rich-value one `callFunction` and the slot APIs use, and the
     * differences are the ones `JSON.stringify` makes — `undefined`, a
     * function or a symbol result is `undefined`; `NaN` and the infinities
     * become `null`; `-0` becomes `0`; a BigInt throws; `toJSON` and
     * getters run; own enumerable data properties cross and accessors are
     * evaluated; a cycle throws — and a guest that replaced its `JSON`
     * facilities changes the answer, which is reported as an error rather
     * than as `undefined`. [`Engine::evalInContextRich`] is the rich-value
     * form. Polling state should use the slot/batch APIs, which neither
     * compile nor project.
     *
     * Each call compiles fresh and installs stable-address definitions, so this
     * is for one-off host queries — never a per-frame path. Use
     * [`Engine::callFunction`] there.
     */
    evalInContext(expr: string): any;
    /**
     * Evaluate `expr` in the script's global context and return its value
     * as STRUCTURED DATA, under the same contract as `callFunction` and the
     * slot reads: `-0`, `NaN` and the infinities cross as themselves, a
     * function, class, `Map`, `Date`, typed array or proxy reads as `null`,
     * a cycle reads as `null`, accessors are not invoked, and the result is
     * bounded by the host-value conversion budget. Nothing is stringified
     * and the guest's `JSON` facilities are not involved. Microtasks the
     * evaluation schedules are drained before this returns, as they are for
     * `callFunction`.
     *
     * Shares `evalInContext`'s lifetime ceilings (per-expression bytes,
     * retained wrapper source, call count) and its cost: each call compiles
     * and retains a program. One-off host queries only.
     */
    evalInContextRich(expr: string): any;
    /**
     * Event types the script has registered listeners for, e.g. `["keydown"]`.
     */
    getEventListenerTypes(): any;
    /**
     * Read the global in `index`. Values that cannot cross as data (functions,
     * classes, `Map`, `Date`, …) read as `null`.
     */
    getGlobalByIndex(index: number): any;
    /**
     * Read many globals in one boundary crossing.
     */
    getGlobalsBatch(indices: any): any;
    /**
     * Fingerprint many globals in one boundary crossing.
     *
     * One number per index: equal numbers mean `getGlobalsBatch` would
     * return an equal value, so a host can skip reading the ones that have not
     * moved. `NaN` means "unknown, read it", which is what a value too large
     * to walk reports — the fallback is always the old always-read behaviour.
     * The whole batch, duplicate indices included, walks under one work
     * budget with the same node and string-byte ceilings as a batched read,
     * so the digest never does more work than the read it stands in for
     * could, and every element, hole, key and string byte counts.
     *
     * Digests are 53-bit so they land exactly in a JS number. At that width a
     * collision across a UI's worth of state is not a practical concern, and the
     * cost of one would be a skipped update, not corruption.
     *
     * Built with the same Array and from_f64 that getGlobalsBatch uses, rather
     * than the Float64Array this obviously wants to be. A typed array pulls in
     * `__wbg_new_with_length` and `__wbg_set_index`, and the host import surface
     * is audited: check-wasm-memory.cjs pins the exact set of functions this
     * module may call out to. Widening that list to save an allocation on a
     * path that runs once per frame is a bad trade — the point of pinning it is
     * that it only moves deliberately.
     */
    getGlobalsFingerprint(indices: any): any;
    /**
     * Compile `source` behind the preamble, run its top level, and return the
     * symbol map as `{ name: { index, scope } }`.
     *
     * Bridges should be installed first — a script's top level (and its
     * `_init`) commonly reads `localStorage` or queries `db`.
     */
    initScript(source: string): any;
    /**
     * The engine's own classification of the last error a method of this
     * instance threw:
     *
     * - `"guest"`: the guest threw (recoverable; the engine is usable);
     * - `"conversion"`: a value did not fit the host-value budget, or could
     *   not be inspected safely (recoverable);
     * - `"usage"`: the host misused the API — a bad argument, a call on a
     *   disposed engine, a lifetime allowance such as the eval call count
     *   (recoverable unless `disposed` says otherwise);
     * - `"source"`: `initScript` failed to compile or its top level threw
     *   (the engine is disposed);
     * - `"resource"`: the resource recorder reported a ceiling (the engine
     *   is disposed).
     *
     * Recorded where the error is built, so a guest `throw new
     * Error("budget exceeded")` is `"guest"` however it reads. Meaningful
     * only for the most recent throw; a successful call leaves it stale.
     */
    lastErrorKind(): string;
    constructor();
    /**
     * Run pending microtasks without calling into the script.
     */
    pump(): void;
    /**
     * Restore this engine's instruction budget.
     *
     * The budget is a lifetime total, which bounds a runaway script but also
     * puts a fuse on every long-running embedder: an interactive application
     * is tens of thousands of small calls, and 50M instructions is minutes of
     * ordinary use. Call this BEFORE a re-entry and the bound becomes
     * per-re-entry instead — no single call can run unbounded, which is the
     * property a browser host actually needs, while the application lives as
     * long as its host keeps calling it.
     *
     * Host-only, and that is the whole design: this is a method on the Engine
     * binding, unreachable from guest code, so a guest still cannot raise its
     * own ceiling. Returns false once a budget has actually been spent —
     * exhaustion stays sticky and a torn-down engine stays torn down.
     */
    renewInstructionBudget(): boolean;
    /**
     * Invoke the callback the script passed to `host.call` for `call_id`,
     * returning whether one was pending. `false` means the id is unknown:
     * never issued, already completed, or cancelled — a late or duplicate
     * completion is a no-op, not an error.
     *
     * The id is the JavaScript Number the guest's counter produced; it is
     * validated as a finite positive integer up to 2^53 rather than
     * truncated to 32 bits, so the 2^32nd request can be completed like any
     * other (the 11 September 2026 audit's ZIPP-13). Guest-issued ids are
     * bookkeeping, not authorization: a host must still bind each completion
     * to the Worker/tenant generation that issued the request.
     */
    resolveHostCallback(call_id: number, result: any): boolean;
    /**
     * What this engine currently retains and has spent, as a plain object a
     * host can read between re-entries (cheap: no walk). The first stage of
     * the 11 September 2026 audit's ZIPP-06 — measure retained compiled code
     * before attempting to reclaim it:
     *
     * - `heapBytes`: the payload-aware guest heap estimate the heap ceiling
     *   is enforced against;
     * - `stepsUsed`: bytecode instructions executed under the current budget;
     * - `instructionBudget`: the allowance the host chose;
     * - `evalCalls`, `evalRetainedSourceBytes`: this engine's `evalInContext`
     *   / `evalInContextRich` accounting;
     * - `dynamicCodeCalls`, `dynamicCodeSourceBytes`: every dynamic
     *   compilation attempt (`eval`, `Function`, `ShadowRealm`, host eval)
     *   and the source bytes charged;
     * - `retainedFunctions`, `retainedClasses`: stable-address definitions
     *   retained by successful dynamic compilations — the figure
     *   `dispose()` does NOT reclaim within one WASM instance, so a host
     *   recycles the Worker/WASM instance when their sum across tenants
     *   passes what it accepts;
     * - `retainedFunctionBytes`, `retainedClassBytes`: the bytes those
     *   definitions own (the definition, its bytecode, constants, tables
     *   and retained source) — owned bytes, not the allocator's
     *   reservation, so a host can put a byte figure beside the counts
     *   (ZA-10, stage one);
     * - `programFunctions`, `programBytecodeBytes`, `programSourceBytes`: the
     *   size of this engine's own compiled program, which IS freed with the
     *   engine (B306 stage two);
     * - `consoleLinesBuffered`, `consoleBytesLifetime`, `pinnedBuffers`.
     *
     * These are exact counts, not allocator bytes: compare them with the
     * WASM instance's `memory.buffer.byteLength` (linear-memory high-water)
     * and the process's own memory, which this module cannot see.
     */
    resourceUsage(): any;
    /**
     * Install the object backing `accel.*`: a host that compiles guest-
     * generated functions with its own engine. Its methods receive what
     * the guest passed, except that `make` sees every `g:NAME` entry of the
     * spec resolved to `r:address:length:kind` -- the region of engine
     * memory holding that global's typed array, pinned for the VM's
     * lifetime -- and `state` receives the region of the named array as
     * three numbers. During `run` the host may call [`accelGuestCall`] to
     * run a guest function by name with numbers.
     */
    setAccelBridge(bridge: any): void;
    /**
     * Install the object backing `navigator.clipboard.*`. Clipboard authority
     * is intentionally separate from local storage authority.
     */
    setClipboardBridge(bridge: any): void;
    /**
     * Install the object backing `db.*`. Its methods are called synchronously
     * from inside VM execution, so they must not await. Installing a bridge
     * does not grant any operation; call `setSyncHostCapabilities` separately.
     */
    setDbBridge(bridge: any): void;
    /**
     * Key this engine's global fingerprints with host randomness.
     *
     * Supply two halves of a 64-bit value from a real random source. The
     * digest mixer is invertible, so an unkeyed digest can be SOLVED for a
     * collision — a host skipping reads on matching digests would mirror
     * stale state while the guest moved on. The key is never exposed to guest
     * code and never needs to be stable, since digests are only compared with
     * earlier digests from the same engine.
     *
     * May be called before or after `initScript`; a seed set before is
     * applied at initialization, and the same seed gives the same digests
     * either way. Changing the seed changes every digest, so a host that
     * caches digests must discard them when it re-keys.
     */
    setFingerprintSeed(lo: number, hi: number): void;
    /**
     * Write the global in `index`. A slot currently holding a function or
     * class is left alone, so a host that reads all globals and writes them
     * back cannot destroy the script's own functions.
     */
    setGlobalByIndex(index: number, value: any): void;
    /**
     * Write many globals in one boundary crossing.
     *
     * Strict arity: `indices` and `values` must have the same length, and an
     * index may appear only once. Both are checked before any value is
     * converted or any slot written, so a host-side construction mistake is
     * a `TypeError` rather than a partial write (a short `values` used to
     * write `undefined` into the remaining slots, and extra values were
     * silently ignored — the 11 September 2026 audit's ZIPP-10). A hole in
     * `values` is an explicit `undefined`. All values are converted before
     * the first slot is written, as before.
     */
    setGlobalsBatch(indices: any, values: any): void;
    /**
     * Set this engine's instruction budget to `steps`, clamped to
     * `[1, MAX_INSTRUCTION_BUDGET_STEPS]`.
     *
     * The default lifetime budget is sized for an interactive host. An
     * embedder that runs the SAME script on more than one runtime — this
     * module in the browser, the engine natively or under WASI on a server —
     * needs the budgets to agree, or an expression can complete on one side
     * and be cut off on the other. This is the host-side knob for that; the
     * clamp is the fuse it cannot remove.
     *
     * Called BEFORE `initScript`, the allowance governs top-level execution
     * and `_init` as well: it used to need existing script state, so the one
     * phase a host most wants to bound — a stranger's top level — always ran
     * under the default (the 6 September 2026 audit's Z06). Called after,
     * it renews the running budget to the new size, and every later
     * `renewInstructionBudget` restores that size rather than the default.
     *
     * The value's handling is defined, not incidental: a non-finite number
     * selects the default; a fraction is truncated; zero and negatives clamp
     * to one step; anything above the maximum clamps to it. Host-only, like
     * renewal: a method on the Engine binding, unreachable from guest code.
     * Setting the budget restores nothing else — heap, output and
     * dynamic-code ceilings stay where setup left them. Returns false once a
     * budget has actually been spent, exactly as renewal does, and on a
     * disposed engine.
     */
    setInstructionBudget(steps: number): boolean;
    /**
     * Install the object backing `localStorage.*`. This never provides the
     * clipboard bridge, even when the object happens to have clipboard-like
     * methods.
     */
    setLocalStorageBridge(bridge: any): void;
    /**
     * Replace the exact allowlist for synchronous guest-to-host operations.
     * The list is fixed before initialization so guest execution cannot race
     * or influence a later authority upgrade. Unknown operation names reject
     * the complete update rather than being silently ignored.
     */
    setSyncHostCapabilities(operations: any): void;
    /**
     * Drain every console line produced so far, in order, as
     * `[{ stream: "stdout" | "stderr", text }]`. Draining here empties the
     * same buffers `takeOutput` drains.
     */
    takeConsole(): any;
    /**
     * Drain every console line produced so far — `log`/`info`/`debug` and
     * `warn`/`error` alike — in the order they were written. (The two
     * streams used to be concatenated, stdout first, so interleaved
     * messages lost their order: the 11 September 2026 audit's ZIPP-14.)
     * `takeConsole` returns the same lines tagged with their stream.
     */
    takeOutput(): any;
    /**
     * Whether this engine has been torn down — by `dispose()`, by a
     * resource ceiling, or by a failed initialization. The TRUSTED terminal
     * signal: a host decides "this engine is gone" from this, never from
     * the text of an error (ZA-01).
     */
    readonly disposed: boolean;
    /**
     * Lines the preamble prepends to the host's source.
     */
    readonly preambleLines: number;
}

/**
 * Run a guest function by global name with numbers, from inside a host
 * `accel.run` bridge call and only from there: the engine is re-entered
 * through the context of the call in progress. The guest cannot make a
 * nested host call while it runs.
 */
export function accelGuestCall(name: string, args: Float64Array): number;

/**
 * What this WASM instance has accumulated over every engine it has disposed
 * so far, as JSON-shaped data: `enginesCreated`, `enginesDisposed`, and the
 * disposed engines' summed `retainedFunctions`, `retainedClasses`,
 * `dynamicCodeCalls` and `dynamicCodeSourceBytes`. An engine's compiled
 * preamble-plus-guest program is freed with the engine since B306 stage two
 * (the state owns it; nothing is leaked); the stable-address definitions
 * that successful dynamic compilations install are what still survive
 * `dispose()`. When their total passes
 * what a host accepts, the host recycles the Worker/WASM instance, which is
 * the only reclamation this artifact offers (the 11 September 2026 audit's
 * ZIPP-06, stage 1: measure before reclaiming). Live engines are not
 * included; read each one's `resourceUsage()`.
 */
export function zippInstanceUsage(): any;

/**
 * The limits and semantics this artifact was built with, as JSON.
 *
 * A host used to have only the README's table to go by, and at v0.0.14 four
 * of its rows described an older build (the 6 September 2026 audit's Z04).
 * This is read from the same constants the engine enforces, so it cannot
 * drift; `tests/node/profile-matches-readme.cjs` holds the README to it.
 *
 * `profileVersion` 2 adds provenance and policy (the 11 September 2026
 * audit's ZIPP-18): the source revision the release pipeline built from
 * (`source.sha`, `null` in an unlabelled local build), the grammar goal and
 * strict-mode policy guests are compiled under, the string-transport
 * contract, the batch-write arity, the host-call id width, and the
 * host-boundary work limits — value nodes and bytes, the asynchronous
 * queue's drain and per-request ceilings, the fingerprint budget and the
 * accelerator spec bounds. Fields are only ever added; a host should read
 * the ones it knows.
 */
export function zippProfile(): string;

/**
 * Route Rust panics to `console.error` with a message instead of a bare
 * `unreachable` trap — without this a panic in wasm is undiagnosable.
 */
export function zipp_install_panic_hook(): void;

/**
 * Runs when the module is instantiated, before the host can call anything
 * else. The clock install is not optional: wasm32 has no clock, and `Vm::new`
 * reads one, so a VM constructed before this ran would trap.
 */
export function zipp_start(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_engine_free: (a: number, b: number) => void;
    readonly accelGuestCall: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly engine_callFunction: (a: number, b: number, c: number, d: any) => [number, number, number];
    readonly engine_cancelHostCallback: (a: number, b: number) => [number, number, number];
    readonly engine_dispatchEvent: (a: number, b: number, c: number, d: any) => [number, number, number];
    readonly engine_dispose: (a: number) => void;
    readonly engine_disposed: (a: number) => number;
    readonly engine_drainPendingHostCalls: (a: number) => [number, number, number];
    readonly engine_evalInContext: (a: number, b: number, c: number) => [number, number, number];
    readonly engine_evalInContextRich: (a: number, b: number, c: number) => [number, number, number];
    readonly engine_getEventListenerTypes: (a: number) => [number, number, number];
    readonly engine_getGlobalByIndex: (a: number, b: number) => [number, number, number];
    readonly engine_getGlobalsBatch: (a: number, b: any) => [number, number, number];
    readonly engine_getGlobalsFingerprint: (a: number, b: any) => [number, number, number];
    readonly engine_initScript: (a: number, b: number, c: number) => [number, number, number];
    readonly engine_lastErrorKind: (a: number) => [number, number];
    readonly engine_new: () => number;
    readonly engine_preambleLines: (a: number) => number;
    readonly engine_pump: (a: number) => [number, number];
    readonly engine_renewInstructionBudget: (a: number) => number;
    readonly engine_resolveHostCallback: (a: number, b: number, c: any) => [number, number, number];
    readonly engine_resourceUsage: (a: number) => [number, number, number];
    readonly engine_setAccelBridge: (a: number, b: any) => [number, number];
    readonly engine_setClipboardBridge: (a: number, b: any) => [number, number];
    readonly engine_setDbBridge: (a: number, b: any) => [number, number];
    readonly engine_setFingerprintSeed: (a: number, b: number, c: number) => void;
    readonly engine_setGlobalByIndex: (a: number, b: number, c: any) => [number, number];
    readonly engine_setGlobalsBatch: (a: number, b: any, c: any) => [number, number];
    readonly engine_setInstructionBudget: (a: number, b: number) => number;
    readonly engine_setLocalStorageBridge: (a: number, b: any) => [number, number];
    readonly engine_setSyncHostCapabilities: (a: number, b: any) => [number, number];
    readonly engine_takeConsole: (a: number) => [number, number, number];
    readonly engine_takeOutput: (a: number) => [number, number, number];
    readonly zippInstanceUsage: () => [number, number, number];
    readonly zippProfile: () => [number, number];
    readonly zipp_install_panic_hook: () => void;
    readonly zipp_start: () => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
