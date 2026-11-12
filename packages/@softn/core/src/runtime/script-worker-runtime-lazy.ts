/**
 * The worker script runtime, loaded when an app that asked for one starts.
 *
 * SoftNRenderer makes its runtime synchronously, inside an effect, so this
 * hands it a handle at once and loads the real runtime (script-worker-
 * runtime.ts, some 15 KB) behind it: a host that never opens an app asking
 * for a worker never parses it. Context updates and the app root given before
 * it has loaded are passed on when it has, in order, and a cleanup before then
 * ends it as it arrives.
 */
import type { ScriptRuntimeHandle } from './script-runtime';
import type { createWorkerScriptRuntime } from './script-worker-runtime';

export function createWorkerScriptRuntimeLazily(...args: Parameters<typeof createWorkerScriptRuntime>): ScriptRuntimeHandle {
  let made: ScriptRuntimeHandle | null = null;
  let cleanedUp = false;
  const updates: Parameters<ScriptRuntimeHandle['updateContext']>[0][] = [];
  let appRoot: Element | null | undefined;
  // A grant given before the runtime has loaded: it starts under the config
  // it was made with, so the newer one is handed on as soon as it is there.
  let config: Parameters<NonNullable<ScriptRuntimeHandle['setPermissionConfig']>>[0] | undefined;
  const ready = import('./script-worker-runtime').then(({ createWorkerScriptRuntime: create }) => {
    const runtime = create(...args);
    made = runtime;
    if (cleanedUp) {
      runtime.cleanup();
      return runtime;
    }
    if (config !== undefined) runtime.setPermissionConfig?.(config);
    for (const update of updates.splice(0)) runtime.updateContext(update);
    if (appRoot !== undefined) runtime.setAppRoot?.(appRoot);
    return runtime;
  });
  // A failed load is reported by loadScript, which awaits the same promise.
  ready.catch(() => {});
  return {
    loadScript: async (script) => (await ready).loadScript(script),
    updateContext: (update) => {
      if (made) made.updateContext(update);
      else updates.push(update);
    },
    cleanup: () => {
      cleanedUp = true;
      made?.cleanup();
    },
    setAppRoot: (element) => {
      appRoot = element;
      made?.setAppRoot?.(element);
    },
    setPermissionConfig: (next) => {
      config = next;
      made?.setPermissionConfig?.(next);
    },
    consentStatus: () => made?.consentStatus?.() ?? { waiting: [], refused: 0 },
    carryOut: async () => (made?.carryOut ? made.carryOut() : { ok: false, why: 'its logic had not started' }),
    observe: (names) => made?.observe?.(names),
  };
}
