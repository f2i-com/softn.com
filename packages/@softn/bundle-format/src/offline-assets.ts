/** Ask the active worker to persist this build's assets, including on an editor's first uncontrolled visit. */
export async function keepOfflineAssets(
  request: { type: 'SOFTN_KEEP_CLASSIC'; groups: string[] } | { type: 'SOFTN_KEEP_COMPILER'; format: 'jsx' | 'vue' },
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const serviceWorker = globalThis.navigator?.serviceWorker;
  if (!serviceWorker) throw new Error('Offline storage is unavailable in this browser.');
  const channel = new MessageChannel();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(signal?.reason ?? new Error('Cancelled'));
    const timer = setTimeout(() => finish(new Error('The offline installer did not respond.')), 60_000);
    signal?.addEventListener('abort', abort, { once: true });
    channel.port1.onmessage = ({ data }) => finish(data?.ok === true ? undefined : new Error(data?.error ?? 'The requested offline files were unavailable.'));
    // Prompt-mode editors do not claim their first tab. Their active worker can still
    // install a group by message, ready for the next (possibly offline) navigation.
    void serviceWorker.ready.then((registration) => {
      if (settled) return;
      const worker = serviceWorker.controller ?? registration.active;
      if (!worker) throw new Error('The offline installer is unavailable.');
      worker.postMessage(request, [channel.port2]);
    }).catch(finish);
  });
}
