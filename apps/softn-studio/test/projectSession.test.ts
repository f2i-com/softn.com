import { beforeEach, describe, expect, it } from 'vitest';
import { resetProjectSessionForImport } from '../src/lib/projectSession';
import { useAIStore, useVFSStore, useWorkspaceStore } from '../src/stores';

beforeEach(() => {
  useWorkspaceStore.getState().reset();
  useVFSStore.getState().reset();
  useAIStore.setState({
    providers: [],
    activeProviderId: null,
    messages: [],
    agentState: 'idle',
    currentStep: '',
    iterationsUsed: 0,
    tokensUsed: 0,
    filesChanged: 0,
  });
});

describe('project import session reset', () => {
  it('clears the previous project identity, selection, errors, console, files, and chat', () => {
    useWorkspaceStore.setState({
      projectName: 'Old project',
      projectId: 'old-id',
      activePageId: 'old-page',
      activeFilePath: 'ui/old.ui',
      selectedComponentId: 'old-component',
      errors: [{ file: 'ui/old.ui', level: 'error', type: 'parse', message: 'Old error' }],
      consoleOutput: ['Old log'],
      themePreview: 'light',
    });
    useVFSStore.getState().createFile('ui/old.ui', '<Text>Old</Text>');
    useAIStore.getState().addProvider({
      id: 'provider',
      type: 'custom',
      name: 'Provider',
      apiKey: 'secret',
    });
    useAIStore.getState().addMessage({
      id: 'old-message',
      role: 'user',
      content: 'Old chat',
      timestamp: 1,
    });
    useAIStore.setState({ agentState: 'error', currentStep: 'Old step', tokensUsed: 99 });

    resetProjectSessionForImport();

    expect(useWorkspaceStore.getState()).toMatchObject({
      projectName: '',
      projectId: null,
      activePageId: null,
      activeFilePath: null,
      selectedComponentId: null,
      errors: [],
      consoleOutput: [],
      themePreview: 'light',
    });
    expect(useVFSStore.getState().files.size).toBe(0);
    expect(useVFSStore.getState().history).toEqual([]);
    expect(useAIStore.getState()).toMatchObject({
      providers: [expect.objectContaining({ id: 'provider' })],
      messages: [],
      agentState: 'idle',
      currentStep: '',
      iterationsUsed: 0,
      tokensUsed: 0,
      filesChanged: 0,
    });
  });
});
