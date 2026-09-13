import React, { Component } from 'react';
import { createRoot } from 'react-dom/client';
import { SoftNWithXDB, composeBundleSource, configureZippWasmSource } from '@softn/core';
import { registerRuntimeComponents } from '@softn/components/lazy';
import { ThemeProvider } from '@softn/components/theme';
import { installAppStorage } from './storage';
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
let sequence = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
function backendCall(action: string, input: Record<string, unknown>): Promise<unknown> {
  if (!port || pending.size >= 4) return Promise.resolve({ error: 'Please wait for the current request.' });
  return new Promise(resolve => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); resolve({ error: 'The backend request timed out.' }); }, 20000);
    pending.set(id, { resolve, timer });
    port!.postMessage({ type: 'call', id, action, input });
  });
}
class Boundary extends Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p role="alert">This app could not be loaded. Check the interface and logic files.</p> : this.props.children; }
}
window.addEventListener('message', event => {
  if (started || event.source !== parent || event.data?.type !== 'formlogic:init' || !event.ports[0]) return;
  started = true;
  port = event.ports[0];
  port.onmessage = event => {
    const item = pending.get(event.data?.id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(event.data.id);
    item.resolve(event.data.result);
  };
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
        onError={() => port?.postMessage({ type: 'error' })} />
    </ThemeProvider></Boundary>);
  } catch {
    root.render(<p role="alert" style={{ padding: 24 }}>This app could not be loaded. Check the interface and logic files.</p>);
    port.postMessage({ type: 'error' });
  }
});
parent.postMessage({ type: 'formlogic:ready', nativeProtocol: 1, zipp: { version: zippSource.version, sha256: zippSource.sha256 } }, '*');
