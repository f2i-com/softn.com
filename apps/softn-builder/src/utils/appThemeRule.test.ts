// @vitest-environment jsdom
/**
 * The canvas and Preview draw an app in the side the runtime will.
 *
 * Which side that is has one rule now, for every host that draws an app
 * (@softn/components, theme/app-theme.ts): a project that declares light or
 * dark is that side, unless its page pins the other, and then the tokens
 * (the chart series, the code colours) go with the page; a project that
 * declares nothing follows the host's own theme, then the stored
 * preference, then the device.
 *
 * The Builder had its own reading of each part. Preview handed the
 * project's side to the provider as the editor's switch, which beats a
 * page's pin: an app with a light and dark switch of its own was previewed
 * with the other side's chart colours once it was switched. The canvas kept
 * the tokens on the project's side under a page that pinned the other. And
 * "system" was read from the stored preference and the device, where the
 * web runtime reads its page's theme first.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App, CHART_PALETTE_DARK, CHART_PALETTE_LIGHT, ThemeProvider } from '@softn/components';
import { drawnThemeFor, systemSide, themeSentence, useSystemSide } from './drawnTheme';
import { previewThemeProps } from './previewTheme';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.documentElement.removeAttribute('data-theme');
  window.localStorage.clear();
});

describe('the side the canvas draws a page in', () => {
  it('is the project\'s declared side, with the tokens going with a page that pins the other', () => {
    // A light page in a dark project had the dark set's chart and code
    // colours on it: the tokens stayed the project's.
    expect(drawnThemeFor('dark', 'light', 'dark')).toEqual({ tokens: 'light', page: 'light' });
    expect(drawnThemeFor('light', 'dark', 'light')).toEqual({ tokens: 'dark', page: 'dark' });
    expect(drawnThemeFor('dark', 'dark', 'light')).toEqual({ tokens: 'dark', page: 'dark' });
    // Nothing pinned, or a theme that is not a side: the project's.
    expect(drawnThemeFor('dark', undefined, 'light')).toEqual({ tokens: 'dark', page: 'dark' });
    expect(drawnThemeFor('light', 'system', 'dark')).toEqual({ tokens: 'light', page: 'light' });
    expect(drawnThemeFor('dark', 'brand', 'light')).toEqual({ tokens: 'dark', page: 'dark' });
  });

  it('is what the host comes to for a project that declares nothing, with a pinned page left on those tokens', () => {
    // The runtime changes nothing a project has not asked for: the page
    // pins its own colours, and the tokens follow the host as they did.
    expect(drawnThemeFor('system', undefined, 'dark')).toEqual({ tokens: 'dark', page: 'dark' });
    expect(drawnThemeFor('system', 'light', 'dark')).toEqual({ tokens: 'dark', page: 'light' });
    expect(drawnThemeFor('system', 'dark', 'light')).toEqual({ tokens: 'light', page: 'dark' });
  });
});

describe('what "system" comes to in the editor', () => {
  it('is the document\'s own theme first, then the stored preference, then the device', () => {
    // The order the web runtime reads them in. The document's theme was not
    // read at all, so a System project was drawn by the stored preference
    // or the device under an editor a person had switched the other way.
    expect(systemSide()).toBe('light');
    window.localStorage.setItem('softn-theme-preference', 'dark');
    expect(systemSide()).toBe('dark');
    document.documentElement.setAttribute('data-theme', 'light');
    expect(systemSide()).toBe('light');
    window.localStorage.removeItem('softn-theme-preference');
    document.documentElement.setAttribute('data-theme', 'dark');
    expect(systemSide()).toBe('dark');
    // A word that is no side is no theme: the next thing is asked.
    document.documentElement.setAttribute('data-theme', 'sepia');
    expect(systemSide()).toBe('light');
  });

  it('follows the document\'s theme as it is switched, while it is watched', async () => {
    const seen: string[] = [];
    function Watcher(): null {
      seen.push(useSystemSide(true));
      return null;
    }
    document.documentElement.setAttribute('data-theme', 'light');
    act(() => root.render(React.createElement(Watcher)));
    expect(seen.at(-1)).toBe('light');
    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'dark');
      // A MutationObserver answers after the task that made the change.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(seen.at(-1)).toBe('dark');
  });
});

describe('the theme Preview runs an app in', () => {
  /** The tokens' first chart colour, as the provider wrote it, and the side the page is drawn in. */
  function drawn(): { chart: string | undefined; page: string | null } {
    const css = [...host.querySelectorAll('style')].map((style) => style.textContent ?? '').join('\n');
    return {
      chart: /:root \{[^}]*--color-chart-1: ([^;]+);/.exec(css)?.[1],
      page: host.querySelector('.softn-app')?.getAttribute('data-theme') ?? null,
    };
  }
  const preview = (mode: 'light' | 'dark' | 'system', pageTheme: string | undefined) =>
    act(() =>
      root.render(
        React.createElement(
          ThemeProvider,
          previewThemeProps(mode) as React.ComponentProps<typeof ThemeProvider>,
          React.createElement(App, { theme: pageTheme as never }, React.createElement('span', null, 'app'))
        )
      )
    );

  it('is handed over as the project\'s declaration, not as the editor\'s switch', () => {
    expect(previewThemeProps('dark')).toEqual({ followHost: true, followSystem: true, declaredMode: 'dark' });
    expect(previewThemeProps('system')).toEqual({ followHost: true, followSystem: true, declaredMode: 'system' });
    expect('darkMode' in previewThemeProps('light')).toBe(false);
  });

  it('has the tokens of the side a page switches itself to, in a project that declares the other', () => {
    // An app with a light and dark switch of its own says so through its
    // page's `theme`. Switched to light in a dark project, it was a light
    // page with the dark set's chart colours: the project's side had been
    // given as the switch that beats everything.
    preview('dark', 'dark');
    expect(drawn()).toEqual({ chart: CHART_PALETTE_DARK[0], page: 'dark' });
    preview('dark', 'light');
    expect(drawn()).toEqual({ chart: CHART_PALETTE_LIGHT[0], page: 'light' });
    preview('light', 'dark');
    expect(drawn()).toEqual({ chart: CHART_PALETTE_DARK[0], page: 'dark' });
    // And with no pin, the project's side whatever the editor's own theme is.
    document.documentElement.setAttribute('data-theme', 'light');
    preview('dark', undefined);
    expect(drawn()).toEqual({ chart: CHART_PALETTE_DARK[0], page: 'dark' });
  });

  it('follows the editor\'s own theme for a project that declares nothing', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    preview('system', undefined);
    expect(drawn()).toEqual({ chart: CHART_PALETTE_DARK[0], page: 'dark' });
  });
});

