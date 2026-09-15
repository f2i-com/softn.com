import React, { Component } from 'react';
import { createRoot } from 'react-dom/client';
import { SoftNWithXDB, composeBundleSource, configureZippWasmSource } from '@softn/core';
import { registerRuntimeComponents } from '@softn/components/lazy';
import { ThemeProvider } from '@softn/components/theme';
import { installAppStorage } from './storage';
import { createBackendQueue, BACKEND_UNREADABLE } from './backendQueue';
import zippSource from '../../../packages/@softn/core/wasm-zipp/SOURCE.json';

// This shell is trusted code, run in an opaque-origin iframe. The parent owns
// authentication and accepts only named action calls for the selected app.
// Pin all loading to this trusted runtime directory before accepting app source.
const policy = document.createElement('meta');
policy.httpEquiv = 'Content-Security-Policy';
const assets = new URL('./', document.baseURI).href;
policy.content = `default-src 'none'; script-src ${assets} 'wasm-unsafe-eval'; connect-src ${assets}; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; worker-src blob:; form-action 'none'; base-uri 'none'; frame-src 'none'`;
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
window.addEventListener('message', event => {
  if (started || event.source !== parent || event.data?.type !== 'formlogic:init' || !event.ports[0]) return;
  started = true;
  port = event.ports[0];
  port.onmessage = event => { calls.settle(event.data?.id, event.data?.result); };
  // A result the port could not deserialise names no id: nothing in flight
  // can be told apart, so all of it answers now rather than at its deadline.
  port.onmessageerror = () => { calls.failInFlight(BACKEND_UNREADABLE); };
  try {
    const engineBytes = event.data.zippWasm;
    if (!(engineBytes instanceof ArrayBuffer) || engineBytes.byteLength < 8 || engineBytes.byteLength > 32 * 1024 * 1024) {
      throw new Error('The parent must supply the matching ZIPP engine bytes');
    }
    configureZippWasmSource(engineBytes);
    const files = new Map<string, string>(Object.entries(event.data.client));
    const manifest = JSON.parse(files.get('manifest.json') || '{}');
    if (event.data.native === true) {
      installAppStorage(event.data.storage || {}, input => backendCall("nativeStorage", input));
      // Keep stored app source untouched. Its declared API origin is routed by
      // the trusted parent to this app's native backend, without direct egress.
      const entry = String(manifest.main);
      const bridge = `<logic>
softn.net.fetch = function(url, options, done) {
  softn.backend.call("nativeRequest", {url:url,options:options || {}}, function(response) {
    if (response.error) { done({ok:false,status:503,body:JSON.stringify({error:response.error}),headers:{}}); return; }
    const result = response.result;
    done({ok:result.status >= 200 && result.status < 300,status:result.status,body:JSON.stringify(result.body),headers:{}});
  });
};
</logic>
`;
      files.set(entry, bridge + (files.get(entry) || ''));
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
        backendCall={backendCall} importResolver={async path => files.get(path.replace(/^\//, '')) ?? null}
        onError={error => reportError(reasonOf(error))} />
    </ThemeProvider></Boundary>);
  } catch (error) {
    const reason = reasonOf(error);
    root.render(<p role="alert" style={{ padding: 24 }}>{LOAD_FAILED}{reason ? ` (${reason})` : ''}</p>);
    reportError(reason);
  }
});
// release is an addition: FormLogic compares version and sha256. Typed as
// optional because a local engine build (--install-local) records none.
const zippRelease = (zippSource as { release?: string }).release;
parent.postMessage({ type: 'formlogic:ready', nativeProtocol: 1, zipp: { version: zippSource.version, sha256: zippSource.sha256, release: zippRelease } }, '*');
