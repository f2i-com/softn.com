/**
 * NavItem's `page` and `navigate`, which were attributes nothing read: the
 * item drew `data-page` and `data-navigate` and a click did nothing.
 *
 *  - `page="about"` shows that page: it sets the state the app keeps its
 *    page in, and the item is the current one while that page shows;
 *  - `navigate="about.html"` is a link, shown in the app where the host can
 *    show that page itself, and the browser's otherwise.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppScopeProvider, getXDB, type AppScope } from '@softn/core';
import { mount, type Mounted } from './dom';
import { NavItem } from '../src/navigation/NavItem';

let view: Mounted | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
});

function scope(extra: Partial<AppScope>): AppScope {
  return { xdb: getXDB(), active: true, ...extra };
}

function click(element: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  let prevented = false;
  document.addEventListener('click', (seen) => {
    prevented = seen.defaultPrevented;
    // jsdom does not navigate, and says so: no link is followed here.
    seen.preventDefault();
  }, { once: true });
  act(() => {
    element.dispatchEvent(event);
  });
  Object.defineProperty(event, 'appPrevented', { value: prevented });
  return event;
}
const prevented = (event: MouseEvent) => (event as MouseEvent & { appPrevented: boolean }).appPrevented;

describe('NavItem page', () => {
  it('shows that page, and is the current item while it shows', () => {
    const showPage = vi.fn(() => true);
    view = mount(
      <AppScopeProvider value={scope({ currentPage: 'home', showPage })}>
        <NavItem label="Home" page="home" />
        <NavItem label="About" page="about" />
      </AppScopeProvider>
    );
    const [home, about] = view.container.querySelectorAll('button');
    expect(home.getAttribute('aria-current')).toBe('page');
    expect(about.getAttribute('aria-current')).toBeNull();
    expect(home.hasAttribute('data-page')).toBe(false);
    click(about);
    expect(showPage).toHaveBeenCalledWith('about');
  });

  it('is the current item only as `active` says, when it is given', () => {
    view = mount(
      <AppScopeProvider value={scope({ currentPage: 'home', showPage: () => true })}>
        <NavItem label="Home" page="home" active={false} />
      </AppScopeProvider>
    );
    expect(view.container.querySelector('button')!.getAttribute('aria-current')).toBeNull();
  });

  it('follows a page of the bundle by that name in an app that keeps no page state', () => {
    const followLink = vi.fn(() => true);
    view = mount(
      <AppScopeProvider value={scope({ followLink })}>
        <NavItem label="About" page="about.html" />
      </AppScopeProvider>
    );
    click(view.container.querySelector('button')!);
    expect(followLink).toHaveBeenCalledWith('about.html');
  });
});

describe('NavItem navigate', () => {
  it('is a link, shown in the app when the host can show that page', () => {
    const followLink = vi.fn(() => true);
    const onClick = vi.fn();
    view = mount(
      <AppScopeProvider value={scope({ followLink })}>
        <NavItem label="About" navigate="about.html" onClick={onClick} />
      </AppScopeProvider>
    );
    const link = view.container.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('about.html');
    expect(link.hasAttribute('data-navigate')).toBe(false);
    expect(prevented(click(link))).toBe(true);
    expect(followLink).toHaveBeenCalledWith('about.html');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is the browser’s when the host does not take it, or the person opens it elsewhere', () => {
    const followLink = vi.fn(() => false);
    view = mount(
      <AppScopeProvider value={scope({ followLink })}>
        <NavItem label="About" navigate="about.html" />
        <NavItem label="Site" navigate="https://example.com/" />
        <NavItem label="Top" navigate="#top" />
      </AppScopeProvider>
    );
    const [about, site, top] = view.container.querySelectorAll('a');
    expect(prevented(click(about))).toBe(false);
    expect(prevented(click(site))).toBe(false);
    expect(prevented(click(top))).toBe(false);
    // Only the app's own page was offered to the host.
    expect(followLink.mock.calls).toEqual([['about.html']]);
    followLink.mockReturnValue(true);
    expect(prevented(click(about, { ctrlKey: true }))).toBe(false);
    expect(followLink).toHaveBeenCalledTimes(1);
  });

  it('is no link at all for an address that would run code, however it is hidden', () => {
    view = mount(
      <AppScopeProvider value={scope({})}>
        <NavItem label="Bad" navigate="javascript:alert(1)" />
        <NavItem label="Tab" navigate={'java\tscript:alert(1)'} />
        <NavItem label="Line" navigate={'\njavascript:alert(1)'} />
        <NavItem label="Control" navigate={'\u0001javascript:alert(1)'} />
        <NavItem label="Data" navigate="data:text/html,hi" />
        <NavItem label="Blob" navigate="blob:https://site.test/1" />
      </AppScopeProvider>
    );
    expect(view.container.querySelector('a')).toBeNull();
    expect(view.container.querySelectorAll('button')).toHaveLength(6);
  });

  it('shows its page and is then not followed as a link too', () => {
    const showPage = vi.fn(() => true);
    view = mount(
      <AppScopeProvider value={scope({ currentPage: 'home', showPage })}>
        <NavItem label="About" page="about" navigate="about.html" />
      </AppScopeProvider>
    );
    expect(prevented(click(view.container.querySelector('a')!))).toBe(true);
    expect(showPage).toHaveBeenCalledWith('about');
  });
});
