/** @vitest-environment jsdom */
/**
 * The brief wizard: where the keyboard starts, and what its scaffold is to
 * the project's history.
 *
 * The wizard asked for the first text field by a selector the app name did
 * not match (its input has no `type` attribute), so the keyboard began in the
 * description and a person typed the name of their app into it.
 *
 * The scaffold was recorded as an AI turn. The History panel then listed the
 * whole new project as "AI turn · 14 files", and Revert AI changes, pressed
 * to take back what a run had written, went on to take back the scaffold
 * too: every file, the manifest and the plan with them, and nothing in
 * Studio to put them back. The scaffold is where the project starts, as a
 * restored project's files are, so nothing is recorded for it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BriefWizard } from '../src/components/brief/BriefWizard';
import { useAIStore, useVFSStore, useWorkspaceStore } from '../src/stores';
import type { ProjectBrief } from '../src/types/studio';

let root: Root;
let host: HTMLDivElement;

const BRIEF: ProjectBrief = {
  appName: 'Counter Club',
  description: 'A counter with a button that adds one.',
  target: 'web',
  pages: [],
  collections: [],
  authNeeded: false,
  style: 'clean',
  logicLanguage: 'javascript',
  referenceImages: [],
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom lays nothing out and has no Element.scrollTo; the wizard scrolls to the top on each step.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
  useWorkspaceStore.getState().reset();
  useVFSStore.getState().reset();
  useAIStore.getState().resetSession();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const button = (name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!;

describe('the brief wizard', () => {
  it('opens with the keyboard in the app name, the first thing it asks for', () => {
    act(() => root.render(<BriefWizard onBack={() => {}} onSubmit={() => {}} />));
    expect(document.activeElement?.id).toBe('brief-app-name');
  });

  it('scaffolds the project as its starting point, so undoing the AI can never take the project away', () => {
    useWorkspaceStore.setState({ brief: BRIEF });
    act(() => root.render(<BriefWizard onBack={() => {}} onSubmit={() => {}} />));
    act(() => button('Next').click());
    act(() => button('Next').click());
    act(() => button('Generate').click());

    const scaffolded = [...useVFSStore.getState().files.keys()].sort();
    expect(scaffolded).toContain('manifest.json');
    expect(scaffolded).toContain('index.html');
    // Nothing happened yet in this project: there is nothing to undo, and no AI turn to revert.
    expect(useVFSStore.getState().history).toEqual([]);
    expect(useVFSStore.getState().journal).toEqual([]);

    // A run writes a file; taking back everything the AI did leaves the scaffold.
    useVFSStore.getState().applyTransaction([{ op: 'update', path: 'index.html', content: '<App />' }], 'ai', 'run-step-1');
    useVFSStore.getState().revertAIChanges();
    expect([...useVFSStore.getState().files.keys()].sort()).toEqual(scaffolded);
    expect(useVFSStore.getState().readFile('index.html')).not.toBe('<App />');
  });

  // Enter also confirms a candidate in an input method (Japanese, Chinese, Korean). The page and
  // collection fields took that Enter as "add": a name half typed became a page, and the field
  // was emptied under the input method. The chat and the file editor already let it pass.
  it.each([{ isComposing: true }, { keyCode: 229 }])('adds a page or a collection on Enter, not on the Enter that confirms a candidate (%j)', (composing) => {
    useWorkspaceStore.setState({ brief: BRIEF });
    act(() => root.render(<BriefWizard onBack={() => {}} onSubmit={() => {}} />));
    for (let i = 0; i < 3 && !host.querySelector('#brief-pages'); i++) act(() => button('Next').click());
    for (const [id, kind] of [['brief-pages', 'page'], ['brief-collections', 'collection']] as const) {
      const input = host.querySelector<HTMLInputElement>(`#${id}`)!;
      const type = (value: string) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        act(() => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
      };
      const added = () => [...host.querySelectorAll(`button[aria-label^="Remove ${kind} "]`)].map((b) => b.getAttribute('aria-label')!.slice(`Remove ${kind} `.length));
      type('予約');
      act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...composing })));
      expect(added(), kind).toEqual([]);
      expect(input.value).toBe('予約');
      type('予約一覧');
      act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
      expect(added(), kind).toEqual(['予約一覧']);
      expect(input.value).toBe('');
    }
  });
});
