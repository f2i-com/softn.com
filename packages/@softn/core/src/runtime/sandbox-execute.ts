import { Engine } from '../../wasm-zipp/zipp_wasm.js';
/** Each invocation is a fresh guest: no shared globals, bridges or host callbacks. */
export function executeSandbox(source: string, input: unknown): unknown {
  if (typeof source !== 'string' || source.length > 65536) throw Error('Script exceeds 64 KiB');
  const engine = new Engine();
  try {
    engine.setSyncHostCapabilities([]);
    engine.setInstructionBudget(500000);
    engine.initScript(source);
    if (engine.drainPendingHostCalls().length) throw Error('Sandbox host access is disabled');
    const result = engine.callFunction('update', [input]);
    if (engine.drainPendingHostCalls().length) throw Error('Sandbox host access is disabled');
    const text = JSON.stringify(result);
    if (!text || text.length > 65536) throw Error('Sandbox result exceeds 64 KiB');
    return JSON.parse(text);
  } finally { engine.free(); }
}
