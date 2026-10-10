/**
 * A project's manifest declares light, dark or system (`config.theme.mode`),
 * and the ThemeProvider is where a host hands that over. These tests hold the
 * provider to the rule in src/theme/app-theme.ts as a running app meets it:
 * the host page switching theme under it, the device changing, a page whose
 * own `<App theme>` is worked out while the app runs, and a document that
 * draws more than one app.
 */
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { mount } from './dom';
import { App } from '../src/layout/App';
import { ThemeProvider, themeToCssVariables, useTheme } from '../src/theme/ThemeProvider';
import { darkTheme, lightTheme } from '../src/theme/tokens';

const LIGHT = themeToCssVariables(lightTheme);
const DARK = themeToCssVariables(darkTheme);

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  vi.restoreAllMocks();
});

function Side() {
  return <p data-side="">{useTheme().isDarkMode ? 'dark' : 'light'}</p>;
}
const side = (container: Element) => container.querySelector('[data-side]')?.textContent;
/** The provider's own stylesheet: the first one it renders, before anything an app adds. */
const sheet = (container: Element) => container.querySelector('style')?.textContent ?? '';
/** The declarations a selector is given in a stylesheet, or null when it has no rule there. */
function rule(css: string, selector: string): string | null {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return null;
  return css.slice(at + selector.length + 2, css.indexOf('}', at));
}

it('draws a project declared dark in the dark tokens on a light host, and keeps it there whatever the host does next', async () => {
  // softn.com's page is light for this visitor, the stored preference says
  // light and so does the device: all three used to decide, and none does now.
  document.documentElement.setAttribute('data-theme', 'light');
  localStorage.setItem('softn-theme-preference', 'light');
  const media = new EventTarget() as MediaQueryList;
  Object.assign(media, { matches: false });
  vi.spyOn(window, 'matchMedia').mockReturnValue(media);
  const view = mount(
    <ThemeProvider followHost followSystem declaredMode="dark">
      <App><Side /></App>
    </ThemeProvider>,
  );
  try {
    expect(side(view.container)).toBe('dark');
    expect(view.container.querySelector('.softn-app')?.getAttribute('data-theme')).toBe('dark');
    expect(rule(sheet(view.container), ':root')).toContain(`--color-bg: ${DARK['--color-bg']};`);

    await act(async () => { document.documentElement.setAttribute('data-theme', 'dark'); });
    await act(async () => { document.documentElement.setAttribute('data-theme', 'light'); });
    expect(side(view.container)).toBe('dark');
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'softn-theme-preference', newValue: 'light' })); });
    expect(side(view.container)).toBe('dark');
    act(() => { media.dispatchEvent(new Event('change')); });
    expect(side(view.container)).toBe('dark');
    expect(view.container.querySelector('.softn-app')?.getAttribute('data-theme')).toBe('dark');
  } finally { view.unmount(); }
});

it('draws a project declared light in the light tokens where the deployment is configured dark', () => {
  // The single-app shell: no host page to follow, the operator's `theme` as
  // the default.
  const view = mount(<ThemeProvider defaultDarkMode declaredMode="light"><App><Side /></App></ThemeProvider>);
  try {
    expect(side(view.container)).toBe('light');
    expect(view.container.querySelector('.softn-app')?.getAttribute('data-theme')).toBe('light');
    expect(rule(sheet(view.container), ':root')).toContain(`--color-bg: ${LIGHT['--color-bg']};`);
  } finally { view.unmount(); }
});

it('goes on following the host page for a project declared system, as for one that declares nothing', async () => {
  document.documentElement.setAttribute('data-theme', 'light');
  const declared = mount(<ThemeProvider followHost followSystem declaredMode="system"><Side /></ThemeProvider>);
  const silent = mount(<ThemeProvider followHost followSystem><Side /></ThemeProvider>);
  try {
    expect(side(declared.container)).toBe('light');
    // Not a word of the stylesheet differs from the one written before the
    // provider knew of a manifest.
    expect(sheet(declared.container)).toBe(sheet(silent.container));
    await act(async () => { document.documentElement.setAttribute('data-theme', 'dark'); });
    expect(side(declared.container)).toBe('dark');
    expect(sheet(declared.container)).toBe(sheet(silent.container));
  } finally { declared.unmount(); silent.unmount(); }
});

