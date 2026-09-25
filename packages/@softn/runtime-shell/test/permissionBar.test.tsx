// @vitest-environment jsdom
/**
 * The consent bar every host shares. Its wording and grant rules are pinned by
 * the hosts' own tests (apps/softn-web, apps/softn-loader, single-shell); this
 * pins what only the component can: where focus goes.
 */
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionBar, DESKTOP_WORDING } from '../src/PermissionBar';
import { diffCapabilities, grantCovers, grantKey, grantRecord, hasSavedGrant, saveGrant } from '../src/consent';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const config = { permissions: { net: { enabled: true } } };

/** A host: an app with a text field, and the bar above it until Allow. */
function Host({ onAllowed }: { onAllowed?: () => void }) {
  const [pending, setPending] = useState(true);
  const appRoot = useRef<HTMLDivElement>(null);
  return (
    <div ref={appRoot} tabIndex={-1} data-testid="app-root">
      {pending && (
        <PermissionBar
          appName="Notes"
          config={config}
          capabilities={['net']}
          appRootRef={appRoot}
          onAllow={() => {
            setPending(false);
            onAllowed?.();
          }}
        />
      )}
      <input aria-label="Title" defaultValue="hello world" />
      <button type="button">Other</button>
    </div>
  );
}

function button(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

describe('PermissionBar', () => {
  it('takes no focus on arrival', () => {
    act(() => root.render(<Host />));
    expect(document.activeElement).toBe(document.body);
  });

  it('puts focus back in the field the app had, caret included, after Allow', () => {
    act(() => root.render(<Host />));
    const input = host.querySelector('input')!;
    act(() => input.focus());
    input.setSelectionRange(3, 5);
    act(() => button('Allow').focus());
    act(() => button('Allow').click());
    expect(host.querySelector('.softn-consent-bar')).toBeNull();
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 5]);
  });

  it('falls back to the app root, not <body>, when nothing in the app had focus', () => {
    act(() => root.render(<Host />));
    act(() => button('Allow').focus());
    act(() => button('Allow').click());
    expect(document.activeElement).toBe(host.querySelector('[data-testid="app-root"]'));
  });

  it('moves no focus when it goes away for any reason other than Allow', () => {
    act(() => root.render(<Host />));
    const other = button('Other');
    act(() => other.focus());
    act(() => root.render(<div />));
    expect(document.activeElement).toBe(document.body);
  });

  it('folds to a labelled strip on Not now, and back', () => {
    act(() => root.render(<Host />));
    act(() => button('Not now').click());
    expect(host.querySelector('.softn-consent-bar')).toBeNull();
    const chip = button('Review permissions');
    expect(document.activeElement).toBe(chip);
    act(() => chip.click());
    expect(host.querySelector('.softn-consent-bar')).not.toBeNull();
    expect(document.activeElement).toBe(button('What this means'));
  });

  it('opens the detail dialog with focus on Not now, and Allow there grants and returns focus', () => {
    const allowed = vi.fn();
    act(() => root.render(<Host onAllowed={allowed} />));
    act(() => button('What this means').click());
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain('Network access');
    expect(document.activeElement?.textContent).toBe('Not now');
    const allow = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Allow')!;
    act(() => allow.click());
    expect(allowed).toHaveBeenCalledOnce();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('[data-testid="app-root"]'));
  });

  it("speaks the host's words where they differ", () => {
    act(() =>
      root.render(
        <PermissionBar
          appName="Notes"
          config={{ permissions: { storage: { enabled: true }, camera: { enabled: true } } }}
          capabilities={['storage', 'camera']}
          wording={DESKTOP_WORDING}
          onAllow={() => {}}
        />,
      ),
    );
    expect(host.textContent).toContain('This app wants to use its own shared database online and pictures from your camera.');
    expect(host.textContent).not.toContain('on this site');
    act(() => button('What this means').click());
    expect(host.textContent).toContain('Your system may ask you separately');
    expect(host.textContent).not.toContain('Your browser');
  });

  it('says what an update newly asks for', () => {
    act(() =>
      root.render(
        <PermissionBar
          appName="Notes"
          config={{ permissions: { net: { enabled: true }, files: { enabled: true } } }}
          capabilities={['net', 'files']}
          previous={{ version: '1.0.0', capabilities: ['net'] }}
          onAllow={() => {}}
        />,
      ),
    );
    expect(host.textContent).toContain('New since v1.0.0: your files.');
  });
});

describe('consent', () => {
  it('keys a grant by identity and declaration, under the host prefix', () => {
    const a = grantKey('abc', config, 'softn-loader:grant:');
    expect(a).toBe(`softn-loader:grant:abc:${JSON.stringify(config)}`);
    expect(grantKey('abc', { permissions: { net: { enabled: true, allowed_hosts: ['x.test'] } } }, 'p:')).not.toBe(grantKey('abc', config, 'p:'));
    expect(hasSavedGrant(a)).toBe(false);
    saveGrant(a);
    expect(hasSavedGrant(a)).toBe(true);
  });

  it('covers a request only with every capability recorded as true', () => {
    expect(grantCovers(undefined, [])).toBe(true);
    expect(grantCovers(undefined, ['net'])).toBe(false);
    expect(grantCovers({ net: 'true' }, ['net'])).toBe(false);
    expect(grantCovers(grantRecord(['net', 'files']), ['net', 'files'])).toBe(true);
    expect(grantCovers(grantRecord(['net']), ['net', 'files'])).toBe(false);
  });

  it('diffs two builds', () => {
    expect(diffCapabilities(['net', 'files'], ['net', 'camera'])).toEqual({ added: ['files'], removed: ['camera'] });
  });
});
