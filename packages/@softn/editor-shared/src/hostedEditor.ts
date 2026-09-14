/** Private editor session with the same-origin FormLogic parent. No account credentials cross it. */
export const isHostedEditor = () => typeof window !== 'undefined' && window.parent !== window && new URLSearchParams(window.location.search).get('formlogicEditor') === '1';
let currentPort: MessagePort | null = null;
const hostRequests = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
const pendingSaves = new Map<string, { resolve(value: HostedSaveResult): void; timer: ReturnType<typeof setTimeout> }>();
/** How long FormLogic gets to confirm that it took the draft (audit SN-04). */
const SAVE_ACK_TIMEOUT_MS = 60000;

/**
 * What FormLogic did with a save request. `state: 'draft'` means the parent
 * pulled the current project into the owner's DRAFT; publishing still happens
 * in FormLogic through its version-checked hosting APIs, so this is never a
 * claim that the app is live.
 */
export interface HostedSaveResult { ok: boolean; state: 'draft' | 'error'; error?: string }

/**
 * The truthful outcome of asking the host to save (audit SN-04):
 *  - not hosted at all → the caller keeps its own local save path;
 *  - hosted but the parent channel is not open (before the handshake, after
 *    teardown or a parent reload) → NOT handled; the caller must keep the
 *    unsaved edits and tell the user, never fall back to an unrelated export;
 *  - handled → a request id plus a promise that settles only when FormLogic
 *    acknowledges (or the acknowledgement times out).
 */
export type HostedSaveOutcome =
  | { handled: false; reason: 'not-hosted' | 'disconnected' }
  | { handled: true; id: string; completion: Promise<HostedSaveResult> };

export function requestHostedAI(messages: { role: string; content: string }[], signal?: AbortSignal): Promise<string> {
  if (!currentPort) return Promise.reject(new Error('FormLogic is not connected.'));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); hostRequests.delete(id); };
    const abort = () => { currentPort?.postMessage({ kind: 'ai-cancel', id }); finish(); reject(new DOMException('AI request cancelled.', 'AbortError')); };
    const timer = setTimeout(() => { currentPort?.postMessage({ kind: 'ai-cancel', id }); finish(); reject(new Error('AI request timed out.')); }, 180000);
    hostRequests.set(id, { resolve: value => { finish(); typeof value === 'string' ? resolve(value) : reject(new Error('Invalid AI response.')); }, reject: error => { finish(); reject(error); } });
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    currentPort!.postMessage({ kind: 'ai-request', id, messages });
  });
}

export function requestHostedSave(): HostedSaveOutcome {
  if (!isHostedEditor()) return { handled: false, reason: 'not-hosted' };
  const port = currentPort;
  if (!port) return { handled: false, reason: 'disconnected' };
  const id = crypto.randomUUID();
  const completion = new Promise<HostedSaveResult>(resolve => {
    const timer = setTimeout(() => {
      pendingSaves.delete(id);
      resolve({ ok: false, state: 'error', error: 'FormLogic did not confirm the save. Your changes are still in the editor; try again.' });
    }, SAVE_ACK_TIMEOUT_MS);
    pendingSaves.set(id, { resolve, timer });
  });
  port.postMessage({ kind: 'save-requested', id });
  return { handled: true, id, completion };
}

/** Number of saves FormLogic has not acknowledged yet (for teardown warnings). */
export function pendingHostedSaves(): number { return pendingSaves.size; }

function settlePendingSaves(result: HostedSaveResult): void {
  for (const waiting of pendingSaves.values()) { clearTimeout(waiting.timer); waiting.resolve(result); }
  pendingSaves.clear();
}

export function connectHostedEditor(handlers: { open(bytes: Uint8Array, name: string): Promise<void>; export(): Promise<Uint8Array> | Uint8Array }): () => void {
  if (!isHostedEditor()) return () => {};
  let port: MessagePort | null = null;
  let disposed = false;
  let loaded = false;
  let busy = false;
  const ready = () => { if (!port) window.parent.postMessage({ kind: 'formlogic-editor-ready', protocol: 1 }, location.origin); };
  const receive = (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== location.origin || event.data?.kind !== 'formlogic-editor-connect' || event.data?.protocol !== 1 || port || !event.ports[0]) return;
    port = event.ports[0]; currentPort = port;
    port.onmessage = async ({ data }) => {
      if (disposed || typeof data?.id !== 'string') return;
      if (data.kind === 'ai-response') {
        const waiting = hostRequests.get(data.id);
        if (data.ok) waiting?.resolve(data.value); else waiting?.reject(new Error(data.error || 'FormLogic AI request failed.'));
        return;
      }
      if (data.kind === 'save-result') {
        const waiting = pendingSaves.get(data.id);
        if (!waiting) return;
        clearTimeout(waiting.timer); pendingSaves.delete(data.id);
        waiting.resolve(data.ok === true
          ? { ok: true, state: 'draft' }
          : { ok: false, state: 'error', error: typeof data.error === 'string' && data.error ? data.error : 'FormLogic could not take the draft.' });
        return;
      }
      const reply = (value: unknown) => { if (!disposed) port?.postMessage({ id: data.id, ok: true, value }); };
      if (busy) { port?.postMessage({ id: data.id, ok: false, error: 'The editor is busy. Try again shortly.' }); return; }
      busy = true;
      try {
        if (data.method === 'open' && !loaded) {
          if (!(data.bytes instanceof Uint8Array) || data.bytes.byteLength > 24 * 1024 * 1024) throw new Error('Invalid app archive.');
          if (data.theme === 'light' || data.theme === 'dark') {
            document.documentElement.setAttribute('data-theme', data.theme);
            document.documentElement.dispatchEvent(new CustomEvent('softn:theme', { detail: data.theme }));
          }
          await handlers.open(data.bytes, typeof data.name === 'string' ? data.name.slice(0, 150) : 'App');
          if (!disposed) { loaded = true; reply({ opened: true }); }
        } else if (data.method === 'export' && loaded) {
          const bytes = await handlers.export();
          if (bytes.byteLength > 24 * 1024 * 1024) throw new Error('This app exceeds the hosted editor archive limit.');
          reply(bytes);
        } else throw new Error('The editor has not opened this app yet.');
      } catch (error) {
        if (!disposed) port?.postMessage({ id: data.id, ok: false, error: error instanceof Error ? error.message : 'Editor operation failed.' });
      } finally { busy = false; }
    };
    port.start();
  };
  window.addEventListener('message', receive);
  const timer = window.setInterval(ready, 500);
  ready();
  return () => {
    disposed = true; window.clearInterval(timer); window.removeEventListener('message', receive);
    if (currentPort === port) currentPort = null;
    for (const request of hostRequests.values()) request.reject(new Error('Editor closed.')); hostRequests.clear();
    // A save the parent never confirmed is NOT saved: say so instead of leaving a promise hanging.
    settlePendingSaves({ ok: false, state: 'error', error: 'The editor session ended before FormLogic confirmed the save.' });
    port?.close();
  };
}
