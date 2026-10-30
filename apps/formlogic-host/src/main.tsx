import React, { Component } from 'react';
import { createRoot } from 'react-dom/client';
import { SoftNWithXDB, composeBundleSource, configureZippWasmSource, getXDB, parseXDBFile, seedXDBBundleData, zippLanguages } from '@softn/core';
import { registerRuntimeComponents } from '@softn/components/lazy';
import { ThemeProvider } from '@softn/components/theme';
import { declaredThemeMode } from './appTheme';
import { installAppStorage, STORAGE_LIMITS, STORAGE_PROTOCOL } from './storage';
import { createBackendQueue, BACKEND_UNREADABLE } from './backendQueue';
import { acceptEngine, acceptZippBytes, bundleLanguages, documentEngines, readyEngines, requireBundleLanguages, requireEngineLanguages, servableEngines, zippIdentities } from './engineInit';
import { createNativeNetFetch } from './nativeFetch';
import { framePolicy } from './framePolicy';
import { mediaUrl } from './media';
import { seedBundledData } from './seed';
import zippSource from '../../../packages/@softn/core/wasm-zipp/SOURCE.json';

// This shell is trusted code, run in an opaque-origin iframe. The parent owns
// authentication and accepts only named action calls for the selected app.
// Which document this is comes first: the policy depends on it, a meta policy
// can be tightened afterwards but never relaxed, and the same list decides what
// `init` is accepted and what `ready` announces. Nothing the parent sends is
// read before this point.
//
// The ZIPP engines are named by the installed release: the web-python build
// is the install itself, and the JavaScript-only web build is its
// `variants.web`, verified against the same SHA256SUMS. A ZIPP id the install
// cannot name (a local engine build has no variant) is neither accepted nor
// announced, by the one filter, so the two lists cannot disagree.
const identities = zippIdentities(zippSource);
const served = servableEngines(documentEngines(document.documentElement.getAttribute('data-softn-logic-engine')), identities);
// Pin all loading to this trusted runtime directory before accepting app source.
const policy = document.createElement('meta');
policy.httpEquiv = 'Content-Security-Policy';
const assets = new URL('./', document.baseURI).href;
policy.content = framePolicy(assets, served);
document.head.appendChild(policy);
registerRuntimeComponents();
const root = createRoot(document.getElementById('root')!);
root.render(<p style={{ padding: 24, fontFamily: 'system-ui' }}>Opening app…</p>);
let started = false;
let port: MessagePort | undefined;
let appStorage: ReturnType<typeof installAppStorage> | undefined;
let terminated = false;
// Four calls at a time to the parent, which is the parent's own limit,
// thirty-two waiting behind them. A slot is the parent's until it answers (see
// backendQueue.ts). The parent validates every call on its side.
//
// Thirty-five seconds for an answer, longer than FormLogic gives a native
// app's request on its server (twenty-five): at twenty, a write that committed
// in its last five seconds reached the app as a failure, and an app that tried
// again made it twice.
const CALL_DEADLINE_MS = 35000;
const calls = createBackendQueue({
  post: message => port!.postMessage(message),
  maxInFlight: 4, maxQueued: 32, timeoutMs: CALL_DEADLINE_MS,
});
/**
 * The native app's storage saves, in a lane of their own, where the parent
 * says it takes them apart from its four calls (`init.storageLane`). In the
 * shared lane a screen whose own calls filled the four slots and the
 * thirty-two places behind them had its save refused as busy, and that failed
 * save held the app's imports and restores until it was opened again. Its ids
 * start far past any call's, so a reply names one call in one lane.
 */
