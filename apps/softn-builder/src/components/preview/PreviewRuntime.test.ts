// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getXDB, type SoftNWithXDBProps, type XDBRecord } from '@softn/core';
import { PreviewRuntime, previewRecordsFor } from './PreviewRuntime';

let rendered: SoftNWithXDBProps | null = null;
vi.mock('@softn/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@softn/core')>(),
  SoftNWithXDB: (props: SoftNWithXDBProps) => {
    rendered = props;
    return React.createElement('span', null, getXDB(props.appId).query('tasks').length);
  },
}));
const record: XDBRecord = {
  id: 'seed-task', deleted: false, collection: 'tasks', data: { title: 'Sample task', nested: { done: false } },
  created_at: '2026-09-12T09:00:00.000Z', updated_at: '2026-09-12T09:00:00.000Z',
};
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  rendered = null;
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

it('preserves seed identity while giving the preview its own nested values', () => {
  const records = previewRecordsFor([{ name: 'tasks', alias: 'items', fields: [], seedData: [], fullRecords: [{ ...record }] }]);
  expect(Object.keys(records)).toEqual(['tasks']);
  expect(records.tasks[0]).toEqual(record);
  (records.tasks[0].data.nested as { done: boolean }).done = true;
  expect((record.data.nested as { done: boolean }).done).toBe(false);
});

it('seeds before rendering, keeps a live session, and isolates the next project', () => {
  const records = previewRecordsFor([{ name: 'tasks', alias: 'tasks', fields: [], seedData: [], fullRecords: [{ ...record }] }]);
  const render = (projectId: string) => act(() => root.render(React.createElement(PreviewRuntime, {
    projectId, records, source: '<App />',
  })));
  localStorage.setItem('xdb:unrelated:tasks', 'keep this runtime data');
  render('project-one');
  const firstId = rendered!.appId!;
  expect(host.textContent).toBe('1');
  expect(rendered!.resumeSavedSyncRoom).toBe(false);
  getXDB(firstId).create('tasks', { title: 'Only in preview' });
  render('project-one');
  expect(getXDB(rendered!.appId).query('tasks')).toHaveLength(2);
  render('project-two');
  expect(rendered!.appId).not.toBe(firstId);
  expect(host.textContent).toBe('1');
  expect(() => getXDB(firstId)).toThrow();
  expect(localStorage.length).toBe(1);
  expect(localStorage.getItem('xdb:unrelated:tasks')).toBe('keep this runtime data');
});

it('replaces changed Data seeds and survives StrictMode cleanup', () => {
  const first = previewRecordsFor([{ name: 'tasks', alias: 'tasks', fields: [], seedData: [], fullRecords: [{ ...record }] }]);
  const render = (records: Record<string, XDBRecord[]>) => act(() => root.render(React.createElement(React.StrictMode, null,
    React.createElement(PreviewRuntime, { projectId: 'project', records, source: '<App />' }))));
  render(first);
  const firstId = rendered!.appId!;
  const edited = previewRecordsFor([{ name: 'tasks', alias: 'tasks', fields: [], seedData: [{ title: 'Edited in Data' }] }]);
  render(edited);
  expect(getXDB(rendered!.appId).query('tasks')[0].data.title).toBe('Edited in Data');
  expect(() => getXDB(firstId)).toThrow();
  expect(localStorage.length).toBe(0);
});
