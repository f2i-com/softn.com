// @vitest-environment jsdom
/**
 * The project's theme can be set, and the panel says which theme a page is
 * drawn in when the page and the project say different things.
 *
 * `setThemeMode` was called from nowhere: a project was light unless the
 * bundle it was opened from said otherwise, and the only way to see an app
 * dark was to write `theme="dark"` on its page. The setting is among the
 * page's properties, beside the page's own `theme`, because which of the two
 * wins is a question about both; and it is offered with nothing selected,
 * where the panel is otherwise empty, because it belongs to the project.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSource } from '../../utils/sourceParser';
import { themeSentence } from '../../utils/drawnTheme';
import { useCanvasStore } from '../../stores/canvasStore';
import { useFilesStore } from '../../stores/filesStore';
import { useProjectStore } from '../../stores/projectStore';
import { PropertyPanel } from './PropertyPanel';

let root: Root | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  useCanvasStore.getState().reset();
  useFilesStore.getState().reset();
  useProjectStore.getState().reset();
  window.localStorage.removeItem('softn-theme-preference');
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

function mount(source: string, select: 'page' | 'nothing' | string = 'page'): void {
  const parsed = parseSource(source);
  useCanvasStore.getState().loadState(parsed.elements, parsed.rootId);
  if (select === 'page') useCanvasStore.getState().selectElement(parsed.rootId);
  else if (select !== 'nothing') useCanvasStore.getState().selectElement([...parsed.elements.values()].find((element) => element.componentType === select)!.id);
  useProjectStore.getState().markClean();
  root = createRoot(host);
  act(() => root!.render(React.createElement(PropertyPanel)));
}

const choices = () => [...host.querySelectorAll<HTMLElement>('[data-project-theme] [role="radio"]')];
const chosen = () => choices().find((choice) => choice.getAttribute('aria-checked') === 'true')?.textContent;
const outcome = () => host.querySelector('[data-theme-outcome]')?.textContent ?? null;
function choose(label: string): void {
  act(() => choices().find((choice) => choice.textContent === label)!.click());
}

describe('the project theme, among the page\'s properties', () => {
  it('offers light, dark and system, shows the one the project has, and writes the one that is picked', () => {
    mount('<App theme="system"><Text>Hi</Text></App>');
    expect(choices().map((choice) => choice.textContent)).toEqual(['Light', 'Dark', 'System']);
    expect(chosen()).toBe('Light');
    choose('Dark');
    // What Preview and the export read.
    expect(useProjectStore.getState().themeMode).toBe('dark');
    expect(useProjectStore.getState().isDirty).toBe(true);
    expect(chosen()).toBe('Dark');
    choose('System');
    expect(useProjectStore.getState().themeMode).toBe('system');
  });

  it('is offered with nothing selected too, and not for an element that is not the page', () => {
    mount('<App><Text>Hi</Text></App>', 'nothing');
    expect(choices()).toHaveLength(3);
    choose('Dark');
    expect(useProjectStore.getState().themeMode).toBe('dark');
    act(() => useCanvasStore.getState().selectElement([...useCanvasStore.getState().elements.values()].find((element) => element.componentType === 'Text')!.id));
    expect(choices()).toHaveLength(0);
  });

  it('says the page follows the project while the page does not pin a theme of its own', () => {
    mount('<App theme="system"><Text>Hi</Text></App>');
    expect(outcome()).toBe('This page follows the project: light, on the canvas, in Preview and in the running app.');
    choose('Dark');
    expect(outcome()).toBe('This page follows the project: dark, on the canvas, in Preview and in the running app.');
  });

  it('says the page wins where its own theme is light or dark and the project\'s is the other', () => {
    mount('<App theme="light"><Text>Hi</Text></App>');
    choose('Dark');
    expect(outcome()).toBe('This page is light: its own theme is set to light, which wins over the project\'s dark.');
  });
});

describe('which theme a page is drawn in', () => {
  const written = (value: unknown) => ({ value, isExpression: false });

  it('is the project\'s, unless the page pins light or dark, as the App component decides', () => {
    expect(themeSentence('light', written('system'), 'dark')).toBe('This page follows the project: light, on the canvas, in Preview and in the running app.');
    expect(themeSentence('dark', undefined, 'light')).toBe('This page follows the project: dark, on the canvas, in Preview and in the running app.');
    expect(themeSentence('dark', written('dark'), 'light')).toBe('This page is dark: its own theme is set to dark, as the project\'s is.');
    expect(themeSentence('light', written('dark'), 'light')).toBe('This page is dark: its own theme is set to dark, which wins over the project\'s light.');
  });

  it('says what "system" comes to here, and that a visitor sees their own', () => {
    expect(themeSentence('system', written('system'), 'dark')).toBe('This page follows the project: system, which is dark here, as this editor is. A visitor sees their own.');
    expect(themeSentence('system', written('light'), 'dark')).toBe(
      'This page is light: its own theme is set to light, whatever a visitor\'s device prefers. Its chart and code colours still follow the visitor: set the project to light to keep them with the page.'
    );
  });

  it('does not guess a theme that is worked out when the app runs, or one of the author\'s own', () => {
    expect(themeSentence('dark', { value: 'prefs.theme', isExpression: true }, 'light')).toBe(
      'This page works its theme out when the app runs ({prefs.theme}). Until it does, it is drawn as the project is set: dark.'
    );
    expect(themeSentence('dark', written('brand'), 'light')).toBe('This page has a theme of its own, "brand", drawn here over the project\'s dark colours.');
  });
});
