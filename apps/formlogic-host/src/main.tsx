import React, { Component } from 'react';
import { createRoot } from 'react-dom/client';
import { SoftNWithXDB, composeBundleSource, configureZippWasmSource, zippLanguages } from '@softn/core';
import { registerRuntimeComponents } from '@softn/components/lazy';
import { ThemeProvider } from '@softn/components/theme';
import { installAppStorage } from './storage';
import { createBackendQueue, BACKEND_UNREADABLE } from './backendQueue';
import { acceptEngine, acceptZippBytes, bundleLanguages, documentEngines, readyEngines, requireBundleLanguages, requireEngineLanguages, servableEngines, zippIdentities } from './engineInit';
import { NATIVE_FETCH_BRIDGE, createNativeNetFetch, nativeFetchRoute } from './nativeFetch';
import { framePolicy } from './framePolicy';
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
// Four calls at a time to the parent, thirty-two waiting behind them, twenty
// seconds each once sent. The parent validates every call on its side.
const calls = createBackendQueue({
  post: message => port!.postMessage(message),
  maxInFlight: 4, maxQueued: 32, timeoutMs: 20000,
});
function backendCall(action: string, input: Record<string, unknown>): Promise<unknown> {
  if (!port) return Promise.resolve({ error: 'The app is not connected to its backend yet.' });
  return calls.call(action, input);
}
const LOAD_FAILED = 'This app could not be loaded. Check the interface and logic files.';
/** One line the app author can act on; never the stack, never more than a sentence. */
function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return text.split('\n')[0].slice(0, 300);
}
function reportError(reason: string): void {
  // `reason` is an addition to the protocol; a parent that reads only `type` is unaffected.
  port?.postMessage({ type: 'error', reason });
}
class Boundary extends Component<{ children: React.ReactNode }, { failed: boolean; reason: string }> {
  state = { failed: false, reason: '' };
  static getDerivedStateFromError(error: unknown) { return { failed: true, reason: reasonOf(error) }; }
  componentDidCatch(error: unknown) { reportError(reasonOf(error)); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <p role="alert">{LOAD_FAILED}{this.state.reason ? ` (${this.state.reason})` : ''}</p>;
  }
}
window.addEventListener('message', async event => {
  if (started || event.source !== parent || event.data?.type !== 'formlogic:init' || !event.ports[0]) return;
  started = true;
  port = event.ports[0];
  port.onmessage = event => { calls.settle(event.data?.id, event.data?.result); };
  // A result the port could not deserialise names no id: nothing in flight
  // can be told apart, so all of it answers now rather than at its deadline.
  port.onmessageerror = () => { calls.failInFlight(BACKEND_UNREADABLE); };
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
    const manifest = JSON.parse(files.get('manifest.json') || '{}');
    // Set for a native app whose logic the `<logic>` bridge below cannot be
    // written in; undefined otherwise, which is every app that runs today.
    let netFetchHandler: ReturnType<typeof createNativeNetFetch> | undefined;
    if (event.data.native === true) {
      installAppStorage(event.data.storage || {}, input => backendCall("nativeStorage", input));
      // Keep stored app source untouched. Its declared API origin is routed by
      // the trusted parent to this app's native backend, without direct egress.
      if (nativeFetchRoute(languages) === 'host-handler') {
        netFetchHandler = createNativeNetFetch(backendCall);
      } else {
        const entry = String(manifest.main);
        files.set(entry, NATIVE_FETCH_BRIDGE + (files.get(entry) || ''));
      }
    }
    const media = new Map<string, string>();
    const types: Record<string,string> = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', webp:'image/webp', gif:'image/gif', svg:'image/svg+xml', wav:'audio/wav', mp3:'audio/mpeg', ogg:'audio/ogg', woff:'font/woff', woff2:'font/woff2' };
    for (const [path, value] of Object.entries(event.data.assets || {})) {
      const type = types[path.split('.').pop()?.toLowerCase() || ''];
      if (type && typeof value === 'string') media.set(path, `data:${type};base64,${value}`);
    }
    const resolveAsset = (path: string) => media.get(path.replace(/^\.\//, '')) || '';
    const composed = composeBundleSource(files, manifest.main, manifest.files?.logic || []);
    // A bundle's permission.json cannot enable arbitrary network, hardware or sync access.
    root.render(<Boundary><ThemeProvider defaultDarkMode={event.data.dark === true}>
      <SoftNWithXDB {...composed} appId={event.data.appId} resumeSavedSyncRoom={false}
        permissionConfig={{ permissions: {} }} scriptExecutionMode="main"
        assetResolver={resolveAsset} functions={{asset: (...args: unknown[]) => resolveAsset(String(args[0] ?? ""))}}
        backendCall={backendCall} netFetchHandler={netFetchHandler}
        importResolver={async path => files.get(path.replace(/^\//, '')) ?? null}
        onError={error => reportError(reasonOf(error))} />
    </ThemeProvider></Boundary>);
  } catch (error) {
    const reason = reasonOf(error);
    root.render(<p role="alert" style={{ padding: 24 }}>{LOAD_FAILED}{reason ? ` (${reason})` : ''}</p>);
    reportError(reason);
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
parent.postMessage({ type: 'formlogic:ready', nativeProtocol: 1, zipp: identities['zipp-web-python'], engines: readyEngines(served, identities) }, '*');
