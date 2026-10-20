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
import { generateBlueprintFromBrief, generateTaskGraph, scaffoldProjectFiles } from '../src/lib/studioProject';
import { useVFSStore, useWorkspaceStore } from '../src/stores';
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

  // The whole sheet scrolled, with Approve as its last line: on a phone the plan of the smallest
  // brief is a screen and a half, and at 1280 by 640 the button was cut by the window's edge, so
  // the one action the dialog is for had to be found by scrolling past everything else. The
  // plan scrolls now, and the actions stay under it. (jsdom lays nothing out, so this holds the
  // structure; the positions are measured in Chromium.)
  it('keeps Approve and Revise brief outside the part that scrolls', () => {
    const blueprint: Blueprint = {
      appName: 'Notes', target: 'web', style: 'minimal',
      pages: [{ id: 'p1', name: 'Home', layout: 'stack', components: [] }],
      collections: [], navigation: { type: 'tabs', items: ['Home'] }, risks: [], assumptions: [],
    };
    const brief: ProjectBrief = { appName: 'Notes', description: 'A notes app', target: 'web', style: 'minimal', pages: ['Home'], collections: [], authNeeded: false, referenceImages: [] };
    useWorkspaceStore.setState({ blueprint, brief, taskGraph: [] });
    act(() => root.render(<BlueprintReview onApprove={() => {}} onReviseBrief={() => {}} />));
    const dialog = expectDialog();
    const scrolls = (element: HTMLElement) => /auto|scroll/.test(element.style.overflow) || /auto|scroll/.test(element.style.overflowY);
    // The sheet is as tall as the window allows and does not scroll itself.
    expect(scrolls(dialog)).toBe(false);
    expect(dialog.style.display).toBe('flex');
    expect(dialog.style.flexDirection).toBe('column');
    const body = [...dialog.children].find((child) => scrolls(child as HTMLElement)) as HTMLElement | undefined;
    expect(body, 'a part of the sheet that scrolls').toBeDefined();
    // A flex child that may shrink below its content, or it would push the actions out instead.
    expect(parseFloat(body!.style.minHeight)).toBe(0);
    // What scrolls is the plan: its title, its pages and the note field.
    expect(body!.contains(document.getElementById('blueprint-review-title'))).toBe(true);
    expect(body!.contains(document.getElementById('blueprint-revision-note'))).toBe(true);
    for (const name of ['Approve blueprint', 'Revise brief']) {
      const button = [...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
      expect(button, name).toBeDefined();
      expect(body!.contains(button!), `${name} scrolls away with the plan`).toBe(false);
      // Nothing between the button and the sheet scrolls or shrinks it out of view.
      expect(button!.parentElement!.parentElement).toBe(dialog);
      expect(button!.parentElement!.style.flexShrink).toBe('0');
    }
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

  // Enter also confirms an input method's candidate: the note field took it as "add the note"
  // and added the half-typed text to the plan, emptying the field under the input method.
  it.each([{ isComposing: true }, { keyCode: 229 }])('adds a note on Enter, not on the Enter that confirms a candidate (%j)', (composing) => {
    const blueprint: Blueprint = {
      appName: 'Notes', target: 'web', style: 'minimal',
      pages: [{ id: 'p1', name: 'Home', layout: 'stack', components: [] }],
      collections: [], navigation: { type: 'tabs', items: ['Home'] }, risks: [], assumptions: [],
    };
    const brief: ProjectBrief = { appName: 'Notes', description: 'A notes app', target: 'web', style: 'minimal', pages: ['Home'], collections: [], authNeeded: false, referenceImages: [] };
    useWorkspaceStore.setState({ blueprint, brief, taskGraph: [] });
    act(() => root.render(<BlueprintReview onApprove={() => {}} onReviseBrief={() => {}} />));
    const input = document.getElementById('blueprint-revision-note') as HTMLInputElement;
    const type = (value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      act(() => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
    };
    type('ログイン');
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...composing })); });
    expect(useWorkspaceStore.getState().blueprint?.assumptions).toEqual([]);
    expect(input.value).toBe('ログイン');
    type('ログインを追加');
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    expect(useWorkspaceStore.getState().blueprint?.assumptions).toEqual(['Revision note: ログインを追加']);
    expect(input.value).toBe('');
  });

  /** The plan Generate makes for `pages`, with its scaffold in the project, as the wizard leaves it. */
  function generated(pages: string[]) {
    const brief: ProjectBrief = { appName: 'Notes', description: 'A notes app', target: 'web', style: 'clean', pages, collections: [], authNeeded: false, referenceImages: [], logicLanguage: 'javascript' };
    const blueprint = generateBlueprintFromBrief(brief);
    useVFSStore.getState().reset();
    useVFSStore.getState().hydrateFiles(scaffoldProjectFiles(brief, blueprint));
    useWorkspaceStore.setState({ blueprint, brief, taskGraph: generateTaskGraph(blueprint), blueprintApproved: false });
  }

  function note(text: string) {
    const input = document.getElementById('blueprint-revision-note') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setter.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
  }

  const stat = (label: string) => [...host.querySelectorAll('strong')].find((s) => s.previousElementSibling?.textContent === label)?.textContent;

  // "Add a settings page" was filed under Risks as "User requested revision", and the plan
  // still said one page. It adds the page: to the plan, to the brief the build is asked for,
  // and, while the project is the scaffold Generate wrote, to its files.
  it('adds the page a note asks for, to the plan, the brief and the scaffold', () => {
    generated(['Home']);
    act(() => root.render(<BlueprintReview onApprove={() => {}} onReviseBrief={() => {}} />));
    expect(stat('Pages')).toBe('1');
    note('Add a settings page');
    const { blueprint, brief } = useWorkspaceStore.getState();
    expect(blueprint!.pages.map((p) => p.name)).toEqual(['Home', 'Settings']);
    expect(brief!.pages).toEqual(['Home', 'Settings']);
    expect(blueprint!.risks.join(' ')).not.toMatch(/settings/i);
    expect(stat('Pages')).toBe('2');
    expect(useVFSStore.getState().readFile('pages/settings.html')).toContain('Settings');
    expect(String(useVFSStore.getState().readFile('index.html'))).toContain('./pages/settings.html');
    // A page that names none is the next numbered one; one the plan has is not added twice.
    note('add another page');
    expect(useWorkspaceStore.getState().blueprint!.pages.map((p) => p.name)).toEqual(['Home', 'Settings', 'Page 3']);
    note('Add a Settings page');
    expect(useWorkspaceStore.getState().blueprint!.pages).toHaveLength(3);
    // Anything else is a note for the build, with the assumptions.
    note('The home page lists notes newest first');
    expect(useWorkspaceStore.getState().blueprint!.assumptions.at(-1)).toBe('Revision note: The home page lists notes newest first');
    expect(useWorkspaceStore.getState().blueprint!.pages).toHaveLength(3);
  });

  it('leaves the files alone once they are not the scaffold Generate wrote', () => {
    generated(['Home']);
    useVFSStore.getState().updateFile('pages/home.html', '<Text>Mine</Text>', 'user');
    act(() => root.render(<BlueprintReview onApprove={() => {}} onReviseBrief={() => {}} />));
    note('Add an about page');
    expect(useWorkspaceStore.getState().blueprint!.pages.map((p) => p.name)).toEqual(['Home', 'About']);
    expect(useVFSStore.getState().readFile('pages/about.html')).toBeNull();
    expect(useVFSStore.getState().readFile('pages/home.html')).toBe('<Text>Mine</Text>');
  });

  // Each page row read "/ / responsive-shell": the first page's route, then the layout's
  // identifier, with a slash between that looked like a third path.
  it('says each page’s file and its layout in words', () => {
    generated(['Home', 'Team stats']);
    act(() => root.render(<BlueprintReview onApprove={() => {}} onReviseBrief={() => {}} />));
    const text = expectDialog().textContent ?? '';
    expect(text).toContain('pages/home.html · responsive shell layout');
    expect(text).toContain('pages/team-stats.html · responsive shell layout');
    expect(text).not.toContain('/ / ');
  });

  // The dialog gives the focus back to what opened it: the wizard's Generate, gone by then, so
  // the focus fell to the page. It goes to the editor's main area.
  it('puts the keyboard in the editor once the plan is approved', async () => {
    generated(['Home']);
    function Editor() {
      const approved = useWorkspaceStore((s) => s.blueprintApproved);
      return (
        <>
          <main id="studio-main" tabIndex={-1}>Editor</main>
          {!approved && <BlueprintReview onApprove={() => {}} onReviseBrief={() => {}} />}
        </>
      );
    }
    act(() => root.render(<Editor />));
    const approve = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Approve blueprint')!;
    act(() => { approve.focus(); approve.click(); });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(document.activeElement?.id).toBe('studio-main');
  });
});
