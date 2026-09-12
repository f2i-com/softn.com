import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CategoryChips, Pagination } from '../src/components/directory/Controls';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe.each(['categories', 'pagination'] as const)('%s link behavior', (kind) => {
  function renderLink(onNavigate: () => void): HTMLAnchorElement {
    act(() => root.render(kind === 'categories'
      ? <CategoryChips categories={[]} selected="games" hrefFor={() => '/apps'} onSelect={onNavigate} />
      : <Pagination page={1} pages={3} hrefFor={(page) => `/apps?page=${page}`} onPage={onNavigate} />));
    return container.querySelector<HTMLAnchorElement>(kind === 'categories' ? 'a' : 'a.page-next')!;
  }

  it('intercepts an ordinary click once', () => {
    const onNavigate = vi.fn();
    const link = renderLink(onNavigate);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => link.dispatchEvent(event));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each(['ctrlKey', 'metaKey', 'shiftKey', 'altKey'])('leaves %s clicks to the browser without replacing the current page', (modifier) => {
    const onNavigate = vi.fn();
    const link = renderLink(onNavigate);
    let wasIntercepted = true;
    // Observe after React's root listener, then prevent jsdom's navigation.
    const observe = (event: MouseEvent) => { wasIntercepted = event.defaultPrevented; event.preventDefault(); };
    document.addEventListener('click', observe, { once: true });
    act(() => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, [modifier]: true })));
    expect(wasIntercepted).toBe(false);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(link.getAttribute('href')).toMatch(/^\/apps/);
  });
});
