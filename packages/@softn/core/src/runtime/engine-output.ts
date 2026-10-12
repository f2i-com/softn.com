/**
 * What the guest printed, forwarded to the page's console.
 *
 * ZIPP accumulates `print` and `console.log`/`info`/`debug`/`error` output
 * inside the VM and hands it over on request, so it has to be collected after
 * every re-entry or an app's own diagnostics are simply lost. `takeOutput`
 * merges the out and error streams, so the original severity is not
 * recoverable and everything is reported at log level, except the runtime's
 * own lines (see `RUNTIME_LINE` below).
 *
 * One function rather than one per adapter: the JavaScript and Python adapters
 * drive different engine APIs but the same output buffer, and an app's `print`
 * reaching the console on one language and not the other would be a difference
 * nobody chose. It is also the only `console` call either adapter makes.
 */

/** The part of an engine this needs: an output buffer it can be asked for. */
export interface EngineOutputSource {
  takeOutput(): unknown;
}

/**
 * The runtime's own word on a script that failed: a line that begins
 * "[SoftN]". The ZIPP adapter has the guest write one when a function the
 * host called rejects after it returned (zipp-wasm-adapter.ts), since only
 * the guest sees that. It is an error, not app output, and is printed as one:
 * hosts read errors that begin this way (Studio's previewFaults.ts).
 */
const RUNTIME_LINE = '[SoftN]';

/** Where the runtime's lines go instead of the console; see {@link setEngineFaultSink}. */
let faultSink: ((line: string) => void) | null = null;

/**
 * Send the runtime's lines somewhere other than this realm's console. The
 * script worker does, so that they are printed on the page, where hosts are
 * listening, and not in the worker's own console, where none are.
 */
export function setEngineFaultSink(sink: ((line: string) => void) | null): void {
  faultSink = sink;
}

/**
 * Print one of the runtime's lines that came out of the engine as text, the
 * way the runtime prints its own: what it is about, up to the first ": ", and
 * then what went wrong, as a second argument. Hosts read the first argument
 * alone for whose function failed (the Builder's previewProblems.ts).
 */
export function printRuntimeLine(line: string): void {
  const split = /^(\[SoftN\][^:]*:) ([\s\S]*)$/.exec(line);
  if (split) console.error(split[1], split[2]);
  else console.error(line);
}

/**
 * Drain and print whatever the guest wrote. Safe on an engine that has been
 * torn down or trapped: there is nothing left to say, and a failure here must
 * never replace the failure the caller is already reporting.
 */
export function flushEngineOutput(engine: EngineOutputSource): void {
  let lines: string[];
  try {
    lines = (engine.takeOutput() as string[]) || [];
  } catch {
    return;
  }
  for (const line of lines) {
    if (typeof line === 'string' && line.startsWith(RUNTIME_LINE)) {
      if (faultSink) faultSink(line);
      else printRuntimeLine(line);
      continue;
    }
    // eslint-disable-next-line no-console -- the app's own print() output: forwarding it to the console is this function's job
    console.log(line);
  }
}
