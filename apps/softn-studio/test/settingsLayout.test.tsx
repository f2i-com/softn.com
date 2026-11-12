/** @vitest-environment jsdom */
/**
 * Settings: a limit's explanation has the row's whole width, and the theme is
 * chosen here as well as in the product bar.
 *
 * A limit's explanation shared one line with its field. In a panel 300px wide
 * that left it a column of about 110: "Max output tokens" ran to fifteen
 * lines beside one number. The name and the field are the first line now and
 * the explanation is under both. (jsdom lays nothing out, so this holds the
 * rules; the heights are measured in Chromium.)
 *
 * The General tab said the theme is switched in the bar at the top of the
 * page. A phone's editor does not draw that bar, so the choice itself is
 * here. A hosted editor's theme is its host's, and it has no choice to make.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsPanel } from '../src/components/panels/SettingsPanel';
import { useWorkspaceStore } from '../src/stores';

const css = readFileSync(resolve(process.cwd(), 'src/styles/editor.css'), 'utf8');

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): Record<string, string> {
  const at = css.search(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{`));
  if (at < 0) throw new Error(`no rule for ${selector}`);
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  return Object.fromEntries(body.split(';').map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]).filter((d) => d[0]));
}

describe('a limit’s row in Settings', () => {
  it('has the name and the field on one line and the explanation across the row under them', () => {
    const row = rule('.st-limit-row');
    expect(row.display).toBe('grid');
    expect(row['grid-template-areas'].replace(/\s+/g, ' ')).toBe(`'label field' 'hint hint'`);
    expect(rule('.st-limit-label')['grid-area']).toBe('label');
    expect(rule('.st-limit-hint')['grid-area']).toBe('hint');
    // The name and the explanation are placed as the row's own, so the field can stand between them.
    expect(rule('.st-limit-text').display).toBe('contents');
  });
});

describe('the theme in Settings', () => {
  let root: Root;
  let container: HTMLDivElement;
  const painted = document.documentElement.getAttribute('data-theme');

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    useWorkspaceStore.getState().setThemePreview('dark');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<SettingsPanel />));
    act(() => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === 'General')!.click());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    if (painted) document.documentElement.setAttribute('data-theme', painted);
    else document.documentElement.removeAttribute('data-theme');
  });

  it('is chosen there: Light and Dark, the one in use pressed', () => {
    const group = container.querySelector('[role="group"][aria-labelledby="studio-theme-heading"]')!;
    const buttons = [...group.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(['Light', 'Dark']);
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);

    act(() => buttons[0].click());
    // Painted, remembered for every SoftN page, and shown as chosen.
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('softn.site.theme')).toBe('light');
    expect(useWorkspaceStore.getState().themePreview).toBe('light');
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']);

    act(() => buttons[1].click());
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('softn.site.theme')).toBe('dark');
  });
});
