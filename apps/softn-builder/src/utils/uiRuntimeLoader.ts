/// <reference types="vite/client" />

let registered = false;
let pending: Promise<void> | null = null;

export function isUiRuntimeRegistered(): boolean {
  return registered;
}

export function ensureUiRuntimeRegistered(): Promise<void> {
  if (registered) return Promise.resolve();
  if (!pending) {
    pending = import('@softn/components/lazy').then((m) => {
      m.registerRuntimeComponents();
      registered = true;
    }).catch((error) => {
      pending = null;
      throw error;
    });
  }
  return pending;
}

if (import.meta.env.MODE === 'test') {
  await ensureUiRuntimeRegistered();
}
