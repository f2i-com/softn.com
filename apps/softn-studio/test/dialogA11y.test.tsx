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
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('New app');
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

  // The first control in the dialog is the note field at its foot, and that is where the
  // focus went: on a phone the plan opened scrolled to its end with the keyboard up, the name
  // and the pages it was there to show out of sight above. And the plan was called "the AI
  // plan", though Studio lays it out from the brief before any AI has run.
  it('opens on its title, not in the note field at its foot, and says where the plan came from', () => {
    const blueprint: Blueprint = {
      appName: 'Notes', target: 'web', style: 'minimal',
      pages: [{ id: 'p1', name: 'Home', layout: 'stack', components: [] }],
      collections: [], navigation: { type: 'tabs', items: ['Home'] }, risks: [], assumptions: [],
    };
    const brief: ProjectBrief = { appName: 'Notes', description: 'A notes app', target: 'web', style: 'minimal', pages: ['Home'], collections: [], authNeeded: false, referenceImages: [] };
    useWorkspaceStore.setState({ blueprint, brief, taskGraph: [] });
    act(() => root.render(<BlueprintReview onApprove={() => {}} onReviseBrief={() => {}} />));
    const dialog = expectDialog();
    expect(document.activeElement?.id).toBe('blueprint-review-title');
    expect(dialog.textContent).not.toMatch(/AI plan/);
    expect(dialog.textContent).toMatch(/laid out from your brief/i);
  });

  // The title is where the dialog opens and is not one of its controls, so stepping back from
  // it is not a step the dialog's own keeping of the keyboard knows: it has to go to the last
  // control, as it does from the first, and not out to the page behind.
  it('keeps the keyboard inside when stepping back from the title it opens on', () => {
    const blueprint: Blueprint = {
      appName: 'Notes', target: 'web', style: 'minimal',
      pages: [{ id: 'p1', name: 'Home', layout: 'stack', components: [] }],
      collections: [], navigation: { type: 'tabs', items: ['Home'] }, risks: [], assumptions: [],
    };
    const brief: ProjectBrief = { appName: 'Notes', description: 'A notes app', target: 'web', style: 'minimal', pages: ['Home'], collections: [], authNeeded: false, referenceImages: [] };
    useWorkspaceStore.setState({ blueprint, brief, taskGraph: [] });
    const behind = document.createElement('button');
    behind.textContent = 'Behind the dialog';
    document.body.prepend(behind);
    act(() => root.render(<BlueprintReview onApprove={() => {}} onReviseBrief={() => {}} />));
    const dialog = expectDialog();
    const title = document.getElementById('blueprint-review-title')!;
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    act(() => { title.dispatchEvent(event); });
    const controls = [...dialog.querySelectorAll('button')];
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(controls[controls.length - 1]);
    behind.remove();
  });
});