let storageCalls: ReturnType<typeof createBackendQueue> | undefined;
const STORAGE_FIRST_ID = 1_000_000_000;
function backendCall(action: string, input: Record<string, unknown>): Promise<unknown> {
  if (!port || terminated) return Promise.resolve({ error: 'The app is not connected to its backend yet.' });
  return calls.call(action, input);
}
function terminate(): void {
  if (terminated) return;
  terminated = true;
  appStorage?.dispose();
  calls.dispose(BACKEND_UNREADABLE);
  storageCalls?.dispose(BACKEND_UNREADABLE);
  port?.close();
  root.unmount();
}
// A page kept in the back/forward cache comes back as it was, port and all;
// only one that is going for good ends (a terminated frame takes no new init).
window.addEventListener('pagehide', event => { if (!event.persisted) terminate(); });
const LOAD_FAILED = 'This app could not be loaded. Check the interface and logic files.';
/** One line the app author can act on; never the stack, never more than a sentence. */
function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return text.split('\n')[0].slice(0, 300);
}
/**
 * `phase` says whether the app failed to open (`load`: nothing of it is shown) or failed while
 * running (`runtime`: it is still drawn, and its own error shows inside it). A parent that showed
 * "could not load" for every error put that over a working app. `reason` and `phase` are
 * additions to the protocol; a parent that reads only `type` is unaffected.
 */
