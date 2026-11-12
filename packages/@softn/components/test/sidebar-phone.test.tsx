/**
 * An app whose navigation is a Sidebar has its navigation on a phone.
 *
 * At 768 pixels and under the sidebar was hidden and nothing stood in its
 * place: the first page, and no way to any other. It is a menu button there
 * now, and opens over the page as a drawer with the Drawer's own keyboard
 * behaviour. An app that already draws its own phone navigation gets no
 * second one.
 */

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppScopeProvider, ComponentRegistry, getXDB, parse, renderDocument, type SoftNComponent, type SoftNRenderContext } from '@softn/core';
import { click, mount, type Mounted } from './dom';
import { builtinComponents } from '../src/registry';
import { Sidebar } from '../src/layout/Sidebar';
import { Layout } from '../src/layout/Layout';
import { Content } from '../src/layout/Content';
import { NavItem } from '../src/navigation/NavItem';

vi.mock('@yudiel/react-qr-scanner', () => ({
  prepareZXingModule: () => {},
  Scanner: (): React.ReactElement => React.createElement('video'),
}));

/** A screen of the given width, as `matchMedia` reports it, that can be changed. */
function screen(width: number) {
  const listeners = new Set<() => void>();
  let current = width;
  const holds = (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    return max ? current <= Number(max[1]) : false;
  };
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return holds(query);
    },
    media: query,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  return {
    resize(next: number) {
      current = next;
      act(() => listeners.forEach((listener) => listener()));
    },
  };
}

const mounted: Mounted[] = [];
function draw(element: React.ReactElement): Mounted {
  const view = mount(element);
  mounted.push(view);
  return view;
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  for (const view of mounted.splice(0)) view.unmount();
  vi.unstubAllGlobals();
});

const app = (extra?: React.ReactNode, sidebar: Record<string, unknown> = {}) => (
  <div className="softn-app">
    <Layout>
      <Sidebar {...sidebar}>
        <NavItem label="Home" />
        <NavItem label="Clients" />
        <input aria-label="Search" />
      </Sidebar>
      <Content>{extra}</Content>
    </Layout>
  </div>
);

const menuButton = (view: Mounted) => view.container.querySelector<HTMLButtonElement>('.softn-sidebar-menu-button');
const drawer = (view: Mounted) => view.container.querySelector<HTMLElement>('[role="dialog"]');

describe('a Sidebar beside the page', () => {
  it('draws no menu button on a wide screen, and the sidebar as it always was', () => {
    screen(1280);
    const view = draw(app());
    expect(menuButton(view)).toBeNull();
    const aside = view.container.querySelector('aside')!;
    expect(aside.className).toContain('softn-sidebar');
    expect(aside.getAttribute('role')).toBeNull();
    expect(aside.style.position).toBe('relative');
    expect(aside.querySelectorAll('.softn-nav-item')).toHaveLength(2);
    expect(aside.querySelector('.softn-sidebar-toggle')).not.toBeNull();
  });

  it('is the same markup where there is no screen to ask', () => {
    // A server, and a test DOM without matchMedia: the sidebar, and no bar.
    const markup = renderToStaticMarkup(app());
    expect(markup).not.toContain('class="softn-sidebar-bar"');
    expect(markup).not.toContain('<button type="button" class="softn-sidebar-menu-button"');
    expect(markup).toContain('<aside class="softn-sidebar');
  });
});

