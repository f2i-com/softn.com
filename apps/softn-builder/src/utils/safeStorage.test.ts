import { afterEach, describe, expect, it, vi } from 'vitest';
import { readLocalStorage, removeLocalStorage } from './safeStorage';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('safe local storage access', () => {
  it('survives storage access being blocked by the browser', () => {
    const blockedWindow = {} as Window;
    Object.defineProperty(blockedWindow, 'localStorage', {
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    vi.stubGlobal('window', blockedWindow);

    expect(readLocalStorage('softn.builder.session.v1')).toBeNull();
    expect(() => removeLocalStorage('softn.builder.session.v1')).not.toThrow();
  });

  it('returns stored values and removes them when storage is available', () => {
    const values = new Map([['session', 'saved']]);
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => values.delete(key),
      },
    });

    expect(readLocalStorage('session')).toBe('saved');
    removeLocalStorage('session');
    expect(readLocalStorage('session')).toBeNull();
  });
});
