/**
 * The engine a Python app's `.logic` runs on.
 *
 * It is the same ZIPP build every hosted app already runs — `zipp-web-python`,
 * whose profile declares `["javascript", "python"]` — driven through the only
 * API a Python state answers: `initPythonProject` to compile the project and
 * `pythonCall` to enter it. A Python state has no preamble, no global slots and
 * no host-call queue, so `callFunction`, `evalInContext`, `getGlobalByIndex`
 * and `drainPendingHostCalls` all refuse it. Everything the runtime asks of an
 * engine is therefore built on top of `pythonCall`, out of the entry points
 * the generated `__softn_main__.py` declares (see `python-runtime-source.ts`).
 *
 * That makes this a {@link LogicEngine} like any other: `SoftNScriptRuntime`
 * calls the same methods in the same order and never learns which language it
 * is driving. Two things it does differently, and both are forced:
 *
 * - **Every entry renews the instruction budget.** ZIPP's budget is a lifetime
 *   total, and on a Python state reading a variable is an entry, not a slot
 *   read — so an app that merely rendered for long enough would spend the
 *   budget on state reads and be disposed mid-frame. Renewing before each
 *   entry keeps the property that matters (no single entry can run away, which
 *   is what would wedge the tab) while letting an app run as long as the host
 *   drives it. This was measured, not assumed: without renewal a loop costing
 *   well under one budget died on its fourth call.
 * - **Symbol indices are this adapter's own.** Python has no slot table, so the
 *   map it answers numbers the symbols in discovery order and this adapter
 *   remembers the names. Nothing outside reads an index it did not get here.
 */

import { Engine } from '../../../wasm-zipp/zipp_wasm.js';
import { ensureZippTorch, ensureZippWasm, zippLanguages, zippPythonPackages } from '../zipp-wasm-loader';
import { sanitizeArgs } from '../vm-args';
import { flushEngineOutput } from '../engine-output';
import type { DBNamespace } from '../script-runtime';
import type { SymbolInfo, SymbolScope } from '../zipp-wasm-adapter';
import type { LogicEngine, PythonProject } from '../vm-adapter';
import { SOFTN_PY, mainSource } from './python-runtime-source';
import { authorMessage, lineCount, type AuthorLineCounts } from './python-errors';

/** The entry module and the functions the adapter calls on it by name. */
// Named so an app can call its own file `main.py`, which is what the
// Builder's `logic/main.logic` becomes. The only name an app may not take
// is `softn`, because that is the one it imports.
const ENTRY = '__softn_main__';
const SYMBOLS = '__softn_symbols__';
const STATE = '__softn_state__';
const WRITE = '__softn_write__';
const DRAIN = '__softn_drain__';
const DELIVER = '__softn_deliver__';
const LISTENERS = '__softn_listeners__';
const DISPATCH = '__softn_dispatch__';

/** What `__softn_symbols__` answers for each name the app exposes. */
type SymbolRow = [name: string, scope: string, module: string];

/**
 * The language a Python project needs the engine to declare before a single
 * line of it is compiled.
 *
 * ZIPP ships more than one build from one glue, so bytes that cannot run
 * Python load perfectly well and then fail at the first Python call with a
 * `TypeError` about a missing WASM export. Asking the engine's own profile
 * first turns that into one sentence a person can act on.
 */
const REQUIRED_LANGUAGE = 'python';

export class PythonLogicAdapter implements LogicEngine {
  private wasm: Engine;
  private symbolMap: Map<string, SymbolInfo> = new Map();
  /** Index → name, the other half of {@link symbolMap}. */
  private names: string[] = [];
  private authorLines: AuthorLineCounts = new Map();
  private _disposed = false;
  private _terminated = false;
  private instructionBudget: number | undefined = undefined;

  /** Never called: a bridge for a namespace a Python guest does not have. */
  onStorageFailure: ((failure: { operation: string; key: string; error: Error }) => void) | null = null;

  private constructor(wasm: Engine) {
    this.wasm = wasm;
  }

