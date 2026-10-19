import {check, ComputeError} from './graph.mjs';
import {createZippGPUHandler, GPU_KINDS} from './zipp-adapter.mjs';

/**
 * The GPU adapter for a ZIPP **Python** state.
 *
 * A Python program hands work to its embedder as plain host requests
 * (`Engine.takeHostRequests()` returns `{id, kind, payload}` records) and
 * receives each answer through `Engine.pythonCall("__zipp_py_deliver", [id,
 * reply])`, where `reply` is `{ok: true, value}` or `{ok: false, error:
 * {code, message}}`. This adapter owns one such delivery path for one
 * Engine generation: it admits `gpu.execute` requests, runs them one at a
 * time on a compute runtime, and delivers the answers after the
 * asynchronous host work is done and outside any active engine call.
 *
 * `drain()` is meant to be called by the host after every engine call
 * (`initPythonProject`, each `pythonCall`), and again after each delivery,
 * because a callback may submit more work. `onDelivered` lets the host
 * collect the console output and `ui` commands the callback produced.
 */
export function createPythonGPUAdapter(engine, runtime, {allowExecute = false, maxRequests = 4096, maxPending = 16, maxSessions = 16, onDelivered = null} = {}) {
  check(Number.isSafeInteger(maxRequests) && maxRequests > 0 && Number.isSafeInteger(maxPending) && maxPending > 0,
    'LIMIT', 'Adapter request limits must be positive integers');
  const handler = createZippGPUHandler(runtime, {allowExecute, maxSessions});
  let active = true, tail = Promise.resolve(), pending = 0, admitted = 0;
  const live = () => active && !engine.disposed;
  // A macrotask boundary: lets the host's event loop run between rejections.
  const yieldToHost = () => new Promise(resolve => setTimeout(resolve, 0));
  function deliver(id, reply) {
    if (!live()) return false;
    let delivered = false, error = null;
    try {
      delivered = engine.pythonCall('__zipp_py_deliver', [id, reply]) === true;
    } catch (thrown) {
      // The program's callback raised (or the engine hit a limit): the host
      // reports it like any other guest error; the adapter stays usable.
      error = thrown;
    }
    if (onDelivered) onDelivered({id, delivered, reply, error});
    return delivered;
  }
  function admit(request) {
    if (!live()) return Promise.reject(new ComputeError('DISPOSED', 'Adapter generation has ended'));
    if (!request || !GPU_KINDS.includes(request.kind)) return Promise.reject(new ComputeError('DENIED', 'Not a GPU request'));
    if (!Number.isSafeInteger(request.id) || request.id < 1) return Promise.reject(new ComputeError('PROTOCOL', 'Invalid request ID'));
    if (admitted >= maxRequests || pending >= maxPending) {
      // Over quota: the program learns why through its own callback, but only
      // after the current drain has returned and the work ahead of it has
      // settled. Delivering here, inside `drain()`, let a callback that
      // resubmits recurse drain -> deliver -> onDelivered -> drain until the
      // host stack overflowed with the Engine still borrowed.
      const id = request.id;
      const rejection = tail.then(async () => {
        await yieldToHost();
        if (!live()) return {delivered: false, cancelled: true, rejected: true};
        return {delivered: deliver(id, {ok: false, error: {code: 'LIMIT', message: 'GPU request allowance exceeded'}}), cancelled: false, rejected: true};
      });
      tail = rejection.catch(() => {});
      return rejection;
    }
    let payload;
    try { payload = structuredClone(request.payload); }
    catch { return Promise.reject(new ComputeError('PROTOCOL', 'Request payload is not cloneable data')); }
    // An engine that sends tensor inputs as Float32Arrays takes outputs the
    // same way (straight into tensor storage); one that sends lists gets
    // lists, whatever its age. Sessions are typed: their engine is new enough.
    const kind = request.kind;
    const typedOutputs = kind !== 'gpu.execute' || (Array.isArray(payload?.nodes) && payload.nodes.some((node) => node?.data instanceof Float32Array));
    const id = request.id;
    admitted++; pending++;
    const run = tail.then(async () => {
      if (!live()) return {delivered: false, cancelled: true};
      let reply;
      // The payload is this adapter's structuredClone: its feeds need no second copy.
      try { reply = {ok: true, value: await handler.handle(kind, [payload], {typedOutputs, owned: true})}; }
      catch (error) { reply = {ok: false, error: {code: error.code || 'GPU', message: String(error.message || error).slice(0, 512), ...(error?.poisoned ? {poisoned: true} : {})}}; }
      if (!live()) return {delivered: false, cancelled: true};
      // After the asynchronous host work, outside any engine call.
      return {delivered: deliver(id, reply), cancelled: false};
    }).finally(() => { pending--; });
    tail = run.catch(() => {});
    return run;
  }
  return Object.freeze({
    accepts(kind) { return GPU_KINDS.includes(kind); },
    /** Take the engine's pending host requests; GPU ones are admitted here, the rest returned. */
    drain() {
      if (!live()) return [];
      let requests;
      try { requests = engine.takeHostRequests(); } catch { return []; }
      const others = [];
      for (const request of Array.isArray(requests) ? requests : []) {
        if (request && GPU_KINDS.includes(request.kind)) admit(request).catch(() => {});
        else others.push(request);
      }
      return others;
    },
    admit,
    invalidate() { active = false; handler.invalidate(); },
    idle() { return tail; },
    get pending() { return pending; },
    get sessions() { return handler.sessions; },
  });
}
