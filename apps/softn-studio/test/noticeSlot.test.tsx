/** @vitest-environment jsdom */
/**
 * A notice is drawn in the page, not over it, where the page's controls are
 * along its bottom.
 *
 * The service worker's notices float in a dock fixed to the window's bottom
 * right corner. The brief's Back and Next are along the bottom at every
 * width, and on a phone "Studio is ready to work offline" lay on them. The
 * brief has a slot above its bar of actions now, and while a slot is in the
 * page the dock is drawn inside it, in the flow.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BriefWizard } from '../src/components/brief/BriefWizard';
import { NoticeSlot } from '../src/components/common/NoticeSlot';
import { PWAPrompt } from '../src/components/common/PWAPrompt';
import { useAIStore, useVFSStore, useWorkspaceStore } from '../src/stores';
import { pwaTest } from './helpers/pwaHook';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  }
  useWorkspaceStore.getState().reset();
  useVFSStore.getState().reset();
  useAIStore.getState().resetSession();
  pwaTest.offlineReady = true;
  pwaTest.needRefresh = false;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  pwaTest.offlineReady = false;
});

const dock = () => host.querySelector<HTMLElement>('.st-pwa-dock')!;

describe('the notices’ dock', () => {
  it('floats in its corner on a page that has no place for it', () => {
    act(() => root.render(<><main>the page</main><PWAPrompt /></>));
    expect(dock().textContent).toContain('Studio is ready to work offline.');
    expect(dock().classList.contains('st-pwa-dock-inline')).toBe(false);
    expect(dock().closest('.st-notice-slot')).toBeNull();
  });

  it('is drawn in the page’s own slot while there is one, and floats again when it has gone', () => {
    const page = (slot: boolean) => (
      <>
        <main>the page</main>
        {slot && <NoticeSlot />}
        <footer><button type="button">Next</button></footer>
        <PWAPrompt />
      </>
    );
    act(() => root.render(page(true)));
    expect(dock().closest('.st-notice-slot')).not.toBeNull();
    expect(dock().classList.contains('st-pwa-dock-inline')).toBe(true);
    expect(dock().textContent).toContain('Studio is ready to work offline.');
    // In the flow, before the bar of actions: nothing of it is over a button.
    expect(host.querySelector('.st-notice-slot')!.nextElementSibling?.tagName).toBe('FOOTER');

    act(() => root.render(page(false)));
    expect(host.querySelector('.st-notice-slot')).toBeNull();
    expect(dock().classList.contains('st-pwa-dock-inline')).toBe(false);
    expect(dock().textContent).toContain('Studio is ready to work offline.');
  });

  it('has its place in the brief, above Back and Next', () => {
    act(() => root.render(<><BriefWizard onBack={() => {}} onSubmit={() => {}} /><PWAPrompt /></>));
    const slot = host.querySelector('.st-notice-slot')!;
    expect(slot.contains(dock())).toBe(true);
    const bar = slot.nextElementSibling!;
    expect([...bar.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual(expect.arrayContaining(['Cancel', 'Next']));
    // Still a notice a person can put away.
    act(() => dock().querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click());
    expect(dock().textContent).not.toContain('ready to work offline');
  });

  it('stands in the flow there: the rule that fixes it to the window is taken off', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/studio.css'), 'utf8');
    const inline = /\.st-pwa-dock\.st-pwa-dock-inline \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(inline).toMatch(/position:\s*static/);
    // Install stays until it is pressed: it is offered on the home page, not in the brief.
    expect(css).toMatch(/\.st-pwa-dock-inline \.st-pwa-install \{\s*display: none !important;/);
  });
});