it('gives a page pinned light in a project declared dark the light tokens, and follows the page as it works its theme out', () => {
  // glamour-studio and showcase: `<App theme={darkMode ? "dark" : "light"}>`
  // in a project declared dark. The page chooses, and the tokens `<App>` does
  // not name (the chart series, the code colours) go with the page instead of
  // staying the manifest's dark under a light page.
  const page = (theme: string, key?: string) => (
    <ThemeProvider defaultDarkMode declaredMode="dark">
      <App theme={theme} key={key}><Side /></App>
    </ThemeProvider>
  );
  const view = mount(page('light'));
  try {
    expect(side(view.container)).toBe('light');
    expect(view.container.querySelector('.softn-app')?.getAttribute('data-theme')).toBe('light');
    expect(rule(sheet(view.container), ':root')).toContain(`--color-chart-1: ${LIGHT['--color-chart-1']};`);

    // The app's own switch is pressed: the expression comes to "dark".
    view.rerender(page('dark'));
    expect(side(view.container)).toBe('dark');
    expect(rule(sheet(view.container), ':root')).toContain(`--color-chart-1: ${DARK['--color-chart-1']};`);

    // glamour-studio keys its page by the theme, so the page is a new one.
    view.rerender(page('light', 'theme-light'));
    expect(side(view.container)).toBe('light');
    expect(rule(sheet(view.container), ':root')).toContain(`--color-chart-1: ${LIGHT['--color-chart-1']};`);

    // A theme that names neither side hands the choice back to the project.
    view.rerender(page('system', 'theme-light'));
    expect(side(view.container)).toBe('dark');
  } finally { view.unmount(); }
});

it('leaves the tokens under a pinned page where they were when the project declares no side', () => {
  // Nine demos pin `<App theme>`; in a project that declares system, or
  // nothing, what the pin drives is what it drove before, and no more.
  const view = mount(<ThemeProvider defaultDarkMode declaredMode="system"><App theme="light"><Side /></App></ThemeProvider>);
  try {
    expect(view.container.querySelector('.softn-app')?.getAttribute('data-theme')).toBe('light');
    expect(side(view.container)).toBe('dark');
    expect(rule(sheet(view.container), ':root')).toContain(`--color-chart-1: ${DARK['--color-chart-1']};`);
  } finally { view.unmount(); }
});

it('takes the page to be the outermost App, not one drawn inside it', () => {
  // A page used inside another brings its own `<App>` along; the app's page
  // is the one around it.
  const app = (inner: boolean) => (
    <ThemeProvider declaredMode="light">
      <App theme="dark">{inner ? <App theme="light"><Side /></App> : <Side />}</App>
    </ThemeProvider>
  );
  const view = mount(app(true));
  try {
    expect(side(view.container)).toBe('dark');
    // Nor when the inner page arrives later, and so is the last to be drawn.
    view.rerender(app(false));
    view.rerender(app(true));
    expect(side(view.container)).toBe('dark');
  } finally { view.unmount(); }
});

it('lets an editor preview switch decide outright, as it did, over a project that declares a side', () => {
  const view = mount(<ThemeProvider darkMode={false} declaredMode="dark"><App><Side /></App></ThemeProvider>);
  try {
    expect(side(view.container)).toBe('light');
    expect(view.container.querySelector('.softn-app')?.getAttribute('data-theme')).toBe('light');
  } finally { view.unmount(); }
});

