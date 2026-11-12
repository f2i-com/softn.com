/** @vitest-environment jsdom */
/**
 * The preview's bar keeps every control, at every width and on a phone.
 *
 * Desktop | Tablet | Phone was words only, and where the bar was narrow the
 * whole switch was hidden. Each choice is a picture and its word now, so the
 * words can go and the choice stay; the button's name is said either way.
 *
 * On a phone the bar itself was hidden, and Refresh, Reset data and Expand
 * with it: a phone had no way to refresh the preview. The bar is drawn there
 * too. (What a narrow bar hides is in styles/editor.css, held by
 * previewHeader.test.ts; the widths are measured in Chromium.)
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceSwitch, StablePreviewSurface, ViewSwitch } from '../src/components/canvas/VisualCanvas';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the preview’s bar', () => {
  it('names each width by a picture and a word, and by name where the word is not drawn', () => {
    const onChange = vi.fn();
    act(() => root.render(<DeviceSwitch preset="desktop" onChange={onChange} />));
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Desktop', 'Tablet', 'Phone']);
    for (const button of buttons) {
      expect(button.querySelector('svg'), 'a picture').not.toBeNull();
      expect(button.querySelector('.st-switch-label')?.textContent).toBe(button.getAttribute('aria-label'));
    }
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    act(() => buttons[2].click());
    expect(onChange).toHaveBeenCalledWith('mobile');
  });

  it('names Preview and Code the same way', () => {
    act(() => root.render(<ViewSwitch mode="preview" onChange={() => {}} />));
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Preview', 'Code']);
    expect(buttons.map((b) => b.querySelector('.st-switch-label')?.textContent)).toEqual(['Preview', 'Code']);
    expect(buttons.every((b) => b.querySelector('svg'))).toBe(true);
  });

  it('is drawn on a phone, with its buttons, and put away only while the preview is expanded', () => {
    const surface = (isMobile: boolean, expanded: boolean) => (
      <StablePreviewSurface
        expanded={expanded}
        isMobile={isMobile}
        label="index.html"
        frameStyle={{}}
        chrome={<button type="button" aria-label="Refresh preview">refresh</button>}
        onClose={() => {}}
      >
        <p>the app</p>
      </StablePreviewSurface>
    );
    act(() => root.render(surface(true, false)));
    const bar = host.querySelector<HTMLElement>('.st-preview-bar')!;
    expect(bar.style.display).not.toBe('none');
    expect(bar.getAttribute('aria-hidden')).toBeNull();
    expect(bar.querySelector('button[aria-label="Refresh preview"]')).not.toBeNull();
    act(() => root.render(surface(true, true)));
    expect(host.querySelector<HTMLElement>('.st-preview-bar')!.style.display).toBe('none');
    expect(host.querySelector<HTMLElement>('.st-preview-bar')!.getAttribute('aria-hidden')).toBe('true');
  });
});
