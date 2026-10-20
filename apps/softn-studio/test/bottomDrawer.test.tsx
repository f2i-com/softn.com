/** @vitest-environment jsdom */
/**
 * The Log toggle under the canvas is named "Log". Its count was part of its
 * name ("Log4", a name a voice user cannot say and that changes with every
 * line), and nothing said whether the log was open.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BottomDrawer } from '../src/components/layout/BottomDrawer';
import { useWorkspaceStore } from '../src/stores';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useWorkspaceStore.getState().reset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the Log toggle', () => {
  it('is named Log, says how many lines it holds apart from its name, and whether it is open', () => {
    for (const line of ['one', 'two', 'three', 'four']) useWorkspaceStore.getState().addConsoleOutput(line);
    act(() => root.render(<BottomDrawer />));
    const toggle = host.querySelector('button')!;
    expect(toggle.getAttribute('aria-label')).toBe('Log');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(toggle.getAttribute('aria-describedby')!)?.textContent).toBe('4 entries');

    act(() => toggle.click());
    const region = host.querySelector<HTMLElement>('[role="region"]')!;
    expect(document.getElementById(region.getAttribute('aria-labelledby')!)?.textContent).toBe('Log');
    const minimize = host.querySelector<HTMLButtonElement>('button[title="Minimize"]')!;
    expect(minimize.getAttribute('aria-expanded')).toBe('true');
    expect(minimize.getAttribute('aria-controls')).toBe(region.id);
  });
});
