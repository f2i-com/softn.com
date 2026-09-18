/**
 * What the guest printed, forwarded to the page's console.
 *
 * ZIPP accumulates `print` and `console.log`/`info`/`debug`/`error` output
 * inside the VM and hands it over on request, so it has to be collected after
 * every re-entry or an app's own diagnostics are simply lost. `takeOutput`
 * merges the out and error streams, so the original severity is not
 * recoverable and everything is reported at log level.
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
  // eslint-disable-next-line no-console -- the app's own print() output: forwarding it to the console is this function's job
  for (const line of lines) console.log(line);
}