it('keeps two apps in one document each on its own side', () => {
  // The web runtime keeps every open app mounted, and every provider used to
  // write its tokens on `:root`, where the last one written wins for all of
  // them: opened after a project declared dark, a light one would have turned
  // it light. A host with several apps names each app's box, and a declared
  // side is written on the box, with the document left on the host's own.
  document.documentElement.setAttribute('data-theme', 'light');
  const view = mount(
    <>
      <div data-softn-theme-box="tab-a"><ThemeProvider followHost followSystem declaredMode="dark" box="tab-a"><Side /></ThemeProvider></div>
      <div data-softn-theme-box="tab-b"><ThemeProvider followHost followSystem declaredMode="light" box="tab-b"><Side /></ThemeProvider></div>
      <div data-softn-theme-box="tab-c"><ThemeProvider followHost followSystem box="tab-c"><Side /></ThemeProvider></div>
    </>,
  );
  try {
    const [dark, light, silent] = [...view.container.querySelectorAll('[data-softn-theme-box]')];
    expect([side(dark), side(light), side(silent)]).toEqual(['dark', 'light', 'light']);

    // Every provider writes the host's side on the document, so none of them
    // can change another's by being later in it.
    for (const box of [dark, light, silent]) {
      expect(rule(sheet(box), ':root')).toContain(`--color-bg: ${LIGHT['--color-bg']};`);
    }
    // The app declared dark has the dark set on its own box, and a ground and
    // a text colour from it: an app with no `<App>` and no background of its
    // own would otherwise stand in dark tokens on the host's light page.
    const own = rule(sheet(dark), '[data-softn-theme-box="tab-a"]');
    expect(own).toContain(`--color-bg: ${DARK['--color-bg']};`);
    expect(own).toContain(`--color-chart-1: ${DARK['--color-chart-1']};`);
    expect(own).toContain('background-color: var(--color-bg);');
    expect(own).toContain('color: var(--color-text);');
    expect(own).toContain('color-scheme: dark;');
    // An app on the host's own side is given nothing it did not have.
    expect(sheet(light)).toBe(sheet(silent));
    expect(sheet(light)).not.toContain('data-softn-theme-box');
  } finally { view.unmount(); }
});

it('moves the tokens on an app’s box with the page when the page pins the other side', () => {
  document.documentElement.setAttribute('data-theme', 'dark');
  const page = (theme: string) => (
    <div data-softn-theme-box="tab-a">
      <ThemeProvider followHost followSystem declaredMode="dark" box="tab-a"><App theme={theme}><Side /></App></ThemeProvider>
    </div>
  );
  const view = mount(page('dark'));
  try {
    // Dark on a dark host: nothing for the box to correct.
    expect(sheet(view.container)).not.toContain('data-softn-theme-box');
    view.rerender(page('light'));
    expect(side(view.container)).toBe('light');
    expect(rule(sheet(view.container), ':root')).toContain(`--color-chart-1: ${DARK['--color-chart-1']};`);
    expect(rule(sheet(view.container), '[data-softn-theme-box="tab-a"]')).toContain(`--color-chart-1: ${LIGHT['--color-chart-1']};`);
  } finally { view.unmount(); }
});

it('writes a box name into its stylesheet only when it is a plain name', () => {
  // The name lands inside `<style>` text as part of a selector.
  document.documentElement.setAttribute('data-theme', 'light');
  const hostile = 'a"] { } body { outline: 9px solid red } [x="';
  const view = mount(<ThemeProvider followHost declaredMode="dark" box={hostile}><Side /></ThemeProvider>);
  try {
    const css = sheet(view.container);
    expect(css).not.toContain('outline: 9px');
    expect(css).not.toContain('data-softn-theme-box');
    // With no box it can name, the declared side is written where it always
    // was, on the document.
    expect(side(view.container)).toBe('dark');
    expect(rule(css, ':root')).toContain(`--color-bg: ${DARK['--color-bg']};`);
  } finally { view.unmount(); }
});
