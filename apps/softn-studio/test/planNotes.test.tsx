/** @vitest-environment jsdom */
/**
 * A note about sign-in, taken back, takes its line with it.
 *
 * A note on the plan that speaks of signing in adds "Review authentication
 * flow requirements before export." to the plan's assumptions. Removing the
 * note left that line where it was: a plan that no longer said anything about
 * signing in still told the person to review how it is done. The line stays
 * for as long as a note about sign-in does, and goes with the last of them.
 *
 * It was also added only for the word "auth", which is not what a person
 * writes: "people sign in with a link" brought no line at all.
 *
 * And the plan opens on its pages: the three tiles of counts above them are
 * gone, each count beside its section's name instead.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlueprintReview, SIGN_IN_REVIEW_LINE } from '../src/components/blueprint/BlueprintReview';
import { generateBlueprintFromBrief, generateTaskGraph, revisionNotes, scaffoldProjectFiles } from '../src/lib/studioProject';
import { onPreviewRestart } from '../src/lib/previewRestart';
import { useAIStore, useVFSStore, useWorkspaceStore } from '../src/stores';
import type { ProjectBrief } from '../src/types/studio';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useWorkspaceStore.getState().reset();
  useVFSStore.getState().reset();
  useAIStore.getState().resetSession();
  const brief: ProjectBrief = { appName: 'Notes', description: 'A notes app', target: 'web', style: 'clean', pages: ['Home', 'Archive'], collections: ['Notes'], authNeeded: false, referenceImages: [], logicLanguage: 'javascript' };
  const blueprint = generateBlueprintFromBrief(brief);
  useVFSStore.getState().hydrateFiles(scaffoldProjectFiles(brief, blueprint));
  useWorkspaceStore.setState({ blueprint, brief, taskGraph: generateTaskGraph(blueprint), blueprintApproved: false });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<BlueprintReview onApprove={() => {}} onReviseBrief={() => {}} />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function note(text: string): void {
  const input = document.getElementById('blueprint-revision-note') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => { setter.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
  act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
}

function remove(text: string): void {
  act(() => host.querySelector<HTMLButtonElement>(`button[aria-label="Remove the note: ${text}"]`)!.click());
}

const assumptions = () => useWorkspaceStore.getState().blueprint!.assumptions;

describe('a note about sign-in on the plan', () => {
  it('brings the line about reviewing it, by the words a person uses, and takes it away when removed', () => {
    const before = assumptions();
    note('People sign in with a link sent by email');
    expect(assumptions()).toContain(SIGN_IN_REVIEW_LINE);
    expect(host.textContent).toContain(SIGN_IN_REVIEW_LINE);
    remove('People sign in with a link sent by email');
    expect(assumptions()).toEqual(before);
    expect(host.textContent).not.toContain(SIGN_IN_REVIEW_LINE);
  });

  it('keeps the line while another note still speaks of signing in, and says it once', () => {
    note('Tighten auth');
    note('The login page has no password field');
    note('Use big buttons');
    expect(assumptions().filter((line) => line === SIGN_IN_REVIEW_LINE)).toHaveLength(1);
    remove('Tighten auth');
    expect(assumptions()).toContain(SIGN_IN_REVIEW_LINE);
    remove('The login page has no password field');
    expect(assumptions()).not.toContain(SIGN_IN_REVIEW_LINE);
    expect(revisionNotes(useWorkspaceStore.getState().blueprint)).toEqual(['Use big buttons']);
  });

  it('adds no such line for a note about something else', () => {
    note('The home page lists notes newest first');
    expect(assumptions()).not.toContain(SIGN_IN_REVIEW_LINE);
  });
});

// "Remove the archive page" was kept as a note while the plan went on listing the page, and a
// line naming two pages made one page with the sentence as its name. What a line did was said
// only in the log, behind the dialog.
describe('a line that asks for pages to be added or removed', () => {
  const pages = () => useWorkspaceStore.getState().blueprint!.pages.map((page) => page.name);
  const said = () => document.getElementById('blueprint-revision-said')!.textContent;
  const field = () => (document.getElementById('blueprint-revision-note') as HTMLInputElement).value;

  it('removes the page from the plan, the brief and the scaffold, and says so', () => {
    expect(useVFSStore.getState().files.has('pages/archive.html')).toBe(true);
    note('Remove the archive page');
    expect(pages()).toEqual(['Home']);
    expect(useWorkspaceStore.getState().brief!.pages).toEqual(['Home']);
    expect(revisionNotes(useWorkspaceStore.getState().blueprint)).toEqual([]);
    expect(useVFSStore.getState().files.has('pages/archive.html')).toBe(false);
    expect(String(useVFSStore.getState().readFile('index.html'))).not.toContain('archive');
    expect(said()).toBe('Removed the page Archive. The plan has 1 page.');
    expect(document.getElementById('blueprint-revision-said')!.getAttribute('role')).toBe('status');
    expect(field()).toBe('');
    expect([...host.querySelectorAll('strong')].map((strong) => strong.textContent)[0]).toBe('1');
  });

  it('keeps the plan’s last page, says why, and leaves the line in the field', () => {
    note('Remove the home and archive pages');
    expect(pages()).toEqual(['Home', 'Archive']);
    expect(said()).toBe('A plan needs at least one page, so Home and Archive stay. Add the page you want first.');
    expect(field()).toBe('Remove the home and archive pages');
  });

  it('adds every page a line names, and says which the plan already had', () => {
    note('Add a page for tags and a page for the trash');
    expect(pages()).toEqual(['Home', 'Archive', 'Tags', 'Trash']);
    expect(said()).toBe('Added 2 pages: Tags and Trash. The plan has 4 pages.');
    note('Add a tags page and a search page');
    expect(pages()).toEqual(['Home', 'Archive', 'Tags', 'Trash', 'Search']);
    expect(said()).toBe('Added the page Search. The plan already has a page called Tags. The plan has 5 pages.');
    expect(useVFSStore.getState().files.has('pages/search.html')).toBe(true);
    note('Add a page for the archive');
    expect(said()).toBe('The plan already has a page called Archive.');
    expect(pages()).toHaveLength(5);
  });

  it('leaves files the person or the AI has changed as they are, and still changes the plan', () => {
    let restarts = 0;
    const stop = onPreviewRestart(() => { restarts++; });
    useVFSStore.getState().updateFile('pages/archive.html', '<p>Mine</p>');
    note('Remove the archive page');
    stop();
    expect(pages()).toEqual(['Home']);
    expect(useVFSStore.getState().readFile('pages/archive.html')).toBe('<p>Mine</p>');
    expect(restarts).toBe(0);
  });

  // The app on the canvas behind the dialog keeps its state across an edit. With the scaffold
  // written again under it, its nav went on listing the pages it had started with (one, of a
  // plan that now had three) until Refresh preview was pressed.
  it('starts the preview again when it writes the scaffold again', () => {
    let restarts = 0;
    const stop = onPreviewRestart(() => { restarts++; });
    note('Add a tags page');
    note('Use big buttons');
    note('Remove the tags page');
    stop();
    expect(restarts).toBe(2);
    note('Add a tags page');
    expect(restarts).toBe(2);
  });

  it('says of a note that it is one, and that it changes nothing in the plan', () => {
    note('Remove the delete button from the home page');
    expect(pages()).toEqual(['Home', 'Archive']);
    expect(revisionNotes(useWorkspaceStore.getState().blueprint)).toEqual(['Remove the delete button from the home page']);
    expect(said()).toBe('Kept as a note. The plan above is as it was: the AI reads your notes when it builds.');
    expect(document.getElementById('blueprint-revision-hint')!.textContent).toMatch(/add or remove pages.*changes nothing above/i);
  });
});

describe('the plan’s counts', () => {
  it('are beside the names of the sections they count, and nothing counts Studio’s own tasks', () => {
    const counts = [...host.querySelectorAll('strong')].map((strong) => `${strong.previousElementSibling?.textContent}: ${strong.textContent}`);
    expect(counts).toEqual(['Pages: 2', 'Data model: 1']);
    expect(host.querySelector('[role="dialog"]')!.textContent).not.toMatch(/Tasks/);
  });
});
