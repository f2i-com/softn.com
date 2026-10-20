// @vitest-environment jsdom
/**
 * What the dialog behind "What this means" says about a declaration: in the
 * reader's words, and true of the declaration in front of it. It called a
 * private collection one "anyone running the app can read and add to", and
 * showed the author's tokens ("Scopes: user_selected").
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PermissionConfig } from '@softn/core';
import { PermissionPrompt } from '../src/PermissionPrompt';
import { DESKTOP_WORDING } from '../src/PermissionBar';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function show(permissions: PermissionConfig['permissions'], wording?: typeof DESKTOP_WORDING) {
  act(() =>
    root.render(<PermissionPrompt appName="Notes" permissions={{ permissions } as PermissionConfig} onAllow={vi.fn()} onClose={vi.fn()} wording={wording} />)
  );
  return host.textContent ?? '';
}

it('describes each storage collection by its own policy', () => {
  const text = show({ storage: { enabled: true, collections: { notes: 'private', scores: 'append-only' } } } as PermissionConfig['permissions']);
  expect(text).not.toMatch(/anyone running the app can read and add to/);
  expect(text).toContain('notes: private to you. Each visitor sees and changes only the records they added; nobody else can read them.');
  expect(text).toContain('scores: append-only.');
  expect(text).toContain('Other collections: shared.');
});

it('says a storage declaration that names no collection shares them all', () => {
  expect(show({ storage: { enabled: true } } as PermissionConfig['permissions'])).toContain(
    'Every collection: shared. Anyone running the app can read, change and remove every record.'
  );
  expect(show({ storage: { enabled: true, collections: { '*': 'owner-write' } } } as PermissionConfig['permissions'])).toContain('Every collection: owner-write.');
});

it('says the same on the desktop, where the wording is the loader’s', () => {
  const text = show({ storage: { enabled: true, collections: { notes: 'private' } } } as PermissionConfig['permissions'], DESKTOP_WORDING);
  expect(text).not.toMatch(/anyone running the app can read and add to/);
  expect(text).toContain('notes: private to you.');
});

it('puts the declaration’s tokens into words', () => {
  const text = show({ files: { enabled: true, scopes: ['user_selected'] }, camera: { enabled: true, modes: ['photo', 'slow_motion'] } } as PermissionConfig['permissions']);
  expect(text).toContain('Which files: files you choose');
  expect(text).toContain('For: photos, slow motion');
  expect(text).not.toContain('user_selected');
  expect(text).not.toContain('Scopes:');
});

it('lets a host list wrap at its dots and commas, not inside a name', () => {
  show({ net: { enabled: true, allowed_hosts: ['api.example.com', 'collect.example.net'] } });
  const detail = [...host.querySelectorAll('.softn-consent-row-detail')].find((node) => node.textContent?.startsWith('Only these sites:'));
  expect(detail?.textContent).toBe('Only these sites: api.example.com, collect.example.net');
  expect(detail?.querySelectorAll('wbr').length).toBe(4);
});
