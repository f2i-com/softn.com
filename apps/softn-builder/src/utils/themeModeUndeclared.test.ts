/**
 * A project that declares no theme is not given one by being opened.
 *
 * The project's theme is its manifest's `config.theme.mode`. For as long as
 * no runtime read it, what the Builder made of a manifest that had none did
 * not matter: it read "light" (or the side a literal `<App theme>` named),
 * showed it in its own field, and wrote it into the next export. A runtime
 * reads it now, and a declared "light" or "dark" wins over the visitor's
 * device. So an app that followed its visitor's device was pinned to light
 * by being opened and saved with nothing changed.
 *
 * What is held here: a manifest with no mode, or with a word that is not one
 * of the three, is a project that follows the device ("system" in the
 * field), whatever its page pins; an export of it with nothing changed has
 * the manifest it came with; and a saved project from before the setting
 * was kept reads the same way. A side is written when a person chooses one.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { readBundleEntries } from '@softn/core';
import { loadBundle } from './bundleLoader';
import { buildProjectBundle } from './buildProjectBundle';
import { captureSession, commitProjectSnapshot, prepareProjectSnapshot, prepareSessionSnapshot } from './openProject';
import { startNewProject } from './newProject';
import { readThemeMode } from './themeMode';
import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { useHistoryStore } from '../stores/historyStore';
import { useProjectStore } from '../stores/projectStore';
import { useSchemaStore } from '../stores/schemaStore';

const PLAIN = '<App>\n  <Text>Hi</Text>\n</App>\n';
const PINNED_DARK = '<App theme="dark">\n  <Text>Hi</Text>\n</App>\n';

/** A bundle whose manifest has this `config` (none when it is left out). */
function bundleWith(ui: string, config?: Record<string, unknown>): Uint8Array {
  const manifest: Record<string, unknown> = {
    name: 'Themed',
    version: '1.0.0',
    description: '',
    main: 'ui/main.ui',
    files: { ui: ['ui/main.ui'], logic: [], xdb: [], assets: [] },
  };
  if (config) manifest.config = config;
  return zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'ui/main.ui': strToU8(ui) });
}

async function open(bytes: Uint8Array): Promise<void> {
  commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(bytes)));
}

/** What an export of the project as it stands writes: its manifest's theme, and the entry page. */
async function exported(): Promise<{ theme: unknown; hasTheme: boolean; page: string }> {
  const entries = readBundleEntries(await buildProjectBundle());
  const manifest = JSON.parse(new TextDecoder().decode(entries.get('manifest.json')!)) as { config?: Record<string, unknown> };
  return {
    theme: manifest.config?.theme,
    hasTheme: manifest.config !== undefined && 'theme' in manifest.config,
    page: new TextDecoder().decode(entries.get('ui/main.ui')!),
  };
}

const mode = () => useProjectStore.getState().themeMode;

beforeEach(() => {
  useProjectStore.getState().reset();
  useFilesStore.getState().reset();
  useCanvasStore.getState().reset();
  useSchemaStore.getState().reset();
  useHistoryStore.getState().clear();
});

describe('a bundle whose manifest declares no theme', () => {
  it('is a project that follows the device, and is exported untouched with no theme written into it', async () => {
    await open(bundleWith(PLAIN));
    expect(mode()).toBe('system');
    const out = await exported();
    expect(out.hasTheme).toBe(false);
    expect(out.page).toBe(PLAIN);
  });

  it('is the same where its page pins a side: the pin is the page\'s, and is not made the project\'s', async () => {
    // The page read `<App theme="dark">`, so the project was "dark" and the
    // export declared it. To the runtime that is another app: its tokens
    // stop following the visitor and go dark with the page.
    await open(bundleWith(PINNED_DARK));
    expect(mode()).toBe('system');
    const out = await exported();
    expect(out.hasTheme).toBe(false);
    expect(out.page).toBe(PINNED_DARK);
  });

  it('keeps what else its manifest says of the theme, and adds no mode to it', async () => {
    await open(bundleWith(PLAIN, { theme: { accent: '#ff0000' } }));
    expect(mode()).toBe('system');
    expect((await exported()).theme).toEqual({ accent: '#ff0000' });
  });

  it('declares a side once a person chooses one, and "system" when they go back', async () => {
    await open(bundleWith(PLAIN));
    useProjectStore.getState().setThemeMode('dark');
    expect((await exported()).theme).toEqual({ mode: 'dark' });
    // Back to following the device: nothing is declared, as the bundle came.
    useProjectStore.getState().setThemeMode('system');
    expect((await exported()).hasTheme).toBe(false);
  });
});

