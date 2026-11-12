/** @vitest-environment jsdom */
/**
 * The home page shows the work first.
 *
 * It opened on a headline and a paragraph that filled a laptop's first
 * screen, with "Recent projects" under them, below the fold; on a phone the
 * person's projects came after both examples (they were moved first by
 * `order` on a flex parent that a wrapper had since come between). The page
 * is one line of what Studio is for and the two ways to start, then the
 * projects, then the examples, in that order in the page itself, so one
 * column reads the same way. (The widths and the fold are measured in
 * Chromium.)
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Dashboard, type RecentEntry } from '../src/components/layout/Dashboard';

const entries: RecentEntry[] = [
  { id: 'a', name: 'Alpha', target: 'web', lastModified: 'today', saved: true, active: false },
];

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const draw = (recentProjects: RecentEntry[]) => act(() => root.render(
  <Dashboard onNewProject={() => {}} onOpenExample={() => {}} recentProjects={recentProjects} />,
));

/** Whether `first` comes before `second` in the page. */
const before = (first: Element, second: Element) => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('the home page', () => {
  it('has the two ways to start, then the person’s projects, then the examples', () => {
    draw(entries);
    const start = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Start a new app')!;
    const recent = container.querySelector('#studio-recent-heading')!;
    const examples = container.querySelector('#studio-examples-heading')!;
    expect(before(start, recent)).toBe(true);
    expect(before(recent, examples)).toBe(true);
    // The projects and the examples are the two parts of one grid, in the order they are read.
    const grid = recent.closest('.st-home-grid')!;
    expect([...grid.children].map((child) => child.getAttribute('aria-labelledby'))).toEqual(['studio-recent-heading', 'studio-examples-heading']);
  });

  it('is one heading and no introduction for a person who has projects', () => {
    draw(entries);
    expect([...container.querySelectorAll('h1')].map((h) => h.textContent)).toEqual(['Describe an app. Studio builds it.']);
    expect(container.querySelector('.st-home-lede')).toBeNull();
    expect(container.textContent).not.toMatch(/How Studio works/);
  });

  it('says what Studio does, in a sentence, to a person who has made nothing yet', () => {
    draw([]);
    expect(container.querySelector('.st-home-lede')?.textContent).toMatch(/Say what the app is for\..*\.softn bundle you can run or publish\./s);
    expect(container.textContent).toContain('Nothing here yet');
  });

  it('still says which files Import takes where its line of text is not drawn', () => {
    draw(entries);
    const importButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Import a bundle')!;
    expect(importButton.title).toMatch(/\.softn bundle, a \.zip archive or a \.json project file/);
  });
});
