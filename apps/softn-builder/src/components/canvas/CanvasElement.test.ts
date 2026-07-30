// @vitest-environment jsdom
/**
 * Opening a bundle on the design canvas.
 *
 * The canvas previews an image whose `src` is an `{expression}` by looking the
 * variable up in the linked .logic file. That lookup used to hand each
 * declaration's right-hand side to `new Function`, so opening a .softn — which
 * anyone can send — ran the bundle author's JavaScript on the builder's own
 * origin, during render, before a single click. The builder, softn-web and
 * softn-studio are served from one origin, so that reaches every app's
 * localStorage, including the studio's provider configs and their plaintext
 * API keys.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { zipSync } from 'fflate';
import { loadBundle } from '../../utils/bundleLoader';
import { useCanvasStore } from '../../stores/canvasStore';
import { useFilesStore } from '../../stores/filesStore';
import { CanvasElement } from './CanvasElement';

// fflate decides a value is a file by `instanceof Uint8Array`, and jsdom's
// TextEncoder — which `strToU8` uses — returns one from another realm, which
// fflate then reads as a folder of single bytes.
const encode = (text: string) => Uint8Array.from(new TextEncoder().encode(text));

function manifest(): string {
  return JSON.stringify({
    name: 'Bundle',
    version: '1.0.0',
    description: '',
    main: 'ui/main.ui',
    files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'], xdb: [], assets: [] },
    config: {
      window: { title: 'Bundle', width: 800, height: 600 },
      theme: { mode: 'light' },
    },
  });
}

/** Opens a two-file bundle the way `handleOpen` does, and returns the canvas. */
async function openBundle(ui: string, logic: string) {
  const data = zipSync(
    {
      'manifest.json': encode(manifest()),
      'ui/main.ui': encode(`<logic src="../logic/main.logic" />\n${ui}`),
      'logic/main.logic': encode(logic),
    },
    { level: 6 }
  );

  const bundle = await loadBundle(data);
  useFilesStore.getState().loadFromBundle(bundle.uiFiles, bundle.logicFiles, new Map());

  const [id, mainUI] = Array.from(bundle.uiFiles.entries()).find(
    ([, file]) => file.path === 'ui/main.ui'
  )!;
  useFilesStore.getState().setActiveFile(id);
  useCanvasStore.setState({ elements: mainUI.elements, rootId: mainUI.rootId });

  return mainUI;
}

const mounted: Root[] = [];

function render(elementId: string): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push(root);
  act(() => {
    root.render(React.createElement(CanvasElement, { elementId }));
  });
  return host;
}

declare global {
  // eslint-disable-next-line no-var
  var __canvasPreviewSideEffect: string | undefined;
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.__canvasPreviewSideEffect = undefined;
  localStorage.setItem(
    'softn.studio.ai.v1',
    JSON.stringify([{ id: 'anthropic', apiKey: 'sk-ant-VICTIM-SECRET' }])
  );
  useFilesStore.getState().reset();
  useCanvasStore.getState().reset();
});

afterEach(() => {
  // Left mounted, these keep re-rendering off the next test's store resets.
  act(() => {
    while (mounted.length) mounted.pop()!.unmount();
  });
});

describe('a hostile .logic in an opened bundle', () => {
  it('does not run when the canvas renders', async () => {
    const mainUI = await openBundle(
      '<Stack>\n  <Text>hi</Text>\n</Stack>',
      `const stolen = (globalThis.__canvasPreviewSideEffect = localStorage.getItem('softn.studio.ai.v1'));`
    );

    const host = render(mainUI.rootId!);

    expect(globalThis.__canvasPreviewSideEffect).toBeUndefined();
    // The canvas still drew the bundle, so nothing was skipped by accident.
    expect(host.innerHTML).toContain('div');
  });

  // Each payload reaches the sentinel by a different route, and each one is a
  // declaration the canvas would happily have run.
  it.each([
    [
      'a call',
      `const x = Object.assign(globalThis, { __canvasPreviewSideEffect: 'ran' }).__canvasPreviewSideEffect;`,
    ],
    [
      'an immediately invoked function',
      `const x = (() => (globalThis.__canvasPreviewSideEffect = 'ran'))();`,
    ],
    [
      'the Function constructor',
      `const x = ''.constructor.constructor('globalThis.__canvasPreviewSideEffect = "ran"')();`,
    ],
    [
      'a template substitution',
      'const x = `${(globalThis.__canvasPreviewSideEffect = "ran")}`;',
    ],
  ])('leaves %s unresolved rather than evaluating it', async (_name, logic) => {
    const mainUI = await openBundle(
      '<Stack>\n  <Image src={x} />\n</Stack>',
      `${logic}\nglobalThis.__canvasPreviewSideEffect = 'top-level code never runs either';`
    );

    const image = Array.from(mainUI.elements.values()).find(
      (element) => element.componentType === 'Image'
    )!;
    const host = render(image.id);

    expect(globalThis.__canvasPreviewSideEffect).toBeUndefined();
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('Missing image source');
  });
});

describe('a string constant in an opened bundle', () => {
  it('still previews an image whose src is bound to it', async () => {
    const mainUI = await openBundle(
      '<Stack>\n  <Image src={iconUrl} />\n</Stack>',
      `let prefix = "data:image/svg+xml,"\n` +
        `let iconUrl = prefix + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg'/>")\n`
    );

    const image = Array.from(mainUI.elements.values()).find(
      (element) => element.componentType === 'Image'
    )!;
    const host = render(image.id);

    expect(host.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/svg+xml,' +
        encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg'/>")
    );
  });
});
