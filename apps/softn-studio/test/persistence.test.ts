import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodePersistedVFS,
  loadRecentProjects,
  loadVFSSnapshot,
  loadWorkspaceSnapshot,
  saveRecentProject,
} from '../src/lib/persistence';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Studio persistence', () => {
  it('survives storage access being blocked', () => {
    const blockedWindow = {} as Window;
    Object.defineProperty(blockedWindow, 'localStorage', {
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    vi.stubGlobal('window', blockedWindow);

    expect(loadWorkspaceSnapshot()).toBeNull();
    expect(loadVFSSnapshot()).toBeNull();
    expect(loadRecentProjects()).toEqual([]);
    expect(() =>
      saveRecentProject({
        id: 'one',
        name: 'One',
        target: 'web',
        lastModified: 'today',
      })
    ).not.toThrow();
  });

  it('ignores malformed saved collections instead of trusting their cast', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) =>
          key.endsWith('recent.v1') ? '{"not":"an array"}' : '{"files":"bad"}',
        setItem: () => {},
      },
    });

    expect(loadVFSSnapshot()).toBeNull();
    expect(loadRecentProjects()).toEqual([]);
  });

  it('skips a corrupt binary asset while restoring the remaining files', () => {
    const decoded = decodePersistedVFS({
      files: [
        {
          path: 'ui/main.ui',
          mimeType: 'text/plain',
          lastModified: 0,
          lastModifiedBy: 'user',
          version: 1,
          kind: 'text',
          content: 'hello',
        },
        {
          path: 'assets/bad.png',
          mimeType: 'image/png',
          lastModified: 0,
          lastModifiedBy: 'user',
          version: 1,
          kind: 'binary',
          content: '%%%not-base64%%%',
        },
      ],
    });

    expect(decoded).toEqual([{ path: 'ui/main.ui', content: 'hello' }]);
  });
});