  /**
   * Make an engine for a Python project, or refuse because these bytes cannot
   * run Python.
   */
  static async create(): Promise<PythonLogicAdapter> {
    await ensureZippWasm();
    const languages = await zippLanguages();
    if (!languages.includes(REQUIRED_LANGUAGE)) {
      throw new Error(
        `This app's logic is written in Python, and the engine this page loaded runs only ${
          languages.length ? languages.join(' and ') : 'JavaScript'
        }`
      );
    }
    return new PythonLogicAdapter(new Engine());
  }

  // ── Bridges a Python guest has no names for ──
  //
  // `db`, `localStorage` and `navigator.clipboard` are globals ZIPP's
  // JavaScript preamble declares. A Python state has no preamble and no such
  // names, so there is nothing for these to wire. They are accepted and do
  // nothing rather than throwing, because the runtime installs them for every
  // engine and a throw here would fail the load with a message about a
  // capability the app never asked for. What Python can reach is `softn.*`,
  // which goes through the host-call queue like every other capability.

  registerDBBridge(_db: DBNamespace): void {
    /* See above: no `db` global exists in a Python state. */
  }

  registerLocalStorageBridge(_appId?: string): void {
    /* See above: no `localStorage` global exists in a Python state. */
  }

  registerClipboardBridge(): void {
    /* See above: no `navigator` global exists in a Python state. */
  }

  /** Per-entry step budget; see {@link renewBudget}. */
  setInstructionBudget(steps: number | undefined): void {
    this.instructionBudget =
      typeof steps === 'number' && Number.isFinite(steps) && steps >= 1
        ? Math.min(Math.floor(steps), 2_000_000_000)
        : undefined;
  }

  /**
   * Restore the budget before entering the guest. See the note at the top of
   * this file for why this happens before every entry and not only before a
   * function call.
   */
  private renewBudget(): void {
    const engine = this.wasm as unknown as {
      renewInstructionBudget?: () => boolean;
      setInstructionBudget?: (steps: number) => boolean;
    };
    try {
      if (this.instructionBudget !== undefined && typeof engine.setInstructionBudget === 'function') {
        engine.setInstructionBudget(this.instructionBudget);
      } else if (typeof engine.renewInstructionBudget === 'function') {
        engine.renewInstructionBudget();
      }
    } catch {
      // An engine too far gone to renew is about to report that itself.
    }
  }

  /** Forward anything the app printed — the same function, so a `print`
   * reaches the console on both languages or on neither. */
  private flushOutput(): void {
    if (this._disposed || this._terminated) return;
    flushEngineOutput(this.wasm);
  }

  /**
   * One entry into the guest: renew, call, translate the failure, flush what
   * it printed.
   */
  private enter(name: string, args: unknown[]): unknown {
    if (this._terminated || this._disposed) {
      throw new Error('This app’s engine has stopped and will not run again');
    }
    this.renewBudget();
    try {
      return this.wasm.pythonCall(name, args);
    } catch (error) {
      throw this.translate(error);
    } finally {
      this.flushOutput();
    }
  }

  /**
   * The engine's failure as something the author can act on.
   *
   * `lastErrorKind()` is only meaningful while handling a failure, which is why
   * it is read here and nowhere else. A `resource` failure — the instruction
   * budget — takes the engine with it, so it is recorded: the runtime stops
   * driving a dead engine instead of logging the same line every frame.
   */
  private translate(error: unknown): Error {
    let kind = '';
    try {
      kind = String(this.wasm.lastErrorKind() ?? '');
    } catch {
      // An engine that cannot say is one that has already gone.
    }
    const raw = error instanceof Error ? error.message : String(error);
    if (kind === 'resource' || /engine is disposed/i.test(raw)) this._terminated = true;
    // A resource failure is the engine's own sentence about a budget the
    // author never set, so it keeps the engine's words. Everything else is
    // the author's code talking, and is rewritten in their terms.
    const message = kind === 'resource' ? raw : authorMessage(raw, this.authorLines);
    const translated = new Error(message);
    if (error instanceof Error && error.stack) translated.stack = error.stack;
    return translated;
  }

