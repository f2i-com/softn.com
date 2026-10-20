/** @vitest-environment jsdom */
/**
 * The page Studio writes itself wears the colour it says it wears.
 *
 * The scaffold of a new app and both bundled examples gave their heading a
 * colour with `<Heading class="brand">` and a `.brand { color: … }` rule. A
 * Heading sets its own colour inline, which a class rule does not outrank
 * (and when this was written the class did not reach the element either:
 * `class` on a component was dropped, where it is now its className). The
 * heading was drawn in the theme's text colour, the rule was dead, and these
 * are the first pages the agent reads: they showed it a way of colouring that
 * its own guide says does not work. The colour is set with `style:color`,
 * which reaches the element.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { registerAllBuiltins } from '@softn/components';
import { SoftNRenderer, configureZippWasmSource } from '@softn/core';
import { EXAMPLES } from '../src/examples';
import { buildGuide } from '../src/lib/agent/guide';
import { buildPreviewXDBState, composePreviewProject } from '../src/lib/previewProject';
import { generateBlueprintFromBrief, getBundleEntryPath, scaffoldProjectFiles } from '../src/lib/studioProject';
import type { ProjectBrief, VFSFile } from '../src/types/studio';

configureZippWasmSource(readFileSync(resolve(process.cwd(), '../../packages/@softn/core/wasm-zipp/zipp_wasm_bg.wasm')));
registerAllBuiltins();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  const current = root;
  await act(async () => {
    current?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

const vfs = (entries: Array<{ path: string; content: string }>) =>
  new Map<string, VFSFile>(entries.map(({ path, content }) => [path, { path, content, mimeType: 'text/plain', lastModified: 0, lastModifiedBy: 'user', version: 1 }]));

/** The first heading of the project's main page, rendered as the preview renders it. */
async function mainHeading(files: Map<string, VFSFile>, appId: string): Promise<HTMLElement> {
  const result = composePreviewProject(files, getBundleEntryPath(files)!);
  if (!result.ok) throw new Error(result.error);
  const { composition } = result;
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <SoftNRenderer
        source={composition.source}
        python={composition.python}
        logicBasePath={composition.logicBasePath}
        importResolver={composition.importResolver}
        preIncludedLogicPaths={composition.preIncludedLogicPaths}
        initialData={buildPreviewXDBState(files).initialData}
        appId={appId}
        scriptExecutionMode="main"
        resumeSavedSyncRoom={false}
      />,
    );
  });
  // The name is state the logic holds: the heading is there before its text is.
  for (let i = 0; i < 50 && !container.querySelector('h1')?.textContent; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  const heading = container.querySelector('h1');
  if (!heading) throw new Error(`No heading rendered: ${container.textContent}`);
  return heading;
}

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

describe('the pages Studio writes', () => {
  it('draws a new app’s name in its style’s accent', async () => {
    const files = vfs(scaffoldProjectFiles(BRIEF, generateBlueprintFromBrief(BRIEF)));
    const heading = await mainHeading(files, 'scaffold-brand');
    expect(heading.textContent).toBe('Counter Club');
    expect(heading.style.color).toBe('rgb(15, 118, 110)');
  });

  it('draws the JavaScript example’s name in its brand colour', async () => {
    const example = EXAMPLES.find((e) => e.files.some((f) => /\.(logic|js)$/.test(f.path)))!;
    const heading = await mainHeading(vfs(example.files), 'example-brand');
    expect(heading.style.color).toBe('rgb(37, 99, 235)');
  });

  // What the guide tells the agent about this, and that it is so: a model that gives a
  // Heading a class and a colour rule sees a clean check and a heading that has not changed.
  it('is what the guide teaches: a class rule does not recolour a Heading, and style:color does', async () => {
    const guide = buildGuide({ python: false, torch: false, style: 'clean' });
    expect(guide).toMatch(/an inline style outranks a class rule/);
    const page = [
      '<App>',
      '  <Heading level={1} className="title">Ruled</Heading>',
      '  <Heading level={2} style:color="#2563eb">Styled</Heading>',
      '</App>',
      '',
      '<style>',
      '  .title { color: #2563eb; }',
      '</style>',
    ].join('\n');
    const files = vfs([
      { path: 'manifest.json', content: JSON.stringify({ name: 'Colours', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'] } }) },
      { path: 'ui/main.ui', content: page },
    ]);
    const ruled = await mainHeading(files, 'guide-class-rule');
    // The class is on the element, and the Heading's own inline colour is what a rule would have to beat.
    expect(ruled.className).toBe('title');
    expect(ruled.style.color).not.toBe('');
    expect(ruled.style.color).not.toBe('rgb(37, 99, 235)');
    expect(container!.querySelector('h2')!.style.color).toBe('rgb(37, 99, 235)');
  });

  // App takes theme, className and style. `title={appName}` was written on it in all three, set
  // nothing on the page and nothing on the tab (checked in Chromium), and showed the agent a prop
  // to copy that its component reference does not list.
  it('gives App no title, a prop App does not have, in the scaffold of either language or in either example', () => {
    const python = scaffoldProjectFiles({ ...BRIEF, logicLanguage: 'python' }, generateBlueprintFromBrief(BRIEF));
    const pages = [...scaffoldProjectFiles(BRIEF, generateBlueprintFromBrief(BRIEF)), ...python, ...EXAMPLES.flatMap((e) => e.files)].filter((f) => /\.(ui|html)$/.test(f.path));
    for (const page of pages) expect(page.content, page.path).not.toMatch(/<App\b[^>]*\stitle=/);
  });

  it('leaves no heading’s colour to a class rule, in the scaffold of either language or in either example', () => {
    const python = scaffoldProjectFiles({ ...BRIEF, logicLanguage: 'python' }, generateBlueprintFromBrief(BRIEF));
    const pages = [...scaffoldProjectFiles(BRIEF, generateBlueprintFromBrief(BRIEF)), ...python, ...EXAMPLES.flatMap((e) => e.files)].filter((f) => /\.(ui|html)$/.test(f.path));
    expect(pages.length).toBeGreaterThan(4);
    for (const page of pages) {
      expect(page.content, page.path).not.toMatch(/<Heading[^>]*\sclass(Name)?=/);
      expect(page.content, page.path).not.toMatch(/\.brand\b/);
    }
  });
});
