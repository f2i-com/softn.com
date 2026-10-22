/**
 * CopyButton.
 *
 * Seven of the example pages have a button that copies something: a room
 * code, an address, an export. Each is a logic function that calls the
 * clipboard, a second state variable for "Copied", and a timer to put the
 * label back. This is that button. It writes the text it is given when it
 * is pressed, says so for a moment, to the eye and to a screen reader, and
 * says so when the browser refuses.
 *
 * An app's script may be denied the clipboard by its manifest. A component
 * runs in the page, beside the script and not inside its sandbox, so it asks
 * the app it is in: where the script may not copy, neither does this.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { AppScopeProvider, ComponentRegistry, parse, renderDocument, type AppScope, type SoftNComponent, type SoftNRenderContext } from '@softn/core';
import { click, mount } from './dom';
import { builtinComponents } from '../src/registry';
import { CopyButton } from '../src/form/CopyButton';

let written: string[] = [];
let refuse = false;

beforeEach(() => {
  written = [];
  refuse = false;
  vi.useFakeTimers();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        if (refuse) return Promise.reject(new Error('NotAllowedError'));
        written.push(text);
        return Promise.resolve();
      },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Let the write's promise settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const button = (root: ParentNode) => root.querySelector('button') as HTMLButtonElement;
const status = (root: ParentNode) => root.querySelector('[role="status"]')?.textContent ?? '';

describe('CopyButton', () => {
  it('copies the text it is given, and says so for a moment', async () => {
    const onCopy = vi.fn();
    const { container, unmount } = mount(<CopyButton value="ROOM-4821" onCopy={onCopy} />);
    expect(button(container).textContent).toBe('Copy');
    click(button(container));
    await settle();
    expect(written).toEqual(['ROOM-4821']);
    expect(onCopy).toHaveBeenCalledWith('ROOM-4821');
    expect(button(container).textContent).toBe('Copied');
    expect(status(container)).toBe('Copied');

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(button(container).textContent).toBe('Copy');
    expect(status(container)).toBe('');
    unmount();
  });

  it('copies a number as its digits, and what it is given last', async () => {
    const { container, rerender, unmount } = mount(<CopyButton value={42} />);
    rerender(<CopyButton value={43} />);
    click(button(container));
    await settle();
    expect(written).toEqual(['43']);
    unmount();
  });

  it('has nothing to copy without a value, and cannot be pressed', () => {
    for (const value of [undefined, null, '']) {
      const { container, unmount } = mount(<CopyButton value={value} />);
      expect(button(container).disabled).toBe(true);
      unmount();
    }
  });

  it('says so when the browser refuses, and does not say it copied', async () => {
    refuse = true;
    const onError = vi.fn();
    const { container, unmount } = mount(<CopyButton value="x" onError={onError} />);
    // No older way to copy either.
    document.execCommand = () => false;
    click(button(container));
    await settle();
    expect(button(container).textContent).toBe('Could not copy');
    expect(status(container)).toBe('Could not copy');
    expect(onError).toHaveBeenCalledTimes(1);
    unmount();
  });

  // The older way is the usual one on a plain-HTTP deployment, which has no
  // navigator.clipboard; a copy that threw left the text in the page.
  it('leaves nothing in the page when the older way throws', async () => {
    refuse = true;
    const { container, unmount } = mount(<CopyButton value="ROOM-SECRET" />);
    document.execCommand = () => {
      throw new Error('not supported');
    };
    click(button(container));
    await settle();
    expect(document.querySelector('textarea')).toBeNull();
    expect(button(container).textContent).toBe('Could not copy');
    unmount();
  });

  it('takes its own words', async () => {
    const { container, unmount } = mount(<CopyButton value="x" label="Copy link" copiedLabel="Link copied" resetAfter={500} />);
    expect(button(container).textContent).toBe('Copy link');
    click(button(container));
    await settle();
    expect(button(container).textContent).toBe('Link copied');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(button(container).textContent).toBe('Copy link');
    unmount();
  });

  it('as an icon alone still has a name, which changes when it has copied', async () => {
    const { container, unmount } = mount(<CopyButton value="x" iconOnly />);
    expect(button(container).textContent).toBe('');
    expect(button(container).getAttribute('aria-label')).toBe('Copy');
    click(button(container));
    await settle();
    expect(button(container).getAttribute('aria-label')).toBe('Copied');
    unmount();
  });

  it('does not copy in an app that is denied the clipboard, and says why', async () => {
    const scope = { xdb: {}, active: true, clipboard: false } as unknown as AppScope;
    const { container, unmount } = mount(
      <AppScopeProvider value={scope}>
        <CopyButton value="secret" />
      </AppScopeProvider>
    );
    expect(button(container).disabled).toBe(true);
    expect(button(container).title).toMatch(/not allowed to use the clipboard/);
    click(button(container));
    await settle();
    expect(written).toEqual([]);
    unmount();
  });

  it('stops its timer when it is taken off the page', async () => {
    const { container, unmount } = mount(<CopyButton value="x" />);
    click(button(container));
    await settle();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('<CopyButton> in a page', () => {
  it('copies what its value comes to, and calls @copy', async () => {
    const registry = new ComponentRegistry();
    registry.registerAll(builtinComponents as unknown as Record<string, SoftNComponent>);
    const noted = vi.fn();
    const doc = parse('<CopyButton value={"softn://room/" + room} label="Copy invite" @copy={noted} />');
    expect(doc.diagnostics ?? []).toEqual([]);
    const context = { state: { room: 'A7' }, setState: () => {}, data: {}, props: {}, computed: {}, functions: { noted }, asyncFunctions: {} } as unknown as SoftNRenderContext;
    const { container, unmount } = mount(<>{renderDocument(doc, context, registry)}</>);
    click(button(container));
    await settle();
    expect(written).toEqual(['softn://room/A7']);
    expect(noted).toHaveBeenCalledWith('softn://room/A7');
    unmount();
  });
});
