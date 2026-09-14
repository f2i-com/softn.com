/** @vitest-environment jsdom */
/**
 * Studio's full-screen overlays are dialogs: announced as such, labelled by
 * their title, modal, and they own the keyboard while they are up — Tab
 * stays inside and Escape is the way back. Builder's dialogs had this;
 * Studio's did not, so a screen reader heard nothing open and focus was
 * free to wander under the wizard.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BriefWizard } from '../src/components/brief/BriefWizard';
import { BlueprintReview } from '../src/components/blueprint/BlueprintReview';
import { useWorkspaceStore } from '../src/stores';
import type { Blueprint, ProjectBrief } from '../src/types/studio';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom lays nothing out and has no Element.scrollTo; the wizard scrolls to the top on each step.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function escape() {
  act(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
}

function expectDialog(): HTMLElement {
  const dialog = host.querySelector<HTMLElement>('[role="dialog"]');
  expect(dialog).not.toBeNull();
  expect(dialog!.getAttribute('aria-modal')).toBe('true');
  const label = document.getElementById(dialog!.getAttribute('aria-labelledby') ?? '');
  expect(label?.textContent?.trim()).toBeTruthy();
  expect(dialog!.contains(document.activeElement)).toBe(true);
  return dialog!;
}

describe('BriefWizard', () => {
  it('is a labelled modal dialog that Escape leaves', () => {
    const onBack = vi.fn();
    act(() => root.render(<BriefWizard onBack={onBack} onSubmit={() => {}} />));
    const dialog = expectDialog();
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('New App');
    escape();
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('BlueprintReview', () => {
  it('is a labelled modal dialog; Escape is "Revise brief"', () => {
    const blueprint: Blueprint = {
      appName: 'Notes', target: 'web', style: 'minimal',
      pages: [{ id: 'p1', name: 'Home', layout: 'stack', components: [] }],
      collections: [], navigation: { type: 'tabs', items: ['Home'] }, risks: [], assumptions: [],
    };
    const brief: ProjectBrief = { appName: 'Notes', description: 'A notes app', target: 'web', style: 'minimal', pages: ['Home'], collections: [], authNeeded: false, referenceImages: [] };
    useWorkspaceStore.setState({ blueprint, brief, taskGraph: [] });
    const onReviseBrief = vi.fn();
    act(() => root.render(<BlueprintReview onApprove={() => {}} onReviseBrief={onReviseBrief} />));
    const dialog = expectDialog();
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Notes');
    escape();
    expect(onReviseBrief).toHaveBeenCalledTimes(1);
  });
});
