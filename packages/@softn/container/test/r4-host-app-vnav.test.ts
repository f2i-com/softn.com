/**
 * The virtual navigation bar (`virtual-nav`): its address shows where the app is.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { renderVirtualNavBar } from '../src/virtual-nav-bar';

afterEach(() => {
  document.body.innerHTML = '';
});

function mountBar(onNavigate: (path: string) => void) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const bar = renderVirtualNavBar({
    appName: 'Shop',
    initialPath: '/',
    listDirectory: () => [],
    onNavigate,
    onBack: () => undefined,
    onForward: () => undefined,
    onReload: () => undefined,
  });
  host.attachShadow({ mode: 'open' }).appendChild(bar.element);
  const input = bar.element.querySelector('input') as HTMLInputElement;
  const form = bar.element.querySelector('form') as HTMLFormElement;
  return { bar, input, form };
}

describe('the virtual navigation bar', () => {
  it('shows where a path typed in it led (a redirect, a folder made /folder/), not what was typed', () => {
    const shown = mountBar((path) => {
      // The container went there, and the app's backend sent it on.
      if (path === '/old') shown.bar.setPath('/new?from=old');
    });
    shown.input.focus();
    shown.input.value = '/old';
    shown.input.dispatchEvent(new Event('input', { bubbles: true }));
    shown.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(shown.input.value).toBe('/new?from=old');
  });

  it('still leaves alone what the person is typing when the app moves on by itself', () => {
    const shown = mountBar(() => undefined);
    shown.input.focus();
    shown.input.value = '/half-typ';
    shown.input.dispatchEvent(new Event('input', { bubbles: true }));
    shown.bar.setPath('/elsewhere');
    expect(shown.input.value).toBe('/half-typ');
  });
});
