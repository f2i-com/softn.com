/**
 * The desktop loader's bridge to the native XDB backend: whether the page is
 * inside Tauri, and the invoke and event-listen calls the service makes.
 * Nothing here is part of core's public surface; xdb-service.ts is the only
 * importer.
 */

// ============================================================================
// Tauri Integration
// ============================================================================

/**
 * Check if running in Tauri environment
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

/**
 * Tauri invoke wrapper with type safety
 */
export async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error('Not running in Tauri environment');
  }
  // @ts-expect-error - Tauri globals
  return window.__TAURI__.core.invoke(cmd, args);
}

/**
 * Listen to Tauri events
 */
export function tauriListen(event: string, handler: (payload: unknown) => void): () => void {
  if (!isTauri()) {
    return () => {};
  }
  // @ts-expect-error - Tauri globals
  const unlisten = window.__TAURI__.event.listen(event, (e: { payload: unknown }) =>
    handler(e.payload)
  );
  // Return cleanup function (unlisten returns a promise)
  return () => {
    unlisten.then((fn: () => void) => fn());
  };
}