  /**
   * Compile and run a Python project, answering the same symbol map
   * `initializeScript` answers for JavaScript.
   *
   * The author's modules go to the engine exactly as written — nothing is
   * prepended or appended — so every line keeps the number they wrote it at
   * and an error names a line they can open. What the runtime adds is two
   * files of its own, `__softn_main__.py` and `softn.py`.
   */
  async initializePythonProject(project: PythonProject): Promise<Map<string, SymbolInfo>> {
    await ensureZippWasm();
    // A declared package the engine does not carry is added now, before a
    // line compiles: the engine Softn ships (ZIPP's web-python-base) has no
    // torch built in, and ZIPP publishes it as a package the runtime loads
    // once per page, only for apps that declare it. One that still cannot be
    // provided is refused by name here. Otherwise the app's first
    // `import torch` would fail as a ModuleNotFoundError from inside its own
    // code, which reads as the author's mistake rather than the page's.
    if (project.packages?.length) {
      let available = await zippPythonPackages();
      let missing = project.packages.filter((name) => !available.includes(name));
      let reason = '';
      if (missing.includes('torch')) {
        try {
          await ensureZippTorch();
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error);
        }
        available = await zippPythonPackages();
        missing = project.packages.filter((name) => !available.includes(name));
      }
      if (missing.length > 0) {
        this._terminated = true;
        throw new Error(
          `This app uses the Python package${missing.length > 1 ? 's' : ''} ${missing.join(' and ')}, and the engine this page loaded does not provide ${missing.length > 1 ? 'them' : 'it'}${reason ? `: ${reason}` : ''}`
        );
      }
    }
    const files: Record<string, string> = {
      [`${ENTRY}.py`]: mainSource(project.modules),
      'softn.py': SOFTN_PY,
    };
    const authorLines = new Map<string, number>();
    for (const module of project.modules) {
      const source = project.files[module];
      if (source === undefined) {
        throw new Error(`The Python module ${module}.py is not in this app`);
      }
      authorLines.set(module, lineCount(source));
      files[`${module}.py`] = source;
    }
    this.authorLines = authorLines;

    try {
      this.wasm.initPythonProject(files, ENTRY, []);
    } catch (error) {
      this.flushOutput();
      // A project that failed to compile leaves the engine unusable, exactly as
      // a failed `initScript` does on the JavaScript side.
      this._terminated = true;
      throw this.translate(error);
    } finally {
      this.flushOutput();
    }

