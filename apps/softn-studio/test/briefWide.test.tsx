/** @vitest-environment jsdom */
/**
 * The brief in a wide window is one page.
 *
 * Its three steps were each a card 620px wide in the middle of the screen,
 * whatever the screen: on a desktop the last step was one row of five
 * swatches with the rest of the window empty, and two presses of Next stood
 * between a description and Generate. From 1100px the three parts are shown
 * together, side by side, with no steps: the way back leaves, and the button
 * generates. Under that width the steps are as they were (briefWizard.test.tsx,
 * which runs at jsdom's 1024).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BriefWizard } from '../src/components/brief/BriefWizard';
import { useAIStore, useVFSStore, useWorkspaceStore } from '../src/stores';

let root: Root;
let host: HTMLDivElement;
const narrow = window.innerWidth;

function setWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
  useWorkspaceStore.getState().reset();
  useVFSStore.getState().reset();
  useAIStore.getState().resetSession();
  setWidth(1440);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setWidth(narrow);
});

const button = (name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);

function type(selector: string, value: string): void {
  const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  act(() => { setter.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
}

describe('the brief in a wide window', () => {
  it('shows its three parts together, with no steps and the keyboard in the app name', () => {
    act(() => root.render(<BriefWizard onBack={() => {}} onSubmit={() => {}} />));
    expect(host.querySelector('#brief-app-name')).not.toBeNull();
    expect(host.querySelector('#brief-pages')).not.toBeNull();
    expect(host.querySelector('[aria-labelledby="brief-style-label"]')).not.toBeNull();
    expect(host.querySelector('[aria-current="step"]')).toBeNull();
    expect(button('Next')).toBeUndefined();
    expect(button('Generate')).toBeDefined();
    expect(document.activeElement?.id).toBe('brief-app-name');
  });

  it('generates from the one page, with a page name left in its field', () => {
    const onSubmit = vi.fn();
    act(() => root.render(<BriefWizard onBack={() => {}} onSubmit={onSubmit} />));
    expect(button('Generate')!.disabled).toBe(true);
    type('#brief-app-name', 'Tea Log');
    type('#brief-description', 'A log of the teas I drink.');
    type('#brief-pages', 'Teas, Add a tea');
    act(() => button('Generate')!.click());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(useWorkspaceStore.getState().brief?.pages).toEqual(['Teas', 'Add a tea']);
    expect(useWorkspaceStore.getState().blueprint?.pages.map((page) => page.name)).toEqual(['Teas', 'Add A Tea']);
  });

  it('leaves by its one way back, which is Cancel', () => {
    const onBack = vi.fn();
    act(() => root.render(<BriefWizard onBack={onBack} onSubmit={() => {}} />));
    expect(button('Back')).toBeUndefined();
    act(() => button('Cancel')!.click());
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('becomes the three steps when the window is made narrow, keeping what was typed', () => {
    act(() => root.render(<BriefWizard onBack={() => {}} onSubmit={() => {}} />));
    type('#brief-app-name', 'Tea Log');
    act(() => { setWidth(900); window.dispatchEvent(new Event('resize')); });
    expect(host.querySelector('[aria-current="step"]')?.textContent).toContain('Basics');
    expect(host.querySelector('#brief-pages')).toBeNull();
    expect(host.querySelector<HTMLInputElement>('#brief-app-name')!.value).toBe('Tea Log');
    expect(button('Next')).toBeDefined();
  });
});
