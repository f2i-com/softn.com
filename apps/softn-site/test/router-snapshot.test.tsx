import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { navigate, useRoute } from '../src/lib/router';
import { SortSelect } from '../src/components/directory/Controls';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  window.scrollTo = vi.fn();
  window.history.replaceState({}, '', '/apps?q=snake');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

function ImmediateNavigation() {
  // A select can change the address after its first render, before the
  // router's passive subscription has attached. This makes that race exact.
  useLayoutEffect(() => { navigate('/apps?q=snake&sort=trending'); }, []);
  return null;
}

function Harness({ immediate = false }: { immediate?: boolean }) {
  const route = useRoute();
  return <>
    <SortSelect value={route.query.get('sort') ?? 'relevance'} searching onChange={(sort) => navigate(`/apps?q=snake&sort=${sort}`)} />
    <output>{route.path}{route.hash}</output>
    {immediate && <ImmediateNavigation />}
  </>;
}

it('catches navigation between the initial render and subscription', () => {
  act(() => root.render(<Harness immediate />));
  expect(window.location.search).toBe('?q=snake&sort=trending');
  expect(container.querySelector('select')!.value).toBe('trending');
});

it('keeps select values aligned with pushes, history events and fragments', () => {
  act(() => root.render(<Harness />));
  const select = container.querySelector('select')!;
  act(() => {
    select.value = 'newest';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(window.location.search).toBe('?q=snake&sort=newest');
  expect(select.value).toBe('newest');
  act(() => {
    window.history.replaceState({}, '', '/apps?q=snake&sort=trending#results');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(select.value).toBe('trending');
  expect(container.querySelector('output')!.textContent).toBe('/apps#results');
});
