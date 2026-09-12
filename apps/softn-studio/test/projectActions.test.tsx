/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectActions, type ProjectActions } from '../src/components/common/ProjectActions';
import { MobileProjectMenu } from '../src/components/mobile/MobileProjectMenu';
import { prepareHandoff, type HandoffOutcome } from '../src/lib/handoff';
import { exportAsBundle } from '../src/lib/exportBundle';
import { useVFSStore, useWorkspaceStore } from '../src/stores';

vi.mock('../src/lib/handoff', async (original) => ({ ...await original<typeof import('../src/lib/handoff')>(), prepareHandoff: vi.fn() }));
vi.mock('../src/lib/exportBundle', () => ({ exportAsBundle: vi.fn() }));

function deferred() {
  let resolve!: (outcome: HandoffOutcome) => void;
  const promise = new Promise<HandoffOutcome>((done) => { resolve = done; });
  return { promise, resolve };
}

const ready: HandoffOutcome = { ok: true, ready: { to: 'runtime', name: 'Notes', url: '/web/?handoff=notes', stagedAt: 1 } };

describe('project action ownership and feedback', () => {
  let container: HTMLDivElement;
  let root: Root;
  let actions: ProjectActions;
  function Harness() { actions = useProjectActions(); return null; }
  function mount(mobile = false) {
    act(() => root.render(mobile ? <MobileProjectMenu /> : <Harness />));
  }
  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetAllMocks();
    useWorkspaceStore.getState().reset();
    useVFSStore.getState().reset();
    useWorkspaceStore.setState({ projectName: 'Notes', projectId: 'notes' });
    useVFSStore.getState().createFile('ui/main.ui', '<Text>Notes</Text>');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('only stages once when two actions run before React commits', async () => {
    const pending = deferred();
    vi.mocked(prepareHandoff).mockReturnValue(pending.promise);
    mount();
    act(() => { actions.run(); actions.publish(); });
    expect(prepareHandoff).toHaveBeenCalledTimes(1);
    expect(actions.preparing).toBe('runtime');
    await act(async () => pending.resolve(ready));
    expect(actions.ready).toMatchObject({ name: 'Notes' });
    expect(actions.preparing).toBeNull();
  });

  it('drops a stale result without clearing a newer preparation', async () => {
    const older = deferred();
    const newer = deferred();
    vi.mocked(prepareHandoff).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    mount();
    act(() => actions.run());
    act(() => useVFSStore.getState().createFile('ui/extra.ui', '<Text>Edited</Text>'));
    act(() => actions.publish());
    await act(async () => older.resolve(ready));
    expect(actions.ready).toBeNull();
    expect(actions.preparing).toBe('publish');
    await act(async () => newer.resolve({ ok: false, message: 'Storage is full. Export the bundle instead.' }));
    expect(actions.preparing).toBeNull();
    expect(actions.error).toContain('Storage is full');
  });

  it.each(['files', 'name', 'identity'] as const)('removes a ready link when the project %s changes', async (change) => {
    vi.mocked(prepareHandoff).mockResolvedValue(ready);
    mount();
    await act(async () => actions.run());
    expect(actions.ready).not.toBeNull();
    act(() => {
      if (change === 'files') useVFSStore.getState().createFile('ui/new.ui', '<Text>New</Text>');
      else if (change === 'name') useWorkspaceStore.getState().setProjectName('New name');
      else useWorkspaceStore.setState({ projectId: 'another-project' });
    });
    expect(actions.ready).toBeNull();
  });

  it('ignores a handoff that completes after leaving the editor', async () => {
    const pending = deferred();
    vi.mocked(prepareHandoff).mockReturnValue(pending.promise);
    mount();
    act(() => actions.run());
    act(() => root.render(null));
    const log = useWorkspaceStore.getState().consoleOutput;
    await act(async () => pending.resolve(ready));
    expect(useWorkspaceStore.getState().consoleOutput).toEqual(log);
  });

  it('shows a staging failure outside the closed phone menu and allows dismissal', async () => {
    vi.mocked(prepareHandoff).mockRejectedValue(new Error('Browser storage is unavailable.'));
    mount(true);
    act(() => container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Browser storage is unavailable');
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Dismiss project action error"]')!.click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('reports an export error and clears it after a successful retry', () => {
    vi.mocked(exportAsBundle).mockImplementationOnce(() => { throw new Error('The archive is invalid.'); });
    mount();
    act(() => actions.exportBundle());
    expect(actions.error).toContain('Could not export the bundle: The archive is invalid.');
    act(() => actions.exportBundle());
    expect(actions.error).toBeNull();
  });
});