describe('a bundle whose manifest declares a theme', () => {
  it('is that theme, and is exported with it', async () => {
    for (const declared of ['light', 'dark', 'system'] as const) {
      await open(bundleWith(PINNED_DARK, { theme: { mode: declared } }));
      expect(mode()).toBe(declared);
      expect((await exported()).theme).toEqual({ mode: declared });
    }
  });

  it('is written over by what a person chooses, "system" included', async () => {
    await open(bundleWith(PLAIN, { theme: { mode: 'dark' } }));
    useProjectStore.getState().setThemeMode('system');
    expect((await exported()).theme).toEqual({ mode: 'system' });
  });

  it('follows the device where the word is not one of the three, and keeps the word it was given', async () => {
    // "auto", a word from a newer format, a slip of the hand: the runtime
    // reads each as no declaration. The field shows System, and the export
    // does not replace a word the Builder does not know with one it does.
    for (const word of ['auto', 'Dark', '', 7, null]) {
      await open(bundleWith(PLAIN, { theme: { mode: word } }));
      expect(mode(), String(word)).toBe('system');
      expect((await exported()).theme, String(word)).toEqual({ mode: word });
    }
    await open(bundleWith(PLAIN, { theme: { mode: 'auto' } }));
    useProjectStore.getState().setThemeMode('light');
    expect((await exported()).theme).toEqual({ mode: 'light' });
  });
});

describe('a project saved before its theme was kept, or with a theme that is no theme', () => {
  /** The recovery record of the project that is open, with its theme as given. */
  function sessionWith(themeMode: unknown): string {
    const session = JSON.parse(JSON.stringify(captureSession('design'))) as { project: Record<string, unknown> };
    if (themeMode === undefined) delete session.project.themeMode;
    else session.project.themeMode = themeMode;
    return JSON.stringify(session);
  }

  it('follows the device when it is restored', async () => {
    await open(bundleWith(PLAIN, { theme: { mode: 'dark' } }));
    expect(prepareSessionSnapshot(sessionWith(undefined)).project.themeMode).toBe('system');
    expect(prepareSessionSnapshot(sessionWith('')).project.themeMode).toBe('system');
    expect(prepareSessionSnapshot(sessionWith('sepia')).project.themeMode).toBe('system');
    // And one that has a theme comes back with it.
    expect(prepareSessionSnapshot(sessionWith('dark')).project.themeMode).toBe('dark');
    expect(prepareSessionSnapshot(sessionWith('light')).project.themeMode).toBe('light');
  });

  it('follows the device when its record is read into the project', () => {
    const record = { ...useProjectStore.getState().toJSON() } as Record<string, unknown>;
    delete record.themeMode;
    useProjectStore.getState().fromJSON(record as never);
    expect(mode()).toBe('system');
    useProjectStore.getState().fromJSON({ ...record, themeMode: 'blue' } as never);
    expect(mode()).toBe('system');
    useProjectStore.getState().fromJSON({ ...record, themeMode: 'dark' } as never);
    expect(mode()).toBe('dark');
  });
});

describe('a new project', () => {
  it('is light unless another is chosen, and declares what it is: the person sees that in the field and owns it', async () => {
    expect(mode()).toBe('light');
    expect((await exported()).theme).toEqual({ mode: 'light' });
    startNewProject({ name: 'Fresh', description: '', template: 'blank', theme: 'system', language: 'javascript', pythonPackages: [] });
    expect((await exported()).theme).toEqual({ mode: 'system' });
  });
});

describe('a theme mode read from a file', () => {
  it('is one of the three words, or the device', () => {
    expect(readThemeMode('light')).toBe('light');
    expect(readThemeMode('dark')).toBe('dark');
    expect(readThemeMode('system')).toBe('system');
    for (const other of [undefined, null, '', 'auto', 'DARK', 1, {}, []]) expect(readThemeMode(other)).toBe('system');
  });
});