describe('a Sidebar on a phone', () => {
  it('is a menu button a finger can press, where the sidebar stood', () => {
    screen(360);
    const view = draw(app());
    const button = menuButton(view)!;
    expect(button).not.toBeNull();
    expect(button.getAttribute('aria-label')).toBe('Menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.style.width).toBe('44px');
    expect(button.style.height).toBe('44px');
    // Shut, the sidebar is not drawn and is no dialog.
    expect(drawer(view)).toBeNull();
    expect(view.container.querySelector('aside')!.style.display).toBe('none');
  });

  it('opens over the page as a dialog, with focus in it and the page behind held still', () => {
    screen(360);
    const view = draw(app());
    const button = menuButton(view)!;
    act(() => button.focus());
    click(button);
    const dialog = drawer(view)!;
    expect(dialog).not.toBeNull();
    expect(dialog.tagName).toBe('ASIDE');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Menu');
    expect(dialog.style.position).toBe('fixed');
    expect(dialog.className).toContain('softn-sidebar-open');
    expect(dialog.querySelectorAll('.softn-nav-item')).toHaveLength(2);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');
    // The collapse toggle is for the column beside the page.
    expect(dialog.querySelector('.softn-sidebar-toggle')).toBeNull();
  });

  it('closes when a place is chosen, and gives focus back to the menu button', () => {
    screen(360);
    const view = draw(app());
    const button = menuButton(view)!;
    act(() => button.focus());
    click(button);
    click(drawer(view)!.querySelectorAll('.softn-nav-item')[1]);
    expect(drawer(view)).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(document.body.style.overflow).toBe('');
  });

  it('stays open for a press that chooses no place', () => {
    screen(360);
    const view = draw(app());
    click(menuButton(view));
    click(drawer(view)!.querySelector('input'));
    expect(drawer(view)).not.toBeNull();
  });

  it('closes on Escape, on its close button and on a press outside it', () => {
    screen(360);
    const view = draw(app());
    const button = menuButton(view)!;

    act(() => button.focus());
    click(button);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(drawer(view)).toBeNull();
    expect(document.activeElement).toBe(button);

    click(button);
    click(view.container.querySelector('[aria-label="Close menu"]'));
    expect(drawer(view)).toBeNull();

    click(button);
    click(view.container.querySelector('.softn-sidebar-overlay'));
    expect(drawer(view)).toBeNull();
  });

  it('keeps Tab inside the open drawer', () => {
    screen(360);
    const view = draw(app(<button type="button">Behind</button>));
    click(menuButton(view));
    const dialog = drawer(view)!;
    const stops = Array.from(dialog.querySelectorAll<HTMLElement>('button, input'));
    act(() => stops[stops.length - 1].focus());
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(stops[0]);
  });

  it('keeps what is in it between one opening and the next', () => {
    screen(360);
    const view = draw(app());
    click(menuButton(view));
    const search = drawer(view)!.querySelector('input')!;
    search.value = 'ada';
    click(view.container.querySelector('[aria-label="Close menu"]'));
    click(menuButton(view));
    expect(drawer(view)!.querySelector('input')).toBe(search);
    expect(search.value).toBe('ada');
  });

  it('is drawn open in the drawer though it is collapsed beside the page', () => {
    const display = screen(360);
    const view = draw(app(undefined, { defaultCollapsed: true }));
    click(menuButton(view));
    expect(drawer(view)!.className).not.toContain('collapsed');
    click(view.container.querySelector('[aria-label="Close menu"]'));
    display.resize(1280);
    expect(view.container.querySelector('aside')!.className).toContain('collapsed');
  });

  it('is the sidebar again, shut, when the screen is widened with the drawer open', () => {
    const display = screen(360);
    const view = draw(app());
    click(menuButton(view));
    expect(drawer(view)).not.toBeNull();
    display.resize(1280);
    expect(menuButton(view)).toBeNull();
    expect(drawer(view)).toBeNull();
    expect(view.container.querySelector('aside')!.style.position).toBe('relative');
    expect(document.body.style.overflow).toBe('');
    display.resize(360);
    expect(drawer(view)).toBeNull();
  });

  it('closes when the app goes to another page, whatever was pressed', () => {
    screen(360);
    const xdb = getXDB('sidebar-phone');
    const scoped = (currentPage: string) => (
      <AppScopeProvider value={{ appId: 'sidebar-phone', xdb, active: true, currentPage }}>{app()}</AppScopeProvider>
    );
    const view = draw(scoped('home'));
    click(menuButton(view));
    expect(drawer(view)).not.toBeNull();
    view.rerender(scoped('clients'));
    expect(drawer(view)).toBeNull();
  });

  it('names the button and the drawer as the page says', () => {
    screen(360);
    const view = draw(app(undefined, { menuLabel: 'Sections' }));
    expect(menuButton(view)!.getAttribute('aria-label')).toBe('Sections');
    click(menuButton(view));
    expect(drawer(view)!.getAttribute('aria-label')).toBe('Sections');
  });
});

describe('an app with phone navigation of its own gets no second one', () => {
  it('an element it shows only on a phone', () => {
    screen(360);
    const view = draw(app(<div className="softn-mobile-only">Home | Clients</div>));
    expect(menuButton(view)).toBeNull();
    expect(view.container.querySelector('.softn-sidebar-bar')).toBeNull();
    // Hidden as it always was: the stylesheet's, at this width.
    const aside = view.container.querySelector('aside')!;
    expect(aside.className).toContain('softn-sidebar');
    expect(aside.className).not.toContain('softn-sidebar-open');
  });

  it.each(['Menu', 'Open menu', 'Toggle navigation', 'Navigation menu'])('a menu button of its own, named "%s"', (name) => {
    screen(360);
    const view = draw(app(<button type="button" aria-label={name} />));
    expect(menuButton(view)).toBeNull();
  });

  it('a menu button of its own drawn as the three-line sign', () => {
    screen(360);
    const view = draw(app(<button type="button">{'☰'}</button>));
    expect(menuButton(view)).toBeNull();
  });

  it('but not a menu button it does not show', () => {
    screen(360);
    const view = draw(app(<div style={{ display: 'none' }}><button type="button" aria-label="Menu" /></div>));
    expect(menuButton(view)).not.toBeNull();
  });

  it('nor a button that only mentions a menu', () => {
    screen(360);
    const view = draw(app(<button type="button" aria-label="Print the lunch menu" />));
    expect(menuButton(view)).not.toBeNull();
  });

  it('follows the app when its own navigation comes and goes', () => {
    screen(360);
    const view = draw(app());
    expect(menuButton(view)).not.toBeNull();
    view.rerender(app(<div className="softn-mobile-only" />));
    expect(menuButton(view)).toBeNull();
    view.rerender(app());
    expect(menuButton(view)).not.toBeNull();
  });

  it('is not another app’s on the same page', () => {
    screen(360);
    const view = draw(
      <>
        <div data-softn-app="one">{app()}</div>
        <div data-softn-app="two">
          <div className="softn-mobile-only" />
        </div>
      </>
    );
    expect(menuButton(view)).not.toBeNull();
  });

  it('and mobileMenu={false} says so outright', () => {
    screen(360);
    const view = draw(app(undefined, { mobileMenu: false }));
    expect(menuButton(view)).toBeNull();
    expect(view.container.querySelector('aside')!.className).not.toContain('softn-sidebar-open');
  });
});

describe('from a page', () => {
  const registry = new ComponentRegistry();
  registry.registerAll(builtinComponents as unknown as Record<string, SoftNComponent>);
  const context = { state: {}, setState: () => {}, data: {}, props: {}, computed: {}, functions: {}, asyncFunctions: {} } as unknown as SoftNRenderContext;
  const page = (source: string) => {
    const doc = parse(source);
    expect(doc.diagnostics ?? [], source).toEqual([]);
    return <>{renderDocument(doc, context, registry)}</>;
  };

  it('the bar is the Layout’s own child, so the Layout can put it first', () => {
    screen(360);
    const view = draw(page('<Layout><Content>Page</Content><Sidebar position="right"><NavItem label="Home" /></Sidebar></Layout>'));
    const bar = view.container.querySelector('.softn-sidebar-bar')!;
    expect(bar.parentElement!.className).toContain('softn-layout');
    const rules = Array.from(view.container.querySelectorAll('style')).map((style) => style.textContent ?? '').join('\n');
    expect(rules).toContain('.softn-layout > .softn-sidebar-bar { order: -1;');
    click(menuButton(view));
    expect(drawer(view)!.style.right).toBe('0px');
    expect(drawer(view)!.querySelectorAll('.softn-nav-item')).toHaveLength(1);
  });

  it('mobileMenu={false} written in a page leaves the sidebar hidden', () => {
    screen(360);
    const view = draw(page('<Layout><Sidebar mobileMenu={false}><NavItem label="Home" /></Sidebar><Content>Page</Content></Layout>'));
    expect(menuButton(view)).toBeNull();
  });
});

describe('the rules that hide the sidebar on a phone', () => {
  it('leave the open drawer drawn', async () => {
    const { ThemeProvider } = await import('../src/theme/ThemeProvider');
    screen(360);
    const view = draw(<ThemeProvider>{app()}</ThemeProvider>);
    const rules = Array.from(document.querySelectorAll('style')).map((style) => style.textContent ?? '').join('\n');
    expect(rules).toContain('.softn-sidebar:not(.softn-sidebar-open)');
    expect(rules).not.toMatch(/\.softn-sidebar\s*\{\s*display:\s*none/);
    expect(menuButton(view)).not.toBeNull();
  });
});
