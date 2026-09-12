import React, { Component } from 'react';
import { createRoot } from 'react-dom/client';
import { SoftNWithXDB, composeBundleSource } from '@softn/core';
import { registerRuntimeComponents } from '@softn/components/lazy';
import { ThemeProvider } from '@softn/components/theme';

// This shell is trusted code, run in an opaque-origin iframe. The parent owns
// authentication and accepts only named action calls for the selected app.
// Pin all loading to this trusted runtime directory before accepting app source.
const policy = document.createElement('meta');
policy.httpEquiv = 'Content-Security-Policy';
const assets = new URL('./', document.baseURI).href;
policy.content = `default-src 'none'; script-src ${assets} 'wasm-unsafe-eval'; connect-src ${assets}; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; worker-src blob:; form-action 'none'; base-uri 'none'; frame-src 'none'`;
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
    const files = new Map<string, string>(Object.entries(event.data.client));
    const manifest = JSON.parse(files.get('manifest.json') || '{}');
    const composed = composeBundleSource(files, manifest.main, manifest.files?.logic || []);
    // A bundle's permission.json cannot enable arbitrary network, hardware or sync access.
    root.render(<Boundary><ThemeProvider defaultDarkMode={event.data.dark === true}>
      <SoftNWithXDB {...composed} appId={event.data.appId} resumeSavedSyncRoom={false}
        permissionConfig={{ permissions: {} }} scriptExecutionMode="main"
        backendCall={backendCall} importResolver={async path => files.get(path.replace(/^\//, '')) ?? null}
        onError={() => port?.postMessage({ type: 'error' })} />
    </ThemeProvider></Boundary>);
  } catch {
    root.render(<p role="alert" style={{ padding: 24 }}>This app could not be loaded. Check the interface and logic files.</p>);
    port.postMessage({ type: 'error' });
  }
});
parent.postMessage({ type: 'formlogic:ready' }, '*');