function reportError(reason: string, phase: 'load' | 'runtime'): void {
  port?.postMessage({ type: 'error', reason, phase });
}
class Boundary extends Component<{ children: React.ReactNode }, { failed: boolean; reason: string }> {
  state = { failed: false, reason: '' };
  static getDerivedStateFromError(error: unknown) { return { failed: true, reason: reasonOf(error) }; }
  // The app is replaced by the message below: it is no longer shown, which is a load failure.
  componentDidCatch(error: unknown) { reportError(reasonOf(error), 'load'); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <p role="alert">{LOAD_FAILED}{this.state.reason ? ` (${this.state.reason})` : ''}</p>;
  }
}
window.addEventListener('message', async event => {
  if (started || terminated || event.source !== parent || event.data?.type !== 'formlogic:init' || !event.ports[0]) return;
  started = true;
  port = event.ports[0];
  if (event.data.storageLane === true) {
    storageCalls = createBackendQueue({
      post: message => port!.postMessage(message),
      // One save at a time, as the storage sends them, and as many waiting as it may hold.
      maxInFlight: 1, maxQueued: STORAGE_LIMITS.outstanding, timeoutMs: STORAGE_LIMITS.deadline,
      firstId: STORAGE_FIRST_ID,
    });
  }
  port.onmessage = event => {
    if (event.data?.type === 'formlogic:dispose') { terminate(); return; }
    if (!calls.settle(event.data?.id, event.data?.result)) storageCalls?.settle(event.data?.id, event.data?.result);
  };
  // A result the port could not deserialise names no id: nothing in flight
  // can be told apart, so all of it answers now rather than at its deadline.
  // The app goes on: an acknowledged (protocol 1) storage write sent before it
  // is marked unknown, which holds later ones back, so nothing is claimed
  // saved that may not be.
  port.onmessageerror = () => { calls.failInFlight(BACKEND_UNREADABLE); storageCalls?.failInFlight(BACKEND_UNREADABLE); };
  try {
    // `engine` is an addition: absent means the engine this document has always
    // run, so a FormLogic that predates the choice is unaffected. One it does
    // not serve is refused by name, never quietly replaced.
    const engine = acceptEngine(event.data.engine, served);
    const files = new Map<string, string>(Object.entries(event.data.client));
    // What this app's logic is written in, from its client file names, and the
    // engine held to it before anything is configured. Neither `zipp-web` nor
    // `host-js` can execute Python at all, and configuring an engine is a
    // one-way door — `configureLogicEngine` and `configureZippWasmSource` both
    // freeze — so the refusal has to come first or it comes too late.
    const languages = bundleLanguages(files.keys());
    requireBundleLanguages(engine, languages);
    if (engine === 'host-js') {
      // Host JavaScript is this document's own engine, so there are no engine
      // bytes to accept and nothing to ask what it can run. The host entry —
      // not this module — checks that the document really is the host one and
      // that the frame really has the opaque origin the shell is only safe in,
      // and configures the engine before anything renders. It is imported here
      // rather than at the top so the adapter is in a chunk of its own that
      // `index.html` never loads.
      const { installHostJsEngine } = await import('./hostEngine');
      if (terminated) return;
      installHostJsEngine();
    } else {
      configureZippWasmSource(acceptZippBytes(event.data.zippWasm));
      // Ask the engine that actually loaded what it can run, before any app code
      // does. ZIPP's builds share one glue, so the id the parent named and the
      // bytes it sent are only known to agree once the engine answers — and
      // they must agree exactly: `zipp-web` is the build that runs JavaScript
      // and nothing else, and the Python build posted under that name is
      // refused as firmly as the reverse.
      requireEngineLanguages(engine, await zippLanguages());
    }
    if (terminated) return;
    const manifest = JSON.parse(files.get('manifest.json') || '{}');
    let drawn = false;
    // Set for a native app; undefined otherwise, where `softn.net.fetch` is
    // refused like every other permission.
    let netFetchHandler: ReturnType<typeof createNativeNetFetch> | undefined;
    if (event.data.native === true) {
      const lane = storageCalls ?? calls;
      appStorage = installAppStorage(event.data.storage || {}, (input, lifecycle) => lane.call('nativeStorage', input, lifecycle), { acknowledged: event.data.storageProtocol === STORAGE_PROTOCOL });
      // The app's source is left as it came. Its declared API origin is routed
      // by the trusted parent to this app's native backend, without direct
      // egress, from the first line of logic that runs (nativeFetch.ts).
      netFetchHandler = createNativeNetFetch(backendCall);
    }
    const media = new Map<string, string>();
    for (const [path, value] of Object.entries(event.data.assets || {})) {
      const url = mediaUrl(path, value);
      if (url) media.set(path, url);
    }
    const resolveAsset = (path: string) => media.get(path.replace(/^\.\//, '')) || '';
    const composed = composeBundleSource(files, manifest.main, manifest.files?.logic || []);
    // The records the app ships with, added once, before it first draws (seed.ts).
    const seeding = await seedBundledData(files, manifest, getXDB(event.data.appId), parseXDBFile, seedXDBBundleData, () => !terminated);
    if (terminated) return;
    for (const warning of seeding.warnings) console.warn(`[SoftN] ${warning}`);
    // A bundle's permission.json cannot enable arbitrary network, hardware or sync access.
    // FormLogic's own theme, and the side the project declares, which wins over it (appTheme.ts).
    root.render(<Boundary><ThemeProvider defaultDarkMode={event.data.dark === true} declaredMode={declaredThemeMode(manifest)}>
      <SoftNWithXDB {...composed} appId={event.data.appId} resumeSavedSyncRoom={false}
        permissionConfig={{ permissions: {} }} scriptExecutionMode="main"
        assetResolver={resolveAsset} functions={{asset: (...args: unknown[]) => resolveAsset(String(args[0] ?? ""))}}
        backendCall={backendCall} netFetchHandler={netFetchHandler}
        importResolver={async path => files.get(path.replace(/^\//, '')) ?? null}
        // Before its first page is drawn the app has not opened; after it, it is drawn and
        // what went wrong shows inside it.
        onLoad={() => { drawn = true; }}
        onError={error => reportError(reasonOf(error), drawn ? 'runtime' : 'load')} />
    </ThemeProvider></Boundary>);
  } catch (error) {
    if (terminated) return;
    const reason = reasonOf(error);
    root.render(<p role="alert" style={{ padding: 24 }}>{LOAD_FAILED}{reason ? ` (${reason})` : ''}</p>);
    reportError(reason, 'load');
  }
});
// `zipp` is the primary engine's identity, exactly what it has always been:
// FormLogic compares version and sha256; release is an addition, and optional
// because a local engine build (--install-local) records none.
// engines is an addition too: the engine ids this document will accept in
// `init.engine`, each with the bytes it wants — the same record with the
// variant's digest for `zipp-web`, `true` where it wants none. A parent that
// reads only `zipp` and sends no `engine` sees what it always did, which on
// this document's other entry is a refusal by name.
parent.postMessage({ type: 'formlogic:ready', nativeProtocol: 1, storageProtocol: STORAGE_PROTOCOL, zipp: identities['zipp-web-python'], engines: readyEngines(served, identities) }, '*');
