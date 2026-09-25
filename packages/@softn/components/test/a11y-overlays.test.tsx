/**
 * Keyboard and screen-reader behaviour of the overlays, menus and disclosure
 * widgets: what the WAI-ARIA Authoring Practices ask of each pattern, pinned
 * where the components used to fall short.
 */

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount as mountRoot, click, type Mounted } from './dom';
import { Modal } from '../src/feedback/Modal';
import { Drawer } from '../src/feedback/Drawer';
import { Popover } from '../src/feedback/Popover';
import { Toast } from '../src/feedback/Toast';
import { Alert } from '../src/feedback/Alert';
import { EmptyState } from '../src/feedback/EmptyState';
import { Menu } from '../src/navigation/Menu';
import { Tabs } from '../src/navigation/Tabs';
import { NavItem } from '../src/navigation/NavItem';
import { Breadcrumb } from '../src/navigation/Breadcrumb';
import { Tooltip } from '../src/utility/Tooltip';
import { Accordion } from '../src/utility/Accordion';
import { Collapse } from '../src/utility/Collapse';

let consoleError: ReturnType<typeof vi.spyOn>;
const mounted: Mounted[] = [];

/** Mount, and unmount after the test: document listeners must not leak into the next one. */
function mount(element: React.ReactElement): Mounted {
  const view = mountRoot(element);
  mounted.push(view);
  return view;
}

beforeEach(() => {
  document.body.innerHTML = '';
  consoleError = vi.spyOn(console, 'error');
});

afterEach(() => {
  for (const view of mounted.splice(0)) view.unmount();
  // No React warnings (bad nesting, unknown props, missing keys) from any of it.
  const warnings = consoleError.mock.calls.filter((args: unknown[]) => String(args[0]).includes('Warning'));
  consoleError.mockRestore();
  vi.useRealTimers();
  expect(warnings).toEqual([]);
});

