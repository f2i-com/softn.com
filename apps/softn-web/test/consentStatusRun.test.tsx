/** @vitest-environment jsdom */
/**
 * What an app was waiting on the permission bar for belongs to the run that
 * asked. The renderer says so when it changes (onConsentStatus), and a run
 * started afresh in the same tab (another page of the bundle after a link,
 * the tab opened again by the editor) has kept nothing. The runner held on to
 * the last run's word: the bar went on saying the app was waiting, and since
 * the new run had nothing to say, it said it for good, after Allow too, when
 * the app's own backend went on refusing every request as "withheld until
 * permissions are approved".
 */
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsentRequest } from '@softn/runtime-shell/PermissionBar';

type Given = { source: string; onLink: (href: string) => boolean; onConsentStatus?: (status: { waiting: string[]; restartOnAllow: boolean }) => void };
let given: Given;
/** What each renderer that mounts says first, in turn: one entry per run. */
let firstWords: Array<{ waiting: string[]; restartOnAllow: boolean } | null> = [];

vi.mock('@softn/core', async (original) => ({
  ...(await original<typeof import('@softn/core')>()),
  SoftNWithXDB: (props: Given) => {
    given = props;
    useEffect(() => {
      const said = firstWords.shift();
      if (said) props.onConsentStatus?.(said);
      // Said once, when the run starts, as a renderer says what it has kept.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <main>{props.source}</main>;
  },
}));

let consentPending: (() => boolean) | undefined;
vi.mock('@softn/runtime-shell/uiBackendBridge', () => ({
  hasEmbeddedBackend: () => true,
  createUiBackendBridge: (options: { isConsentPending?: () => boolean }) => {
    consentPending = options.isConsentPending;
    return { netFetchHandler: async () => null, activate: () => {}, dispose: () => {} };
  },
}));

import { AppRunner } from '../src/components/AppRunner';

const manifest = JSON.stringify({ id: 'local.site', name: 'Site', version: '1.0.0', main: 'index.html', backend: { entry: 'server.js' } });
const textFiles = new Map([
  ['manifest.json', manifest],
  ['index.html', '<h1>Home</h1>'],
  ['pages/about.html', '<h1>About us</h1>'],
]);

const consent: ConsentRequest = {
  config: { permissions: { net: { enabled: true } } },
  capabilities: ['net'],
  appName: 'Site',
  onAllow: () => {},
  onAsking: () => {},
} as unknown as ConsentRequest;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  firstWords = [];
  consentPending = undefined;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const waitingSaid = (): string | null => container.querySelector('[data-softn-consent-waiting]')?.textContent ?? null;

describe('what the app was waiting on the bar for', () => {
  it('is the run’s that asked: a page a link opened has kept nothing, and after Allow nothing is withheld', async () => {
    // The first run asks for the internet while the bar is up; the next says nothing.
    firstWords = [{ waiting: ['net'], restartOnAllow: true }, null];
    const draw = (withConsent: boolean) =>
      root.render(
        <AppRunner source="the home page" appName="Site" appId="site" active textFiles={textFiles} consent={withConsent ? consent : undefined} permissionConfig={{ permissions: {} }} />
      );
    await act(async () => draw(true));
    expect(waitingSaid()).toContain('waiting for your answer');

    // Another page of the app: a run of its own.
    await act(async () => {
      given.onLink('pages/about.html');
    });
    expect(given.source).toContain('About us');
    expect(waitingSaid()).toBeNull();

    // Allowed: the app's backend is not held back for an answer given.
    await act(async () => draw(false));
    expect(consentPending?.()).toBe(false);
  });

  it('is the run’s that asked: the tab opened again starts with nothing kept', async () => {
    firstWords = [{ waiting: ['net'], restartOnAllow: true }, null];
    const draw = (source: string) =>
      root.render(<AppRunner source={source} appName="Site" appId="site" active textFiles={textFiles} consent={consent} permissionConfig={{ permissions: {} }} />);
    await act(async () => draw('the home page'));
    expect(waitingSaid()).toContain('waiting for your answer');
    // Emptied, and opened again in the same tab (lib/reopenTab.ts).
    await act(async () => draw(''));
    await act(async () => draw('the home page'));
    expect(waitingSaid()).toBeNull();
  });
});
