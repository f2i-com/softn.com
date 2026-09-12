// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { ComponentRegistry, parse, renderDocument, type SoftNRenderContext } from '@softn/core';
import { App } from '../../../../packages/@softn/components/src/layout/App';
import { ThemeProvider } from '../../../../packages/@softn/components/src/theme/ThemeProvider';
import { NewProjectDialog } from '../components/toolbar/NewProjectDialog';
import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { getComponentMeta } from './componentRegistry';
import { generateSource } from './sourceGenerator';
import { parseSource } from './sourceParser';

function renderedTheme(source: string, darkMode: boolean): string | null {
  const registry = new ComponentRegistry();
  registry.register('App', App);
  const context: SoftNRenderContext = {
    state: {}, setState: () => {}, data: {}, props: {},
    functions: {}, asyncFunctions: {}, computed: {},
  };
  const markup = renderToStaticMarkup(React.createElement(
    ThemeProvider, { darkMode } as React.ComponentProps<typeof ThemeProvider>,
    renderDocument(parse(source), context, registry),
  ));
  const container = document.createElement('div');
  container.innerHTML = markup;
  return container.querySelector('.softn-app')!.getAttribute('data-theme');
}

function expectInherited(source: string) {
  expect(renderedTheme(source, false)).toBe('light');
  expect(renderedTheme(source, true)).toBe('dark');
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  useCanvasStore.getState().reset();
  useFilesStore.getState().reset();
});

it('creates canvas and file roots whose exported app follows the preview or runtime theme', () => {
  const canvas = useCanvasStore.getState();
  expectInherited(generateSource(canvas.elements, canvas.rootId, ''));
  const files = useFilesStore.getState();
  const newFile = files.createFile('ui', 'Next.ui', 'ui');
  for (const id of ['main_ui', newFile]) {
    const file = useFilesStore.getState().uiFiles.get(id)!;
    expectInherited(generateSource(file.elements, file.rootId, ''));
  }
  const meta = getComponentMeta('App')!;
  expect(meta.defaultProps.theme).toBe('system');
  expect(meta.propSchema.find(prop => prop.name === 'theme')?.default).toBe('system');
});

it('does not invent an explicit theme for synthetic or empty parser roots', () => {
  for (const source of ['<span>Standalone component</span>', '']) {
    const parsed = parseSource(source);
    expect(parsed.elements.get(parsed.rootId)!.props.theme).toBeUndefined();
    expectInherited(generateSource(parsed.elements, parsed.rootId, ''));
  }
});

it.each(['light', 'dark'])('preserves an authored %s theme through a visual round trip', theme => {
  const parsed = parseSource(`<App theme="${theme}" />`);
  const generated = generateSource(parsed.elements, parsed.rootId, '');
  expect(generated).toContain(`theme="${theme}"`);
  expect(renderedTheme(generated, theme !== 'dark')).toBe(theme);
});

it('defaults the New App dialog to inheritance while retaining an explicit user choice', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onCreate = vi.fn();
  try {
    act(() => root.render(React.createElement(NewProjectDialog, { isOpen: true, onClose: () => {}, onCreate })));
    const select = container.querySelector('select')!;
    const form = container.querySelector('form')!;
    expect(select.value).toBe('system');
    act(() => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(onCreate).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'system' }));
    act(() => {
      select.value = 'dark';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    act(() => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(onCreate).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' }));
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