function key(target: Element | Document | null | undefined, name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  if (!target) throw new Error(`key ${name}: no target`);
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function focus(el: HTMLElement | null | undefined): void {
  if (!el) throw new Error('focus: no element');
  act(() => el.focus());
}

function button(name: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find(
    (b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim() === name
  );
  if (!found) throw new Error(`no button "${name}"`);
  return found;
}

describe('Modal and Drawer as modal layers', () => {
  it('closes only the topmost layer on Escape', () => {
    const closeDrawer = vi.fn();
    const closeModal = vi.fn();
    mount(
      <Drawer open onClose={closeDrawer} title="Filters">
        <p>Drawer body</p>
        <Modal open onClose={closeModal} title="Confirm" disableAnimation>
          <button>OK</button>
        </Modal>
      </Drawer>
    );

    key(document.activeElement ?? document.body, 'Escape');

    expect(closeModal).toHaveBeenCalledTimes(1);
    expect(closeDrawer).not.toHaveBeenCalled();
  });

  it('leaves the modal open when something inside it handled the Escape (an open tooltip)', () => {
    const closeModal = vi.fn();
    mount(
      <Modal open onClose={closeModal} title="Settings" disableAnimation>
        <Tooltip content="What this does">
          <button>Help</button>
        </Tooltip>
      </Modal>
    );
    const help = button('Help');
    focus(help); // opens the tooltip: hover tooltips open on focus too
    expect(document.querySelector('[role="tooltip"]')?.getAttribute('aria-hidden')).toBe('false');

    key(help, 'Escape');
    expect(closeModal).not.toHaveBeenCalled();
    expect(document.querySelector('[role="tooltip"]')?.getAttribute('aria-hidden')).toBe('true');

    key(help, 'Escape');
    expect(closeModal).toHaveBeenCalledTimes(1);
  });

  it('wraps Shift+Tab from the dialog itself to the last control, not the page behind', () => {
    mount(
      <>
        <button>Behind</button>
        <Modal open onClose={() => {}} title="Edit" disableAnimation footer={<button>Save</button>}>
          <input aria-label="Name" />
        </Modal>
      </>
    );
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(document.activeElement).toBe(dialog);

    const event = key(dialog, 'Tab', { shiftKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button('Save'));
  });

  it('keeps focus on a dialog with nothing to tab to', () => {
    mount(
      <Modal open onClose={() => {}} showCloseButton={false} ariaLabel="Notice" disableAnimation>
        <p>Read only.</p>
      </Modal>
    );
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const event = key(dialog, 'Tab');
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog);
    expect(dialog.getAttribute('aria-label')).toBe('Notice');
  });

  it('gives every dialog its own title id', () => {
    mount(
      <>
        <Modal open onClose={() => {}} title="First" disableAnimation />
        <Modal open onClose={() => {}} title="Second" disableAnimation />
      </>
    );
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    const labels = dialogs.map((d) => document.getElementById(d.getAttribute('aria-labelledby')!)?.textContent);
    expect(labels).toEqual(['First', 'Second']);
  });

  it('returns focus to the control that opened it', () => {
    function Harness({ open }: { open: boolean }) {
      return (
        <>
          <button>Open</button>
          <Modal open={open} onClose={() => {}} title="T" disableAnimation>
            <button>Inside</button>
          </Modal>
        </>
      );
    }
    const view = mount(<Harness open={false} />);
    focus(button('Open'));
    view.rerender(<Harness open />);
    expect(document.activeElement?.getAttribute('role')).toBe('dialog');
    view.rerender(<Harness open={false} />);
    expect(document.activeElement).toBe(button('Open'));
  });

  it('names the drawer by its title and slides in with keyframes that exist', () => {
    mount(<Drawer open onClose={() => {}} title="Cart" position="right" />);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Cart');
    const animationName = dialog.style.animation.split(' ')[0];
    expect(animationName).toBe('softn-drawer-in-right');
    expect(document.querySelector('style')?.textContent).toContain(`@keyframes ${animationName} `);
  });
});

describe('Menu', () => {
  const items = [
    { key: 'edit', label: 'Edit', onClick: vi.fn() },
    { key: 'copy', label: 'Copy', disabled: true },
    { key: 'share', label: 'Share', divider: true },
    { key: 'delete', label: 'Delete', danger: true },
  ];

  it('is a menu button: announced, opened from the keyboard onto the first item', () => {
    mount(<Menu trigger="Actions" items={items} />);
    const trigger = button('Actions');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    focus(trigger);
    key(trigger, 'ArrowDown');

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const menu = document.getElementById(trigger.getAttribute('aria-controls')!)!;
    expect(menu.getAttribute('role')).toBe('menu');
    expect(document.activeElement?.textContent).toBe('Edit');
  });

  it('moves with the arrow keys, Home and End, skipping disabled items, with one tab stop', () => {
    mount(<Menu trigger="Actions" items={items} />);
    const trigger = button('Actions');
    focus(trigger);
    key(trigger, 'ArrowDown');

    key(document.activeElement, 'ArrowDown');
    expect(document.activeElement?.textContent).toBe('Share'); // Copy is disabled
    key(document.activeElement, 'End');
    expect(document.activeElement?.textContent).toBe('Delete');
    key(document.activeElement, 'ArrowDown');
    expect(document.activeElement?.textContent).toBe('Edit'); // wraps
    key(document.activeElement, 'ArrowUp');
    expect(document.activeElement?.textContent).toBe('Delete');
    key(document.activeElement, 'Home');
    expect(document.activeElement?.textContent).toBe('Edit');

    const stops = Array.from(document.querySelectorAll('[role="menuitem"]')).filter(
      (el) => (el as HTMLElement).tabIndex === 0
    );
    expect(stops).toHaveLength(1);
    expect(document.querySelector('[role="separator"]')).not.toBeNull();
  });

  it('closes on Escape and gives focus back to the trigger, without closing a dialog around it', () => {
    const closeModal = vi.fn();
    mount(
      <Modal open onClose={closeModal} title="T" disableAnimation>
        <Menu trigger="Actions" items={items} />
      </Modal>
    );
    const trigger = button('Actions');
    focus(trigger);
    key(trigger, 'ArrowDown');
    key(document.activeElement, 'Escape');

    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
    expect(closeModal).not.toHaveBeenCalled();
  });

  it('runs an item and closes when the item is chosen', () => {
    const onEdit = vi.fn();
    mount(<Menu trigger="Actions" items={[{ key: 'edit', label: 'Edit', onClick: onEdit }]} />);
    click(button('Actions'));
    click(button('Edit'));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(button('Actions').getAttribute('aria-expanded')).toBe('false');
  });

  it('puts the menu-button attributes on a trigger that is already a button, without nesting buttons', () => {
    mount(<Menu trigger={<button>More</button>} items={items} />);
    const trigger = button('More');
    expect(trigger.parentElement?.closest('button')).toBeNull();
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    focus(trigger);
    key(trigger, 'ArrowDown');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement?.textContent).toBe('Edit');
  });
});

describe('Popover', () => {
  it('makes a plain trigger a button that opens a named dialog and closes on Escape', () => {
    mount(
      <Popover trigger="Details" ariaLabel="Details">
        <a href="#more">More</a>
      </Popover>
    );
    const trigger = document.querySelector<HTMLElement>('[role="button"]')!;
    expect(trigger.tabIndex).toBe(0);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    focus(trigger);
    key(trigger, 'Enter');
    const popup = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(popup.id);
    expect(document.activeElement?.textContent).toBe('More');

    key(document.activeElement, 'Escape');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('marks an app-supplied button trigger as expanded', () => {
    mount(<Popover trigger={<button>Open</button>}>Body</Popover>);
    const trigger = button('Open');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('in hover mode, stays open while the pointer crosses to the popup', () => {
    vi.useFakeTimers();
    mount(
      <Popover trigger="Hover me" triggerMode="hover">
        Body
      </Popover>
    );
    const container = document.querySelector('[role="button"]')!.parentElement!;
    act(() => {
      container.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    // Out through the gap, back in on the popup within the grace period.
    act(() => {
      container.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    });
    act(() => vi.advanceTimersByTime(50));
    act(() => {
      document
        .querySelector('[role="dialog"]')!
        .dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    });
    act(() => vi.advanceTimersByTime(500));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    act(() => {
      container.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    });
    act(() => vi.advanceTimersByTime(500));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('names its entrance keyframes per placement', () => {
    mount(
      <>
        <Popover trigger="A" defaultOpen placement="top">
          a
        </Popover>
        <Popover trigger="B" defaultOpen placement="left">
          b
        </Popover>
      </>
    );
    const names = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).map(
      (el) => el.style.animation.split(' ')[0]
    );
    expect(names).toEqual(['softn-popover-in-top', 'softn-popover-in-left']);
  });
});

describe('Tabs', () => {
  const tabs = [
    { key: 'general', label: 'General', content: 'General settings' },
    { key: 'advanced', label: 'Advanced', content: 'Advanced settings' },
  ];

  it('keeps ids unique across instances and points only at panels that exist', () => {
    mount(
      <>
        <Tabs tabs={tabs} />
        <Tabs tabs={tabs} />
      </>
    );
    const ids = Array.from(document.querySelectorAll('[role="tab"], [role="tabpanel"]')).map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const tab of Array.from(document.querySelectorAll('[role="tab"]'))) {
      const controls = tab.getAttribute('aria-controls');
      if (controls) expect(document.getElementById(controls)?.getAttribute('role')).toBe('tabpanel');
    }
    const [first, second] = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(first.type).toBe('button');
    expect(second.getAttribute('aria-controls')).toBeNull();
  });

  it('leaves the focus ring alone', () => {
    mount(<Tabs tabs={tabs} />);
    const tab = document.querySelector<HTMLElement>('[role="tab"]')!;
    expect(tab.style.outline).toBe('');
  });

  it('keeps a tab reachable when the active key names no tab, or a disabled one', () => {
    mount(
      <Tabs
        activeKey="missing"
        tabs={[{ key: 'a', label: 'A', disabled: true }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }]}
      />
    );
    const stops = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).filter((t) => t.tabIndex === 0);
    expect(stops.map((t) => t.textContent)).toEqual(['B']);
    focus(stops[0]);
    key(stops[0], 'ArrowRight');
    expect(document.activeElement?.textContent).toBe('C');
  });

  it('does not submit a surrounding form', () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    mount(
      <form onSubmit={onSubmit}>
        <Tabs tabs={tabs} />
      </form>
    );
    click(document.querySelectorAll('[role="tab"]')[1]);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('Tooltip', () => {
  it('opens on keyboard focus by default and closes on blur', () => {
    mount(
      <Tooltip content="Saves the draft">
        <button>Save</button>
      </Tooltip>
    );
    const tooltip = document.querySelector('[role="tooltip"]')!;
    focus(button('Save'));
    expect(tooltip.getAttribute('aria-hidden')).toBe('false');
    act(() => button('Save').blur());
    expect(tooltip.getAttribute('aria-hidden')).toBe('true');
  });

  it('asks its owner to close a manual tooltip on Escape', () => {
    const onOpenChange = vi.fn();
    mount(
      <Tooltip trigger="manual" open content="Tip" onOpenChange={onOpenChange}>
        <button>Target</button>
      </Tooltip>
    );
    key(document.body, 'Escape');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('can sit inside a paragraph', () => {
    mount(
      <p>
        Read the{' '}
        <Tooltip content="Terms of service">
          <a href="#terms">terms</a>
        </Tooltip>
        .
      </p>
    );
    expect(document.querySelector('p [role="tooltip"]')?.tagName).toBe('SPAN');
  });
});

describe('Accordion', () => {
  const items = [
    { key: 'one', header: 'One', content: 'First' },
    { key: 'two', header: 'Two', content: 'Second' },
  ];

  it('keeps each instance to itself: unique ids, and the arrow keys stay inside it', () => {
    mount(
      <>
        <Accordion items={items} />
        <Accordion items={items} />
      </>
    );
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-controls]'));
    expect(new Set(buttons.map((b) => b.id)).size).toBe(4);
    expect(buttons.every((b) => b.type === 'button')).toBe(true);

    // Second accordion's first header: ArrowDown goes to its own second one.
    focus(buttons[2]);
    key(buttons[2], 'ArrowDown');
    expect(document.activeElement).toBe(buttons[3]);
  });

  it('does not clip a tall panel or wrap the group in an unnamed region', () => {
    const { container } = mount(<Accordion items={items} defaultOpenKeys={['one']} />);
    const panel = container.querySelector<HTMLElement>('[role="region"]')!;
    expect(panel.style.maxHeight).toBe('');
    expect((container.firstElementChild as HTMLElement).getAttribute('role')).toBeNull();
    expect(panel.hidden).toBe(false);
  });

  it('uses the heading level it is given', () => {
    const { container } = mount(<Accordion items={items} headingLevel={2} />);
    expect(container.querySelectorAll('h2')).toHaveLength(2);
  });
});

describe('Collapse', () => {
  it('does not animate a panel that starts closed, and takes it out of the tab order', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    const { container } = mount(
      <Collapse isOpen={false}>
        <a href="#x">Hidden link</a>
      </Collapse>
    );
    const panel = container.firstElementChild as HTMLElement;
    expect(raf).not.toHaveBeenCalled();
    expect(panel.style.height).toBe('0px');
    expect(panel.style.visibility).toBe('hidden');
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    raf.mockRestore();
  });

  it('is visible and exposed when open', () => {
    const { container } = mount(<Collapse isOpen>Shown</Collapse>);
    const panel = container.firstElementChild as HTMLElement;
    expect(panel.style.visibility).toBe('visible');
    expect(panel.getAttribute('aria-hidden')).toBeNull();
  });
});

describe('Alert and Toast announcements', () => {
  it('announces errors and warnings at once, and news politely', () => {
    const { container } = mount(
      <>
        <Alert variant="info">Heads up</Alert>
        <Alert variant="success">Saved</Alert>
        <Alert variant="warning">Careful</Alert>
        <Alert variant="error">Failed</Alert>
        <Alert variant="error" role="none">
          Static
        </Alert>
      </>
    );
    const roles = Array.from(container.children).map((el) => el.getAttribute('role'));
    expect(roles).toEqual(['status', 'status', 'alert', 'alert', null]);
  });

  it('does not tint an alert with steps App never defines', () => {
    const { container } = mount(<Alert variant="warning">Careful</Alert>);
    const alert = container.firstElementChild as HTMLElement;
    expect(alert.getAttribute('style')).not.toMatch(/warning-50\b|warning-700|fffbeb/);
  });

  it('gives a toast one role that matches its urgency', () => {
    const { container } = mount(
      <>
        <Toast variant="success" message="Saved" duration={0} />
        <Toast variant="error" message="Failed" duration={0} />
      </>
    );
    const toasts = Array.from(container.querySelectorAll('[aria-atomic]'));
    expect(toasts.map((t) => t.getAttribute('role'))).toEqual(['status', 'alert']);
    expect(toasts.some((t) => t.hasAttribute('aria-live'))).toBe(false);
  });

  it('holds a toast open while keyboard focus is inside it', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    mount(<Toast message="Saved" duration={1000} onClose={onClose} />);
    focus(button('Close'));
    act(() => vi.advanceTimersByTime(3000));
    expect(onClose).not.toHaveBeenCalled();

    act(() => button('Close').blur());
    act(() => vi.advanceTimersByTime(1200));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Breadcrumb', () => {
  it('is an ordered list with hidden separators, and a clickable step is a button', () => {
    const onHome = vi.fn();
    const { container } = mount(
      <Breadcrumb items={[{ label: 'Home', onClick: onHome }, { label: 'Docs', href: '/docs' }, { label: 'Page' }]} />
    );
    expect(container.querySelectorAll('nav ol > li')).toHaveLength(3);
    const separators = Array.from(container.querySelectorAll('li > span:first-child')).filter((s) => s.textContent === '/');
    expect(separators).toHaveLength(2);
    expect(separators.every((s) => s.getAttribute('aria-hidden') === 'true')).toBe(true);

    const home = button('Home');
    expect(home.type).toBe('button');
    click(home);
    expect(onHome).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('Page');
  });
});

describe('NavItem', () => {
  it('marks the current page and names a collapsed item from its text', () => {
    mount(
      <NavItem active collapsed icon="home">
        <strong>Dashboard</strong>
      </NavItem>
    );
    const item = document.querySelector('button')!;
    expect(item.getAttribute('aria-current')).toBe('page');
    expect(item.getAttribute('aria-label')).toBe('Dashboard');
    expect(item.getAttribute('title')).toBe('Dashboard');
    expect(item.getAttribute('data-label')).toBe('Dashboard');
    expect(document.querySelector('style')?.textContent).toContain(':focus-visible::after');
  });
});

describe('EmptyState', () => {
  it('hides its decorative icon and stops the float under reduced motion', () => {
    const { container } = mount(<EmptyState title="Nothing here" animated />);
    expect(container.querySelector('.softn-empty-icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('style')?.textContent).toContain('prefers-reduced-motion');
  });
});