    const rows = (this.enter(SYMBOLS, []) as SymbolRow[]) || [];
    this.symbolMap = new Map();
    this.names = [];
    for (const row of rows) {
      const [name, scope] = row;
      if (typeof name !== 'string') continue;
      const index = this.names.length;
      this.names.push(name);
      this.symbolMap.set(name, { index, scope: (scope === 'function' ? 'function' : 'variable') as SymbolScope });
    }
    return this.symbolMap;
  }

  /**
   * JavaScript source has no meaning to a Python project, and running it as if
   * it had would be the silent substitution this whole seam exists to prevent.
   */
  async initializeScript(_code: string): Promise<Map<string, SymbolInfo>> {
    throw new Error('This engine runs Python app logic, not JavaScript');
  }

  getGlobal(index: number): unknown {
    const name = this.names[index];
    if (name === undefined) return undefined;
    return (this.readState([name]) as Record<string, unknown>)[name];
  }

  setGlobal(index: number, value: unknown): void {
    const name = this.names[index];
    if (name === undefined || value === undefined) return;
    this.writeState({ [name]: value });
  }

  getGlobalsBatch(indices: number[]): unknown[] {
    const names = indices.map((i) => this.names[i]).filter((n): n is string => n !== undefined);
    const state = this.readState(names) as Record<string, unknown>;
    return indices.map((i) => {
      const name = this.names[i];
      return name === undefined ? undefined : state[name];
    });
  }

  /**
   * Write many globals in one entry. `undefined` means the host holds no value
   * for that variable and the guest keeps its own, the same rule the
   * JavaScript adapter follows.
   */
  setGlobalsBatch(indices: number[], values: unknown[]): void {
    const write: Record<string, unknown> = {};
    let any = false;
    for (let i = 0; i < indices.length; i++) {
      const name = this.names[indices[i]];
      if (name === undefined || values[i] === undefined) continue;
      write[name] = values[i];
      any = true;
    }
    if (any) this.writeState(write);
  }

  private readState(names: string[]): unknown {
    if (names.length === 0) return {};
    return this.enter(STATE, [names]) ?? {};
  }

  /**
   * Write state back where it lives, or say which names did not land.
   *
   * `__softn_write__` resolves each name to the module that owns it from the
   * same table `__softn_symbols__` reported, and answers the names it refused:
   * one the table does not offer, or one it offers as a function. The runtime
   * only ever writes names it got from that table, so a refusal is a
   * contradiction between what the engine offered and what it will take — and
   * it is THROWN rather than counted, because a write that did not happen and
   * was not reported is state the host believes and the app does not have.
   *
   * A throw, not `onStorageFailure`: that hook is the localStorage
   * persistence channel, installed only when the app is granted storage and
   * declared never-called on this adapter. A failed engine entry is what every
   * caller of `setGlobalsBatch` already handles — each sync site in
   * `SoftNScriptRuntime` runs inside the try that reports an entry's failure —
   * so the error reaches the console in the same words a raised exception in
   * the author's code would, naming the variables.
   */
  private writeState(values: Record<string, unknown>): void {
    const refused = this.enter(WRITE, sanitizeArgs([values]));
    if (Array.isArray(refused) && refused.length > 0) {
      throw new Error(
        `The Python app offered ${refused.map((name) => `\`${String(name)}\``).join(', ')} as state but would not take ${
          refused.length > 1 ? 'them' : 'it'
        } back`
      );
    }
  }

  callFunction(name: string, args: unknown[]): unknown {
    return this.enter(name, sanitizeArgs(args));
  }

  /** Same as {@link callFunction} — the engine is synchronous. */
  callFunctionSync(name: string, args: unknown[]): unknown {
    return this.callFunction(name, args);
  }

  /**
   * Python has no `evalInContext`, and there is no honest substitute: an
   * expression compiled into a fresh module would not see the app's names.
   * Template expressions never reach this — the renderer evaluates them
   * host-side and calls named functions through the wrappers — so this is the
   * `$:` fallback path saying it is not available rather than guessing.
   */
  evalSync(_expression: string): unknown {
    throw new Error('A Python app cannot evaluate an expression string; call a function instead');
  }

  getEventListenerTypes(): string[] {
    try {
      return (this.enter(LISTENERS, []) as string[]) || [];
    } catch {
      return [];
    }
  }

  dispatchEvent(eventType: string, eventObj: Record<string, unknown>): number {
    return Number(this.enter(DISPATCH, sanitizeArgs([eventType, eventObj])) ?? 0);
  }

  drainPendingHostCalls(): Array<{ id: number; kind: string; args: string[] }> {
    if (this._terminated || this._disposed) return [];
    let rows: Array<[number, string, string[]]>;
    try {
      rows = (this.enter(DRAIN, []) as Array<[number, string, string[]]>) || [];
    } catch {
      // A drain that fails is an engine that is already reporting elsewhere.
      return [];
    }
    return rows.map(([id, kind, args]) => ({ id: Number(id), kind: String(kind), args: (args || []).map(String) }));
  }

  resolveHostCallback(callId: number, result: unknown): void {
    this.enter(DELIVER, sanitizeArgs([callId, result]));
  }

  get terminated(): boolean {
    return this._terminated;
  }

  /** The symbol map, for external inspection. */
  getSymbolMap(): Map<string, SymbolInfo> {
    return this.symbolMap;
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    try {
      try {
        this.wasm.dispose();
      } finally {
        this.wasm.free();
      }
    } catch {
      // Cleanup must remain safe after a prior teardown or a WASM trap.
    }
  }
}
