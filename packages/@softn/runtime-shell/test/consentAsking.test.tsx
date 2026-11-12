// @vitest-environment jsdom
/**
 * The bar and the app it is over, told about each other.
 *
 * A host that runs an app with `withheldPermissions(declared, { asking: true })`
 * has what the app asks for kept until the person answers, so that what they
 * pressed is done when they allow it. That is only right while there is a bar
 * to answer: "Not now" must turn it off at once, "Review permissions" back
 * on, and the config must grant nothing either way.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionBar } from '../src/PermissionBar';
import { withheldPermissions } from '../src/consent';

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
  vi.unstubAllGlobals();
});

const declared = { app: { name: 'Notes' }, permissions: { net: { enabled: true, allowed_hosts: ['api.example.com'] }, files: { enabled: true } } };

function button(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

describe('withheldPermissions', () => {
  it('grants nothing, asking or not', () => {
    for (const config of [withheldPermissions(declared), withheldPermissions(declared, { asking: true }), withheldPermissions(declared, { asking: false })]) {
      expect(config.permissions).toEqual({});
      expect(config.consentPending).toBe(true);
    }
  });

  it('names what the bar is asking for only when it is asking', () => {
    expect(withheldPermissions(declared, { asking: true }).consentAsking).toEqual(['net', 'files']);
    expect('consentAsking' in withheldPermissions(declared)).toBe(false);
    expect('consentAsking' in withheldPermissions(declared, { asking: false })).toBe(false);
  });

  it('is what it was for a host that says nothing of asking', () => {
    expect(withheldPermissions(declared)).toEqual({ app: { name: 'Notes' }, permissions: {}, consentPending: true });
  });
});

describe('PermissionBar', () => {
  const bar = (props: Partial<React.ComponentProps<typeof PermissionBar>> = {}) => (
    <PermissionBar appName="Notes" config={declared} capabilities={['net', 'files']} onAllow={() => {}} {...props} />
  );

  it('tells the host when it is put away and when it is brought back', () => {
    const asking: boolean[] = [];
    act(() => root.render(bar({ onAsking: (value) => asking.push(value) })));
    expect(asking).toEqual([]);
    act(() => button('Not now').click());
    expect(asking).toEqual([false]);
    act(() => button('Review permissions').click());
    expect(asking).toEqual([false, true]);
  });

  it('says the app is waiting for the answer, and for what', () => {
    act(() => root.render(bar({ waiting: ['net'] })));
    expect(host.querySelector('[data-softn-consent-waiting]')?.textContent?.trim()).toBe('It is waiting for your answer to use the internet.');
    act(() => root.render(bar({ waiting: [] })));
    expect(host.querySelector('[data-softn-consent-waiting]')).toBeNull();
  });

  it('says, before it is pressed, that allowing starts the app again', () => {
    act(() => root.render(bar()));
    expect(host.querySelector('[data-softn-consent-restart]')).toBeNull();
    act(() => root.render(bar({ restartOnAllow: true })));
    expect(host.querySelector('[data-softn-consent-restart]')?.textContent?.trim()).toBe('Allowing starts it again.');
  });
});
