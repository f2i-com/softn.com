/**
 * The assets a page is offered are the assets the project has now.
 * See projectAssets.ts.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useFilesStore } from '../stores/filesStore';
import { useProjectStore } from '../stores/projectStore';
import type { AssetFile } from '../types/builder';
import { assetPath, currentAssets } from './projectAssets';

const bytes = new Uint8Array([1, 2, 3]);
const asset = (path: string): AssetFile => ({ bundlePath: path, name: path.replace(/^assets\//, ''), type: 'image/png', data: bytes });

function paths(): string[] {
  const files = useFilesStore.getState();
  const project = useProjectStore.getState();
  return currentAssets(files, project).map(assetPath).sort();
}

function idOf(path: string): string {
  const node = [...useFilesStore.getState().nodes.values()].find((n) => n.path === path);
  if (!node) throw new Error(`no file at ${path}`);
  return node.id;
}

beforeEach(() => {
  useProjectStore.getState().reset();
  useFilesStore.getState().reset();
  const opened = [asset('assets/logo.png'), asset('assets/hero.png'), asset('assets/banner.png')];
  // As an opened bundle leaves them: in both stores.
  useProjectStore.getState().setAssets(opened);
  useFilesStore.getState().loadFromBundle(useFilesStore.getState().uiFiles, useFilesStore.getState().logicFiles, new Map(opened.map((a) => [a.bundlePath!, a])));
});

describe('the project’s assets', () => {
  it('are what was opened, to begin with', () => {
    expect(paths()).toEqual(['assets/banner.png', 'assets/hero.png', 'assets/logo.png']);
  });

  it('no longer include one that was deleted', () => {
    useFilesStore.getState().deleteFile(idOf('assets/logo.png'));
    expect(paths()).toEqual(['assets/banner.png', 'assets/hero.png']);
  });

  it('have a renamed one under its new name, and not its old', () => {
    useFilesStore.getState().renameFile(idOf('assets/hero.png'), 'cover.png');
    expect(paths()).toEqual(['assets/banner.png', 'assets/cover.png', 'assets/logo.png']);
  });

  it('are the list a project was given when it has no files of its own', () => {
    useFilesStore.getState().reset();
    expect(paths()).toEqual(['assets/banner.png', 'assets/hero.png', 'assets/logo.png']);
  });
});
