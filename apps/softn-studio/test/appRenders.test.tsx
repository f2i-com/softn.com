/** @vitest-environment jsdom */
/**
 * What makes Studio draw itself again.
 *
 * The shell took the whole workspace store, for five of its fields: every line of the log
 * (the agent's steps, what the app prints), every result of the check and every change of the
 * dirty flag drew the whole editor again, preview and panels included. Fifty log lines were
 * fifty redraws of everything. It reads its five fields alone now; so does the chat, which
 * drew every run of the conversation again for each line of the log.
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

let shellRenders = 0;
// The home page stands for the shell: it is drawn exactly when the shell is.
vi.mock('../src/components/layout/Dashboard', () => ({
  Dashboard: () => {
    shellRenders++;
    return null;
  },
}));

let timelineRenders = 0;
vi.mock('../src/components/ai/RunTimeline', () => ({
  isReadableRun: () => true,
  RunTimeline: () => {
    timelineRenders++;
    return null;
  },
}));

it('does not draw the conversation again for a line of the log', async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const { AIChat } = await import('../src/components/ai/AIChat');
  const { useAIStore, useWorkspaceStore } = await import('../src/stores');
  const run = { status: 'finished', entries: [], plan: [], transactions: [], steps: 1, maxSteps: 10, tokens: { input: 1, output: 1 } };
  useAIStore.setState({ messages: Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, role: 'assistant' as const, content: '', timestamp: i, run: { ...run, id: `r${i}` } as never })) });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<AIChat />));
  expect(timelineRenders).toBe(10);
  for (let i = 0; i < 50; i++) act(() => useWorkspaceStore.getState().addConsoleOutput(`line ${i}`));
  expect(timelineRenders).toBe(10);
  act(() => root.unmount());
  container.remove();
  useAIStore.setState({ messages: [] });
  useWorkspaceStore.getState().reset();
});

it('does not draw the shell again for a log line, a check result or the dirty flag', async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const { default: App } = await import('../src/App');
  const { useWorkspaceStore } = await import('../src/stores');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<App />));
  for (let i = 0; i < 50 && shellRenders === 0; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(shellRenders).toBeGreaterThan(0);

  const drawn = shellRenders;
  for (let i = 0; i < 50; i++) act(() => useWorkspaceStore.getState().addConsoleOutput(`line ${i}`));
  act(() => useWorkspaceStore.getState().setErrors([{ file: 'ui/main.ui', level: 'warning', type: 'x', message: 'y' }]));
  act(() => useWorkspaceStore.getState().setDirty(true));
  expect(shellRenders).toBe(drawn);

  // What it shows is still followed.
  act(() => useWorkspaceStore.getState().setProjectName('Renamed'));
  expect(shellRenders).toBe(drawn + 1);
  act(() => root.unmount());
  container.remove();
});

it('does not draw the status bar again for a key typed in the chat, a reply arriving or a log line', async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const { Profiler } = await import('react');
  const { StatusBar } = await import('../src/components/layout/StatusBar');
  const { useAIStore, useWorkspaceStore } = await import('../src/stores');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let drawn = 0;
  act(() => root.render(<Profiler id="bar" onRender={() => { drawn++; }}><StatusBar /></Profiler>));
  const first = drawn;
  for (let i = 0; i < 20; i++) act(() => useAIStore.getState().setDraftMessage('x'.repeat(i + 1)));
  for (let i = 0; i < 20; i++) act(() => useWorkspaceStore.getState().addConsoleOutput(`line ${i}`));
  act(() => useAIStore.getState().setCurrentStep('Reading ui/main.ui…'));
  expect(drawn).toBe(first);
  // What it shows is still followed.
  act(() => useAIStore.getState().setAgentState('building'));
  expect(drawn).toBe(first + 1);
  act(() => useAIStore.getState().setAgentState('idle'));
  act(() => root.unmount());
  container.remove();
});
