/** @vitest-environment jsdom */
/**
 * Editing a file by hand.
 *
 * The code view was for reading; every change went through the chat. Edit
 * now turns it into an editor of the file. What is pinned here is what makes
 * that safe beside an agent that writes the same files: a save is one write
 * by the person, in the history like any other; it is never put over a write
 * it was not made from, by the agent or another tab, and never made while a
 * run is working; what was typed is not lost to a run starting or thrown away
 * without the person agreeing; and Studio's own files and files kept as bytes
 * stay read-only, saying why.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeFile, FileEditor } from '../src/components/canvas/FileEditor';
import { FilesPanel } from '../src/components/panels/FilesPanel';
import { HistoryPanel } from '../src/components/panels/HistoryPanel';
import { executeTool } from '../src/lib/agent/executeTool';
import { buildAgentSystemPrompt } from '../src/lib/agent/prompt';
import type { SuppliedFiles } from '../src/lib/changeset';
import { beginHandEdit, confirmLeaveDraft, handEditRefusal, orphanedDraftPath, reloadHandEdit, saveHandEdit } from '../src/lib/handEdit';
import { beginNewProjectSession } from '../src/lib/projectSession';
import { validateProject } from '../src/lib/validator';
import { useAIStore, useEditStore, useVFSStore, useWorkspaceStore } from '../src/stores';
import { nodeEnvironment } from './helpers/agentHarness';

const MANIFEST = JSON.stringify({ name: 'Club', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'] } }, null, 2);
const PAGE = '<logic src="../logic/main.logic" />\n\n<App>\n  <Text>Count: {count}</Text>\n</App>\n';

let root: Root;
let container: HTMLDivElement;
let confirmAnswer = true;
let asked: string[] = [];

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useWorkspaceStore.getState().reset();
  useAIStore.getState().resetSession();
  useEditStore.getState().close();
  useVFSStore.getState().reset();
  useVFSStore.getState().hydrateFiles([
    { path: 'manifest.json', content: MANIFEST },
    { path: 'ui/main.ui', content: PAGE },
    { path: 'logic/main.logic', content: 'let count = 0\n' },
    { path: 'builder/requirements.md', content: '# Club' },
    { path: 'assets/logo.png', content: new Uint8Array([137, 80, 78, 71]) },
  ]);
  confirmAnswer = true;
  asked = [];
  vi.stubGlobal('confirm', (message: string) => {
    asked.push(message);
    return confirmAnswer;
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const vfs = () => useVFSStore.getState();
const draft = () => useEditStore.getState().draft;
const text = (path: string) => vfs().readFile(path) as string;
const button = (name: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
const area = () => container.querySelector<HTMLTextAreaElement>('textarea');
const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? null;

/** Type into the editor as a person does: the whole new text of the box. */
function type(value: string): void {
  const box = area()!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, value);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function key(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => { area()!.dispatchEvent(event); });
  return event;
}

function open(path = 'ui/main.ui'): void {
  act(() => root.render(<CodeFile path={path} source={typeof vfs().readFile(path) === 'string' ? text(path) : null} />));
}

