import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodePersistedVFS,
  loadAISnapshot,
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

  it('rejects partial workspace and AI objects before they can poison the stores', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) =>
          key.endsWith('workspace.v1')
            ? '{"projectName":"Looks valid but is partial"}'
            : key.endsWith('ai.v1')
              ? '{"providers":[],"messages":[]}'
              : null,
        setItem: () => {},
      },
    });

    expect(loadWorkspaceSnapshot()).toBeNull();
    expect(loadAISnapshot()).toBeNull();
  });

  it('restores fully validated provider options, tool calls, and token usage', () => {
    const snapshot = {
      providers: [
        {
          id: 'provider',
          type: 'custom',
          name: 'Local provider',
          apiKey: 'secret',
          baseUrl: 'https://models.example.test',
          modelId: 'model-a',
          orgId: 'org-a',
        },
      ],
      activeProviderId: 'provider',
      modelProfile: {
        architect: 'model-a',
        builder: 'model-a',
        repair: 'model-a',
        vision: 'model-a',
      },
      messages: [
        {
          id: 'message',
          role: 'assistant',
          content: 'Done',
          timestamp: 1,
          toolCalls: [
            {
              tool: 'write_file',
              args: { path: 'ui/main.ui' },
              result: 'ok',
              status: 'success',
            },
          ],
          tokens: { input: 12, output: 4 },
        },
      ],
      iterationsUsed: 1,
      maxIterations: 15,
      tokensUsed: 16,
      tokenBudget: 50_000,
      filesChanged: 1,
    };
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => (key.endsWith('ai.v1') ? JSON.stringify(snapshot) : null),
        setItem: () => {},
      },
    });

    expect(loadAISnapshot()).toEqual(snapshot);
  });

  it.each([
    ['a non-string optional provider field', { provider: { baseUrl: 42 } }],
    ['a malformed tool-call list', { message: { toolCalls: [{ tool: 'read_file' }] } }],
    [
      'non-record tool arguments',
      {
        message: { toolCalls: [{ tool: 'read_file', args: [], status: 'success' }] },
      },
    ],
    ['a malformed token count', { message: { tokens: { input: -1, output: 2 } } }],
    ['a fractional token count', { message: { tokens: { input: 1.5, output: 2 } } }],
    ['a negative session counter', { counters: { tokensUsed: -1 } }],
    ['a fractional session counter', { counters: { iterationsUsed: 0.5 } }],
  ])('rejects persisted AI state containing %s', (_label, corruption) => {
    const typedCorruption = corruption as {
      provider?: Record<string, unknown>;
      message?: Record<string, unknown>;
      counters?: Record<string, unknown>;
    };
    const provider = {
      id: 'provider',
      type: 'custom',
      name: 'Local provider',
      apiKey: 'secret',
      ...(typedCorruption.provider ?? {}),
    };
    const message = {
      id: 'message',
      role: 'assistant',
      content: 'Done',
      timestamp: 1,
      ...(typedCorruption.message ?? {}),
    };
    const snapshot = {
      providers: [provider],
      activeProviderId: 'provider',
      modelProfile: { architect: '', builder: '', repair: '', vision: '' },
      messages: [message],
      iterationsUsed: 0,
      maxIterations: 15,
      tokensUsed: 0,
      tokenBudget: 50_000,
      filesChanged: 0,
      ...(typedCorruption.counters ?? {}),
    };
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => (key.endsWith('ai.v1') ? JSON.stringify(snapshot) : null),
        setItem: () => {},
      },
    });

    expect(loadAISnapshot()).toBeNull();
  });

  it.each([
    ['a non-string page route', { page: { route: 42 } }],
    [
      'an invalid collection field',
      {
        collection: { fields: [{ name: 'title', type: 'wrong', required: true }] },
      },
    ],
    [
      'an invalid collection relationship',
      {
        collection: { relationships: [{ target: 'users', type: 'wrong' }] },
      },
    ],
  ])('rejects a persisted blueprint containing %s', (_label, corruption) => {
    const typedCorruption = corruption as {
      page?: Record<string, unknown>;
      collection?: Record<string, unknown>;
    };
    const snapshot = {
      projectName: 'Project',
      projectId: null,
      brief: null,
      blueprint: {
        appName: 'Project',
        target: 'web',
        style: 'clean',
        pages: [
          {
            id: 'home',
            name: 'Home',
            route: '/',
            layout: 'stack',
            components: [],
            ...(typedCorruption.page ?? {}),
          },
        ],
        collections: [
          {
            id: 'tasks',
            name: 'tasks',
            fields: [{ name: 'title', type: 'string', required: true }],
            relationships: [{ target: 'users', type: 'one-to-many' }],
            ...(typedCorruption.collection ?? {}),
          },
        ],
        navigation: { type: 'stack', items: ['home'] },
        risks: [],
        assumptions: [],
      },
      taskGraph: [],
      blueprintApproved: true,
      mode: 'design',
      leftPanel: 'ai',
      leftPanelExpanded: true,
      rightSidebarOpen: true,
      bottomDrawerOpen: false,
      bottomTab: 'log',
      advancedMode: false,
      activePageId: 'home',
      activeFilePath: null,
      selectedComponentId: null,
      devicePreset: 'desktop',
      zoom: 100,
      themePreview: 'dark',
      consoleOutput: [],
    };
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => (key.endsWith('workspace.v1') ? JSON.stringify(snapshot) : null),
        setItem: () => {},
      },
    });

    expect(loadWorkspaceSnapshot()).toBeNull();
  });

  it('skips a corrupt binary asset while restoring the remaining files', () => {
    const decoded = decodePersistedVFS({
      files: [
        {
          path: 'ui\\main.ui',
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
        {
          path: '../outside.ui',
          mimeType: 'text/plain',
          lastModified: 0,
          lastModifiedBy: 'user',
          version: 1,
          kind: 'text',
          content: 'outside',
        },
        {
          path: 'UI\\main.ui',
          mimeType: 'text/plain',
          lastModified: 0,
          lastModifiedBy: 'user',
          version: 1,
          kind: 'text',
          content: 'alias',
        },
      ],
    });

    expect(decoded).toEqual([{ path: 'ui/main.ui', content: 'hello' }]);
  });
});
