/**
 * The failed-save alert's look, in the theme the app is drawn in: the
 * provider writes its tokens on this document (see appTheme.ts). It was a
 * fixed pale orange with dark orange text, a light strip across a dark app.
 * The fallbacks are the browser's own colours for the document's side.
 */
export const STORAGE_ALERT_STYLE = [
  'padding:12px',
  'margin:0',
  'background:color-mix(in srgb, var(--color-warning-500, orange) 16%, var(--color-surface, Canvas))',
  'color:var(--color-text, CanvasText)',
  'border-left:4px solid var(--color-warning-500, orange)',
  'font:14px system-ui',
].join(';');

/** Synchronous app cache with ordered, acknowledged writes to the trusted parent. */
export function installAppStorage(snapshot: Record<string, string>, persist: (input: Record<string, unknown>) => Promise<unknown>) {
  const entries = new Map(Object.entries(snapshot));
  let queue = Promise.resolve();
  const flush = (input: Record<string, unknown>) => {
    queue = queue.then(async () => {
      const reply = await persist(input) as { error?: string };
      if (reply?.error) throw new Error(reply.error);
    }).catch(() => {
      // Keep the failure visible: a synchronous cache is not proof of persistence.
      let message = document.getElementById('app-storage-error');
      if (!message) {
        message = document.createElement('p'); message.id = 'app-storage-error';
        message.setAttribute('role', 'alert');
        message.style.cssText = STORAGE_ALERT_STYLE;
        document.body.prepend(message);
      }
      message.textContent = 'Your latest app session could not be saved in this browser. Keep this page open and check browser storage before reloading.';
    });
  };
  const storage: Storage = {
    get length() { return entries.size; },
    key: index => Array.from(entries.keys())[index] ?? null,
    getItem: key => entries.get(String(key)) ?? null,
    setItem(key, value) {
      key = String(key); value = String(value);
      const candidate = new Map(entries); candidate.set(key, value);
      if (key.length > 256 || value.length > 30000 || candidate.size > 200 || JSON.stringify(Object.fromEntries(candidate)).length > 256 * 1024) throw new DOMException('App storage limit reached', 'QuotaExceededError');
      entries.set(key, value); flush({ operation: 'set', key, value });
    },
    removeItem(key) { key = String(key); entries.delete(key); flush({ operation: 'remove', key }); },
    clear() { entries.clear(); flush({ operation: 'clear' }); },
  };
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: false });
}
