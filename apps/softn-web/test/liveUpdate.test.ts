/**
 * An open app handed a changed set of its files (lib/liveUpdate.ts): what the
 * running app can take where it stands is handed to it, and what changes
 * what the app is, or what it asks for, opens it afresh.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AppRevision, AppUpdateResult, LiveApp } from '@softn/core';
import { planOpenAppUpdate, updateOpenApp, type RevisedTabFields } from '../src/lib/liveUpdate';

const MANIFEST = { name: 'Notes', version: '1.0.0', main: 'ui/main.ui', files: { logic: ['logic/main.logic'] } };

function files(over: Record<string, string> = {}): Map<string, string> {
  return new Map(
    Object.entries({
      'manifest.json': JSON.stringify(MANIFEST),
      'permission.json': JSON.stringify({ permissions: { net: { enabled: true } } }),
      'ui/main.ui': '<logic src="../logic/main.logic" />\n<div><span class="count">{count}</span></div>',
      'logic/main.logic': 'let count = 0\nfunction inc() { count = count + 1 }',
      ...over,
    })
  );
}

function fakeLive(answer: AppUpdateResult): LiveApp & { handed: AppRevision[] } {
  const handed: AppRevision[] = [];
  return {
    handed,
    update: async (revision) => {
      handed.push(revision);
      return answer;
    },
    restart: async () => answer,
    shown: null,
    wanted: null,
  };
}

describe('an open app handed a changed set of its files', () => {
  it('hands the running app the new version, and the tab its new fields once it is showing', async () => {
    const live = fakeLive({ outcome: 'updated', changed: ['page'] });
    const before = files();
    const disposeOld = vi.fn();
    const applied: RevisedTabFields[] = [];
    const next = files({ 'ui/main.ui': '<logic src="../logic/main.logic" />\n<div><h1>Notes</h1><span class="count">{count}</span></div>' });
    const result = await updateOpenApp(
      { textFiles: before, live, importResolver: Object.assign(async () => null, { dispose: disposeOld }) },
      next,
      (fields) => applied.push(fields)
    );
    expect(result).toEqual({ outcome: 'updated', changed: ['page'] });
    expect(live.handed).toHaveLength(1);
    expect(live.handed[0].source).toContain('<h1>Notes</h1>');
    expect(applied).toHaveLength(1);
    expect(applied[0].source).toBe(live.handed[0].source);
    expect(applied[0].textFiles?.get('ui/main.ui')).toContain('<h1>Notes</h1>');
    // The resolver the app ran on before is let go; the one it runs on now is the tab's.
    expect(disposeOld).toHaveBeenCalledTimes(1);
    expect(applied[0].importResolver).toBe(live.handed[0].importResolver);
  });

  it('leaves the tab as it was when the change has a problem', async () => {
    const live = fakeLive({ outcome: 'kept', changed: [], problem: 'Unclosed tag: <Stack>' });
    const disposeOld = vi.fn();
    const applied: RevisedTabFields[] = [];
    const result = await updateOpenApp(
      { textFiles: files(), live, importResolver: Object.assign(async () => null, { dispose: disposeOld }) },
      files({ 'ui/main.ui': '<Stack><p>half' }),
      (fields) => applied.push(fields)
    );
    expect(result).toMatchObject({ outcome: 'kept', problem: 'Unclosed tag: <Stack>' });
    expect(applied).toEqual([]);
    expect(disposeOld).not.toHaveBeenCalled();
  });

  it('opens the app afresh when what it asks permission for changed', async () => {
    const live = fakeLive({ outcome: 'updated', changed: [] });
    const result = await updateOpenApp(
      { textFiles: files(), live },
      files({ 'permission.json': JSON.stringify({ permissions: { net: { enabled: true }, files: { enabled: true } } }) }),
      () => {}
    );
    expect(result.outcome).toBe('reopen');
    expect(live.handed).toEqual([]);
  });

  it('opens the app afresh when its manifest changed what it runs, and not for its name or its list of pages', () => {
    const tab = { textFiles: files() };
    const renamed = files({ 'manifest.json': JSON.stringify({ ...MANIFEST, name: 'Notebook', version: '1.0.1', pages: [{ id: 'home' }] }) });
    expect('revision' in planOpenAppUpdate(tab, renamed)).toBe(true);
    const moved = files({ 'manifest.json': JSON.stringify({ ...MANIFEST, config: { execution: 'worker' } }) });
    expect(planOpenAppUpdate(tab, moved)).toEqual({ reopen: 'Its manifest changed, so it has to be opened again.' });
  });

  it('says what is wrong with a set that cannot be put together', () => {
    const broken = files({ 'manifest.json': '{ "name": ' });
    expect(planOpenAppUpdate({ textFiles: files({ 'manifest.json': '{ "name": ' }) }, broken)).toEqual({ problem: 'Its manifest.json is not valid JSON.' });
  });
});
