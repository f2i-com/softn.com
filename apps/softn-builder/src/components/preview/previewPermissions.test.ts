// @vitest-environment jsdom
/**
 * The Builder's preview runs an app under what it declares, withheld until
 * the person allows it there, as a runtime withholds it until they allow it.
 *
 * The declaration was handed to the preview as granted: a declared `net`
 * reached its hosts, and a Camera opened the camera, with nobody asked. And
 * with nothing declared, nothing was handed over, which core reads as a host
 * that enforces nothing: the page's markup fetched any address it named.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useCanvasStore } from '../../stores/canvasStore';
import { useFilesStore } from '../../stores/filesStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSchemaStore } from '../../stores/schemaStore';
import { LivePreview } from './LivePreview';

/** Each start of the app, with the declaration it was handed. */
const started = vi.hoisted(() => [] as unknown[]);

vi.mock('./PreviewRuntime', async () => {
  const { createElement, useState } = await import('react');
  function PreviewRuntime(props: { permissionConfig?: unknown }) {
    useState(() => started.push(props.permissionConfig));
    return createElement('p', null, 'The app');
  }
  return { PreviewRuntime, previewRecordsFor: () => ({}) };
});
vi.mock('@softn/components/theme', () => ({ ThemeProvider: ({ children }: { children: React.ReactNode }) => children }));

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  started.length = 0;
  useProjectStore.getState().reset();
  useFilesStore.getState().reset();
  useCanvasStore.getState().reset();
  useSchemaStore.getState().reset();
  const page = useFilesStore.getState().uiFiles.get('main_ui')!;
  useCanvasStore.getState().loadState(page.elements, page.rootId);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function open(): Promise<void> {
  await act(async () => {
    root.render(React.createElement(LivePreview));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const note = () => host.querySelector<HTMLElement>('[data-preview-capabilities]');
const press = async (label: string) => {
  const button = [...(note()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label)!;
  await act(async () => {
    button.click();
  });
};

describe('the preview of an app that declares capabilities', () => {
  it('starts it with them withheld, and again with them once they are allowed, until withheld again', async () => {
    useProjectStore.getState().setPermissions({ capabilities: ['net', 'camera'], allowedHosts: ['api.example.com'], allowHttp: false, storagePolicies: {}, file: true });
    await open();
    expect(started.at(-1)).toEqual({ permissions: {}, consentPending: true });
    expect(note()?.dataset.previewCapabilities).toBe('withheld');
    expect(note()?.textContent).toContain('This app asks for net, camera');

    await press('Allow in preview');
    expect(note()?.dataset.previewCapabilities).toBe('allowed');
    expect(started.at(-1)).toEqual({ permissions: { net: { enabled: true, allowed_hosts: ['api.example.com'] }, camera: { enabled: true } } });

    await press('Withhold again');
    expect(started.at(-1)).toMatchObject({ permissions: {}, consentPending: true });
  });

  it('asks again once the app declares more than was allowed', async () => {
    useProjectStore.getState().setPermissions({ capabilities: ['net'], allowedHosts: ['api.example.com'], allowHttp: false, storagePolicies: {}, file: true });
    await open();
    await press('Allow in preview');
    expect(started.at(-1)).toMatchObject({ permissions: { net: { enabled: true } } });
    await act(async () => {
      useProjectStore.getState().setPermissions({ capabilities: ['net'], allowedHosts: [], allowHttp: false, storagePolicies: {}, file: true });
    });
    expect(note()?.dataset.previewCapabilities).toBe('withheld');
    expect(started.at(-1)).toMatchObject({ permissions: {}, consentPending: true });
  });
});

describe('the preview of an app that declares nothing', () => {
  it('starts it under an empty declaration, which grants nothing and is enforced, and says nothing', async () => {
    await open();
    expect(started.at(-1)).toEqual({ permissions: {} });
    expect(note()).toBeNull();
  });
});