describe('a save by hand', () => {
  it('is one write by the person, which the history can take back and put back', () => {
    open();
    act(() => button('Edit')!.click());
    expect(area()!.getAttribute('aria-label')).toBe('Edit ui/main.ui');
    expect(document.activeElement).toBe(area());
    type(PAGE.replace('Count:', 'Total:'));
    act(() => button('Save')!.click());

    expect(text('ui/main.ui')).toContain('Total: {count}');
    expect(vfs().history.map((e) => [e.type, e.path, e.source])).toEqual([['update', 'ui/main.ui', 'user']]);
    // Not the agent's write: nothing for a run's Undo to claim.
    expect(vfs().journal).toEqual([]);
    expect(useWorkspaceStore.getState().isDirty).toBe(true);
    // The editor is gone, the source is shown again, and the keyboard is back on Edit.
    expect(area()).toBeNull();
    expect(document.activeElement).toBe(button('Edit'));
    expect(draft()).toBeNull();

    vfs().undoLast();
    expect(text('ui/main.ui')).toBe(PAGE);
    vfs().redoLast();
    expect(text('ui/main.ui')).toContain('Total: {count}');
  });

  it('shows in the History panel as one edit of that file, with Revert, and Redo after it', () => {
    beginHandEdit('ui/main.ui');
    useEditStore.getState().change(PAGE.replace('Count:', 'Total:'));
    expect(saveHandEdit()).toEqual({ ok: true, changed: true });
    act(() => root.render(<HistoryPanel />));
    const rows = [...container.querySelectorAll('li[data-history-unit]')];
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringMatching(/^Edited.*ui\/main\.ui/)]);
    act(() => rows[0].querySelector('button')!.click());
    expect(text('ui/main.ui')).toBe(PAGE);
    // Revert is not an undo that Redo follows; Undo last is.
    act(() => vfs().updateFile('ui/main.ui', PAGE.replace('Count:', 'Sum:'), 'user'));
    act(() => button('Undo last')!.click());
    expect(text('ui/main.ui')).toBe(PAGE);
    act(() => button('Redo')!.click());
    expect(text('ui/main.ui')).toContain('Sum:');
  });

  it('writes nothing, and leaves no unit in the history, when nothing was changed', () => {
    open();
    act(() => button('Edit')!.click());
    act(() => button('Save')!.click());
    expect(vfs().history).toEqual([]);
    expect(area()).toBeNull();
  });

  it('is saved by Ctrl+S, indents with Tab, and is left by Escape with the keyboard back on Edit', () => {
    open();
    act(() => button('Edit')!.click());
    area()!.setSelectionRange(0, 0);
    expect(key({ key: 'Tab' }).defaultPrevented).toBe(true);
    // Stepping back out of the box is the browser's own: the keyboard is not held in it.
    expect(key({ key: 'Tab', shiftKey: true }).defaultPrevented).toBe(false);
    type(`  ${PAGE}`);
    expect(key({ key: 's', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(text('ui/main.ui')).toBe(`  ${PAGE}`);

    act(() => button('Edit')!.click());
    expect(key({ key: 'Escape' }).defaultPrevented).toBe(true);
    expect(area()).toBeNull();
    expect(document.activeElement).toBe(button('Edit'));
    // Nothing had been typed, so there was nothing to ask about.
    expect(asked).toEqual([]);
  });
});

describe('a file that changed while it was being edited', () => {
  function editThenTheAgentWrites(): void {
    open();
    act(() => button('Edit')!.click());
    type(PAGE.replace('Count:', 'Mine:'));
    act(() => { vfs().applyTransaction([{ op: 'update', path: 'ui/main.ui', content: PAGE.replace('Count:', 'Agent:') }], 'ai', 'step-1'); });
  }

  it('is not saved over: the save is refused aloud, and the file keeps what was written to it', () => {
    editThenTheAgentWrites();
    act(() => button('Save')!.click());
    expect(text('ui/main.ui')).toContain('Agent:');
    expect(vfs().history).toHaveLength(1);
    expect(alertText()).toMatch(/ui\/main\.ui was changed while you were editing it.*Your changes were not saved/);
    // What was typed is still in the box.
    expect(area()!.value).toContain('Mine:');
  });

  it('Keep editing leaves what was typed, and the save goes on being refused', () => {
    editThenTheAgentWrites();
    act(() => button('Save')!.click());
    act(() => button('Keep editing')!.click());
    expect(alertText()).toBeNull();
    expect(area()!.value).toContain('Mine:');
    expect(document.activeElement).toBe(area());
    act(() => button('Save')!.click());
    expect(text('ui/main.ui')).toContain('Agent:');
    expect(alertText()).toMatch(/was changed while you were editing/);
  });

  it('Reload the file takes the file as it is now, and what is typed from there can be saved', () => {
    editThenTheAgentWrites();
    act(() => button('Save')!.click());
    act(() => button('Reload the file')!.click());
    expect(area()!.value).toBe(PAGE.replace('Count:', 'Agent:'));
    expect(alertText()).toBeNull();
    type(PAGE.replace('Count:', 'Agent and me:'));
    act(() => button('Save')!.click());
    expect(text('ui/main.ui')).toContain('Agent and me:');
    expect(vfs().history.map((e) => e.source)).toEqual(['ai', 'user']);
  });

  it('is refused too when the file was deleted, with nothing created in its place', () => {
    beginHandEdit('ui/main.ui');
    useEditStore.getState().change('<App />');
    vfs().deleteFile('ui/main.ui', 'ai');
    expect(saveHandEdit()).toMatchObject({ ok: false, kind: 'gone' });
    expect(vfs().files.has('ui/main.ui')).toBe(false);
    expect(reloadHandEdit()).toBe(false);
    expect(draft()?.text).toBe('<App />');
  });
});

describe('while a run is working', () => {
  it('nothing is saved: Save is disabled with the reason beside it, and what is typed is kept', () => {
    open();
    act(() => button('Edit')!.click());
    type(PAGE.replace('Count:', 'Mine:'));
    act(() => useAIStore.getState().setAgentState('building'));
    const save = button('Save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(document.getElementById(save.getAttribute('aria-describedby')!)?.textContent).toMatch(/The AI is working: save when the run stops/);
    // The box is still the person's to type in, and Ctrl+S says why it did nothing.
    type(PAGE.replace('Count:', 'Mine, still:'));
    key({ key: 's', ctrlKey: true });
    expect(text('ui/main.ui')).toBe(PAGE);
    expect(alertText()).toMatch(/The AI is working/);
    expect(saveHandEdit()).toMatchObject({ ok: false, kind: 'running' });

    act(() => useAIStore.getState().setAgentState('idle'));
    expect((button('Save') as HTMLButtonElement).disabled).toBe(false);
    expect(alertText()).toBeNull();
    expect(area()!.value).toContain('Mine, still:');
    act(() => button('Save')!.click());
    expect(text('ui/main.ui')).toContain('Mine, still:');
  });

  it('a draft open when the run began meets the same check when it ends: the run’s write is not saved over', () => {
    open();
    act(() => button('Edit')!.click());
    type(PAGE.replace('Count:', 'Mine:'));
    act(() => useAIStore.getState().setAgentState('building'));
    act(() => { vfs().applyTransaction([{ op: 'update', path: 'ui/main.ui', content: PAGE.replace('Count:', 'Agent:') }], 'ai', 'step-1'); });
    act(() => useAIStore.getState().setAgentState('idle'));
    expect(area()!.value).toContain('Mine:');
    act(() => button('Save')!.click());
    expect(text('ui/main.ui')).toContain('Agent:');
    expect(alertText()).toMatch(/was changed while you were editing/);
  });
});

describe('leaving a draft that is not saved', () => {
  it('asks first: no keeps the draft and the place, yes discards it', () => {
    beginHandEdit('ui/main.ui');
    useEditStore.getState().change('<App />');
    confirmAnswer = false;
    expect(confirmLeaveDraft()).toBe(false);
    expect(asked).toEqual([expect.stringMatching(/^ui\/main\.ui has changes you have not saved\./)]);
    expect(draft()?.text).toBe('<App />');
    confirmAnswer = true;
    expect(confirmLeaveDraft()).toBe(true);
    expect(draft()).toBeNull();
    expect(text('ui/main.ui')).toBe(PAGE);
  });

  it('does not ask about a draft with nothing typed in it, or when there is none', () => {
    expect(confirmLeaveDraft()).toBe(true);
    beginHandEdit('ui/main.ui');
    expect(confirmLeaveDraft()).toBe(true);
    expect(asked).toEqual([]);
    expect(draft()).toBeNull();
  });

  it('is asked by Cancel, and by choosing another file in the Files panel', () => {
    open();
    act(() => button('Edit')!.click());
    type('<App />');
    confirmAnswer = false;
    act(() => button('Cancel')!.click());
    expect(asked).toHaveLength(1);
    expect(area()!.value).toBe('<App />');

    useWorkspaceStore.getState().setActiveFilePath('ui/main.ui');
    act(() => root.render(<FilesPanel />));
    const other = [...container.querySelectorAll('button')].find((b) => b.getAttribute('title') === 'logic/main.logic')!;
    act(() => other.click());
    expect(asked).toHaveLength(2);
    expect(useWorkspaceStore.getState().activeFilePath).toBe('ui/main.ui');
    expect(draft()?.text).toBe('<App />');
    confirmAnswer = true;
    act(() => other.click());
    expect(useWorkspaceStore.getState().activeFilePath).toBe('logic/main.logic');
    expect(draft()).toBeNull();
  });

  // The canvas shows the entry page when no file has been chosen, and the panels judged
  // "another file" against the chosen one: choosing the very file being edited asked to
  // discard its draft, and did on yes.
  it('is not asked when the file chosen is the one being edited', () => {
    expect(useWorkspaceStore.getState().activeFilePath).toBeNull();
    beginHandEdit('ui/main.ui');
    useEditStore.getState().change('<App />');
    act(() => root.render(<FilesPanel />));
    const same = [...container.querySelectorAll('button')].find((b) => b.getAttribute('title') === 'ui/main.ui')!;
    act(() => same.click());
    expect(asked).toEqual([]);
    expect(draft()?.text).toBe('<App />');
    expect(useWorkspaceStore.getState().activeFilePath).toBe('ui/main.ui');
  });

  it('is asked before an editor is opened on another file, which would have replaced it', () => {
    beginHandEdit('ui/main.ui');
    useEditStore.getState().change('<App />');
    confirmAnswer = false;
    expect(beginHandEdit('logic/main.logic')).toMatch(/ui\/main\.ui is still being edited/);
    expect(draft()).toMatchObject({ path: 'ui/main.ui', text: '<App />' });
    // Opening the editor on the same file again changes nothing, and asks nothing.
    expect(beginHandEdit('ui/main.ui')).toBeNull();
    expect(asked).toHaveLength(1);
    expect(draft()?.text).toBe('<App />');
    confirmAnswer = true;
    expect(beginHandEdit('logic/main.logic')).toBeNull();
    expect(draft()?.path).toBe('logic/main.logic');
  });

  // The agent may delete or rename the file, or an undo take back the write that made it.
  // The canvas then shows another file, and the draft was left with no editor on the page:
  // told to copy their text out, the person had nowhere to see it.
  it('keeps its editor, with what was typed, when its file goes from the project', () => {
    beginHandEdit('ui/main.ui');
    useEditStore.getState().change('<App><Text>Mine</Text></App>');
    expect(orphanedDraftPath(vfs().files)).toBeNull();
    vfs().deleteFile('ui/main.ui', 'ai');
    expect(orphanedDraftPath(vfs().files)).toBe('ui/main.ui');
    act(() => root.render(<FileEditor path="ui/main.ui" onClose={() => {}} />));
    expect(area()!.value).toBe('<App><Text>Mine</Text></App>');
    expect(container.textContent).toContain('Editing ui/main.ui, not saved');
    act(() => button('Save')!.click());
    expect(alertText()).toMatch(/ui\/main\.ui has been deleted since you began editing it/);
    expect(area()!.value).toBe('<App><Text>Mine</Text></App>');
  });

  // Wherever the person is in Studio when they close the tab, the editor on screen or not (a
  // phone shows one panel at a time), the browser asks.
  it('is asked about by the browser when the page itself is closed or reloaded', () => {
    const leave = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(leave()).toBe(false);
    beginHandEdit('ui/main.ui');
    expect(leave()).toBe(false);
    useEditStore.getState().change('<App />');
    expect(leave()).toBe(true);
    useEditStore.getState().close();
    expect(leave()).toBe(false);
  });

  it('goes with its project: a draft does not outlast the project it was of', () => {
    beginHandEdit('ui/main.ui');
    useEditStore.getState().change('<App />');
    beginNewProjectSession();
    expect(draft()).toBeNull();
  });
});

describe('what is not edited by hand', () => {
  it('Studio’s own files and files kept as bytes have no Edit, and say why', () => {
    open('builder/requirements.md');
    expect(button('Edit')).toBeUndefined();
    expect(container.textContent).toMatch(/Studio keeps this file for itself.*shown and not edited/);
    expect(beginHandEdit('builder/requirements.md')).toMatch(/Studio keeps this file for itself/);
    expect(beginHandEdit('assets/logo.png')).toMatch(/kept as bytes \(image\/png\), not text/);
    expect(beginHandEdit('ui/missing.ui')).toMatch(/not in the project/);
    expect(draft()).toBeNull();
    expect(handEditRefusal('ui/main.ui', vfs().files.get('ui/main.ui'))).toBeNull();
  });

  it('the manifest is, but not into something that is not JSON without being told what that does', () => {
    open('manifest.json');
    act(() => button('Edit')!.click());
    type(`${MANIFEST.slice(0, -1)}`);
    act(() => button('Save')!.click());
    expect(text('manifest.json')).toBe(MANIFEST);
    expect(alertText()).toMatch(/manifest\.json would no longer be JSON \(.+\)\. The app cannot be opened, run or exported until its manifest is\./);
    act(() => button('Keep editing')!.click());
    expect(area()!.value).toBe(MANIFEST.slice(0, -1));
    act(() => button('Save')!.click());
    act(() => button('Save it as it is')!.click());
    expect(text('manifest.json')).toBe(MANIFEST.slice(0, -1));
    expect(area()).toBeNull();
  });
});

describe('what follows a save', () => {
  it('the validator judges the file as saved, as it does an agent’s write', () => {
    const errorsNow = () => validateProject(vfs().files, null).filter((e) => e.level === 'error').map((e) => e.message);
    expect(errorsNow()).toEqual([]);
    const before = vfs().files;
    beginHandEdit('manifest.json');
    useEditStore.getState().change(MANIFEST.replace('"main": "ui/main.ui"', '"main": "ui/gone.ui"'));
    expect(saveHandEdit()).toEqual({ ok: true, changed: true });
    // The file store holds a new set of files, which is what the validator, the preview and
    // the autosave each follow.
    expect(vfs().files).not.toBe(before);
    expect(errorsNow().join(' ')).toMatch(/ui\/gone\.ui/);
  });

  it('the agent’s next write to a file the person saved since it read it is refused as changed', async () => {
    const seen: SuppliedFiles = new Map();
    const ctx = { seen, env: nodeEnvironment, blueprint: null, newTransactionId: () => `t-${Math.random()}` };
    const call = (name: string, input: Record<string, unknown>) => executeTool({ id: `c-${Math.random()}`, name, input }, ctx);
    expect((await call('read_file', { path: 'ui/main.ui' })).isError).toBe(false);
    beginHandEdit('ui/main.ui');
    useEditStore.getState().change(PAGE.replace('Count:', 'Mine:'));
    saveHandEdit();
    const refused = await call('edit_file', { path: 'ui/main.ui', old_string: 'Count:', new_string: 'Agent:' });
    expect(refused.isError).toBe(true);
    expect(refused.content).toMatch(/ui\/main\.ui changed since you read it .* the person may have edited it\. Read it again before changing it\./);
    expect(text('ui/main.ui')).toContain('Mine:');
    // And it is told what to do with what it reads then.
    expect(buildAgentSystemPrompt('anthropic')).toMatch(/The person can edit files by hand between your steps\..*do not put the old text back/);
  });
});
