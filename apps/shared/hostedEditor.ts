/** Private editor session with the same-origin FormLogic parent. No account credentials cross it. */
export const isHostedEditor = () => typeof window !== 'undefined' && window.parent !== window && new URLSearchParams(window.location.search).get('formlogicEditor') === '1';
let currentPort: MessagePort | null = null;
const hostRequests = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
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
export function requestHostedSave(): boolean {
  if (!isHostedEditor()) return false;
  currentPort?.postMessage({ kind: 'save-requested' });
  return true;
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
  return () => { disposed = true; window.clearInterval(timer); window.removeEventListener('message', receive); if (currentPort === port) currentPort = null; for (const request of hostRequests.values()) request.reject(new Error('Editor closed.')); hostRequests.clear(); port?.close(); };
}