describe('what the panel says of a page\'s theme, in each of the project\'s three', () => {
  const written = (value: unknown) => ({ value, isExpression: false });

  it('a declared side: the project\'s, or the page\'s where it pins one', () => {
    for (const side of ['light', 'dark'] as const) {
      const other = side === 'light' ? 'dark' : 'light';
      expect(themeSentence(side, undefined, other)).toBe(`This page follows the project: ${side}, on the canvas, in Preview and in the running app.`);
      expect(themeSentence(side, written(side), other)).toBe(`This page is ${side}: its own theme is set to ${side}, as the project's is.`);
      expect(themeSentence(side, written(other), side)).toBe(`This page is ${other}: its own theme is set to ${other}, which wins over the project's ${side}.`);
    }
  });

  it('system: what it comes to here, and what a pinned page still leaves to the visitor', () => {
    // Here is the editor's own theme: the document's, read first.
    expect(themeSentence('system', undefined, 'dark')).toBe('This page follows the project: system, which is dark here, as this editor is. A visitor sees their own.');
    // A page that pins a side in a project that declares none keeps its own
    // colours, and the tokens go on following the host: that is drawn on
    // the canvas (a light page, the dark set's charts), and is said.
    expect(themeSentence('system', written('light'), 'dark')).toBe(
      'This page is light: its own theme is set to light, whatever a visitor\'s device prefers. Its chart and code colours still follow the visitor: set the project to light to keep them with the page.'
    );
  });
});
