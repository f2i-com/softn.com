// What shows while an app opens: a wheel, no words, a label for a screen reader, and colours a
// host sets with CSS variables.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { LoadingIndicator } from '../src/loader/LoadingIndicator';
import { LoadingIndicator as Exported } from '../src';
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

function draw(element: React.ReactElement): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(element));
  return host;
}

describe('LoadingIndicator', () => {
  it('is a wheel with no words, heard by its label', () => {
    const shown = draw(<LoadingIndicator label="Loading this app’s data" />);
    const status = shown.querySelector('[role="status"]')!;
    expect(status.getAttribute('aria-label')).toBe('Loading this app’s data');
    // The only text is its style sheet: nothing is read or seen as words.
    expect([...status.childNodes].filter(node => node.nodeName !== 'STYLE').map(node => node.textContent).join('')).toBe('');
    expect(status.querySelector('.softn-loading-wheel')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('takes its colours from the host, pulses for less motion, and is exported', () => {
    const css = draw(<LoadingIndicator />).querySelector('style')!.textContent!;
    expect(css).toContain('var(--softn-loading-color,currentColor)');
    expect(css).toContain('var(--softn-loading-background,transparent)');
    expect(css).toMatch(/prefers-reduced-motion:reduce\)\{\.softn-loading-wheel\{animation:softn-loading-pulse/);
    expect(Exported).toBe(LoadingIndicator);
  });
});
