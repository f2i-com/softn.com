/** @vitest-environment jsdom */
/**
 * The run timeline in the chat, driven by a real run against a scripted
 * provider: the plan, a row per step that opens to its diff or check, the
 * question box for ask_user answered from the timeline, Stop / Continue,
 * per-step Undo and Revert run — each reachable by keyboard and labelled.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AIChat } from '../src/components/ai/AIChat';
import { startAgentRun } from '../src/lib/agent/runAgent';
import { useVFSStore } from '../src/stores/vfsStore';
import { useAIStore } from '../src/stores/aiStore';
import { APP, assertScriptsPassed, fakeProvider, lastRun, resetAgent, resultsIn, say, seedApp } from './helpers/agentHarness';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetAgent();
  seedApp();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<AIChat />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  assertScriptsPassed();
  resetAgent();
});

const buttons = (label: string | RegExp) =>
  [...container.querySelectorAll('button')].filter((b) => (typeof label === 'string' ? b.textContent?.trim() === label : label.test(b.textContent ?? '')));

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe('a saved run record that cannot be read', () => {
  it('is shown as a note instead of taking the chat down', () => {
    act(() => {
      useAIStore.getState().addMessage({ id: 'broken', role: 'assistant', content: 'Built part of it.', timestamp: 1, run: { id: 'x', status: 'finished' } as never });
    });
    expect(container.querySelector('section.st-run')).toBeNull();
    expect(container.textContent).toContain('Built part of it.');
  });
});

describe('the run timeline', () => {
  it('shows the plan, each step, the diff of an edit, the question box, and the finished summary', async () => {
    fakeProvider('anthropic', [
      { text: 'Starting.', calls: [{ name: 'update_plan', input: { items: [{ text: 'Rename the heading', status: 'active' }, { text: 'Check it', status: 'pending' }] } }, { name: 'read_file', input: { path: 'ui/main.ui' } }] },
      { calls: [{ name: 'edit_file', input: { path: 'ui/main.ui', old_string: '<Heading level={1}>Tasks</Heading>', new_string: '<Heading level={1}>Chores</Heading>' } }] },
      { calls: [{ name: 'ask_user', input: { question: 'Should the counter start at one?' } }] },
      (body) => {
        expect(resultsIn(body)).toContain('The person answered: Yes please');
        return { calls: [{ name: 'update_plan', input: { items: [{ text: 'Rename the heading', status: 'done' }, { text: 'Check it', status: 'done' }] } }, { name: 'finish', input: { summary: 'Renamed the heading to Chores.' } }] };
      },
    ]);
    say('Rename the heading');
    await act(async () => { await startAgentRun(); });
    await flush();

    const run = container.querySelector('section.st-run')!;
    expect(run.getAttribute('aria-label')).toBe('Agent run');
    expect(run.querySelector('.st-run-state')?.textContent).toBe('Waiting for you');
    expect(run.querySelector('[role="status"]')?.textContent).toMatch(/waiting for you/i);
    expect(run.querySelector('.st-run-plan')?.textContent).toContain('Rename the heading');
    expect(run.querySelector('.st-run-text')?.textContent).toBe('Starting.');

    // The edit row opens to its diff.
    const edit = [...run.querySelectorAll<HTMLButtonElement>('.st-run-toggle')].find((b) => b.textContent?.startsWith('Edited'))!;
    expect(edit.textContent).toContain('ui/main.ui');
    expect(edit.getAttribute('aria-expanded')).toBe('false');
    act(() => edit.click());
    expect(edit.getAttribute('aria-expanded')).toBe('true');
    const diff = run.querySelector(`#${edit.getAttribute('aria-controls')}`)!;
    expect(diff.querySelector('[data-kind="del"]')?.textContent).toContain('Tasks</Heading>');
    expect(diff.querySelector('[data-kind="add"]')?.textContent).toContain('Chores</Heading>');
    // The automatic check after it passed.
    expect([...run.querySelectorAll('.st-run-verb')].some((v) => v.textContent === 'Automatic check')).toBe(true);

    // The question, answered from the timeline.
    const box = run.querySelector<HTMLTextAreaElement>('.st-run-ask textarea')!;
    expect(container.querySelector(`label[for="${box.id}"]`)?.textContent).toBe('Should the counter start at one?');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'Yes please');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { buttons('Send answer')[0].click(); });
    await flush();

    expect(container.querySelector('.st-run-state')?.textContent).toBe('Finished');
    expect(container.querySelector('.st-run-summary')?.textContent).toContain('Renamed the heading to Chores.');
    expect(container.querySelector('.st-run-plan-count')?.textContent).toBe('2/2');
    expect(buttons(/Revert run/)).toHaveLength(1);
    // Undo on the edit step puts the file back.
    const undo = container.querySelector<HTMLButtonElement>('[aria-label^="Undo: Edited ui/main.ui"]')!;
    act(() => undo.click());
    expect(useVFSStore.getState().readFile('ui/main.ui')).toBe(APP.ui);
    expect(container.textContent).toContain('undone');
  });

  it('offers Stop while running and Continue once stopped; the composer answers a waiting question', async () => {
    const provider = fakeProvider('anthropic', [
      { calls: [{ name: 'list_files', input: {} }] },
      { calls: [{ name: 'ask_user', input: { question: 'Which page?' } }] },
      (body) => {
        expect(resultsIn(body)).toContain('The person answered: The home page');
        return { calls: [{ name: 'finish', input: { summary: 'ok' } }] };
      },
    ]);
    say('Go');
    const gate = provider.hold();
    let running!: Promise<void>;
    await act(async () => { running = startAgentRun(); });
    await flush();
    expect(container.querySelector('.st-run-state .st-live')?.textContent).toBe('Building');
    act(() => buttons(/Stop/)[0].click());
    gate.release();
    await act(async () => { await running; });
    expect(container.querySelector('.st-run-state')?.textContent).toBe('Stopped');

    await act(async () => { buttons(/Continue/)[0].click(); });
    await flush();
    expect(lastRun().run.status).toBe('waiting');
    // The chat's own input answers the question.
    const input = container.querySelector<HTMLTextAreaElement>('[aria-label="Message to AI"]')!;
    expect(input.placeholder).toBe('Answer the question above…');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'The home page');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await flush();
    expect(lastRun().run.status).toBe('finished');
  });
});
