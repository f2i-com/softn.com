import { useEffect, useState, type CSSProperties } from 'react';
import { createEphemeralXDBScope, type PermissionConfig } from '@softn/core';
import { AppRunner } from './AppRunner';
import { createAssetResolver, createImportResolver, loadXDBData, processBundle, readZip, type BundleManifest } from '../lib/bundleProcessor';

const permissions: PermissionConfig = { permissions: {} };
type Preview = ReturnType<typeof processBundle> & {
  appId: string;
  assetResolver: ReturnType<typeof createAssetResolver>;
  importResolver: ReturnType<typeof createImportResolver>;
};

function announce(type: 'softn:app-ready' | 'softn:app-error') {
  if (window.parent !== window) window.parent.postMessage({ type, app: 'Fieldnotes' }, '*');
}

/** The shipped example, rendered by the runtime with disposable sample data. */
export function FieldnotesPreview() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let release = () => {};
    void (async () => {
      try {
        const response = await fetch('/examples/Fieldnotes.softn', { signal: controller.signal });
        if (!response.ok) throw new Error('The sample app is unavailable.');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (controller.signal.aborted) return;
        const { textFiles, binaryFiles, archive } = readZip(bytes);
        release = () => archive.release();
        const manifest = JSON.parse(textFiles.get('manifest.json') ?? '') as BundleManifest;
        if (manifest.name !== 'Fieldnotes' || !manifest.main || !manifest.files) throw new Error('The sample app could not be read.');
        const scope = createEphemeralXDBScope();
        release = () => { scope.dispose(); archive.release(); };
        await loadXDBData(textFiles, manifest, scope.appId);
        if (controller.signal.aborted) return;
        const source = processBundle(textFiles, manifest);
        const importResolver = createImportResolver(textFiles, permissions);
        const assetResolver = createAssetResolver(binaryFiles, textFiles);
        release = () => { importResolver.dispose(); assetResolver.dispose(); scope.dispose(); };
        setPreview({ ...source, appId: scope.appId, importResolver, assetResolver });
      } catch {
        release();
        if (!controller.signal.aborted) { setFailed(true); announce('softn:app-error'); }
      } finally {
        if (controller.signal.aborted) release();
      }
    })();
    return () => { controller.abort(); release(); };
  }, []);

  return <div style={{ position: 'fixed', inset: 0, background: '#f6f5f1', '--softn-tab-bar-height': '0px', '--softn-chrome-base': '0px' } as CSSProperties}>
    {preview ? <AppRunner {...preview} appName="Fieldnotes" active permissionConfig={permissions} onReady={() => announce('softn:app-ready')} />
      : <p role="status" style={{ padding: 32, fontFamily: 'system-ui', color: '#596145' }}>{failed ? 'Open Fieldnotes in the runtime to try the app.' : 'Preparing Fieldnotes…'}</p>}
  </div>;
}
