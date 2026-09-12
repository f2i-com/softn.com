import { describe, expect, it, vi } from 'vitest';
import type { XDBRecord } from '@softn/core';
import type { VFSFile } from '../src/types/studio';
import {
  assemblePreviewSource,
  buildPreviewXDBState,
  clearPreviewXDBCollections,
  previewDataKey,
  replacePreviewXDBCollections,
  shouldReseedPreviewData,
} from '../src/lib/previewProject';

function textFile(path: string, content: string): VFSFile {
  return {
    path,
    content,
    mimeType: 'text/plain',
    lastModified: 1,
    lastModifiedBy: 'user',
    version: 1,
  };
}

describe('Studio preview project assembly', () => {
  it('preloads declared helpers once before components and entry code, as the runtime does', () => {
    const main = '<logic src="../logic/main.logic" /><import Card from="./Card.ui" /><Card />';
    const uiFiles = new Map([
      ['ui/main.ui', main],
      ['ui/Card.ui', '<logic src="../logic/card.logic" /><Text>{heading}</Text>'],
    ]);
    const logicFiles = new Map([
      ['logic/main.logic', 'let heading = helperLabel + cardLabel;'],
      ['logic/helpers.logic', 'import "./shared.logic";\nlet helperLabel = "From helper";'],
      ['logic/card.logic', 'let cardLabel = helperLabel + " card";'],
      ['logic/shared.logic', 'let shared = true;'],
      ['server/api.logic', 'let serverOnly = true;'],
    ]);
    const result = assemblePreviewSource('ui/main.ui', main, uiFiles, logicFiles,
      ['logic/helpers.logic', 'logic/card.logic', 'logic/main.logic', 'logic/helpers.logic']);
    expect(result.source.indexOf('let helperLabel')).toBeLessThan(result.source.indexOf('let cardLabel'));
    expect(result.source.indexOf('let cardLabel')).toBeLessThan(result.source.indexOf('let heading'));
    expect(result.source.match(/let helperLabel/g)).toHaveLength(1);
    expect(result.source.match(/let cardLabel/g)).toHaveLength(1);
    expect(result.source).toContain('import "logic/shared.logic";');
    expect(result.source).not.toContain('serverOnly');
    expect(new Set(result.preIncludedLogicPaths)).toEqual(new Set(['logic/main.logic', 'logic/card.logic', 'logic/helpers.logic']));
  });

  it('does not execute manifest helpers for an inline-only app or absent paths', () => {
    const inline = '<logic>let heading = "Inline";</logic><Text>{heading}</Text>';
    const result = assemblePreviewSource('ui/main.ui', inline, new Map(),
      new Map([['logic/helpers.logic', 'let unused = true;']]), ['logic/helpers.logic', '../missing.logic']);
    expect(result.source).not.toContain('unused');
    expect(result.source).toContain('let heading = "Inline";');
  });

  it('runs the component entry after helpers when the main UI has no logic', () => {
    const main = '<import Card from="./Card.ui" /><Card />';
    const result = assemblePreviewSource('ui/main.ui', main,
      new Map([['ui/Card.ui', '<logic src="../logic/card.logic" /><Text>{cardLabel}</Text>']]),
      new Map([['logic/card.logic', 'let cardLabel = helperLabel;'], ['logic/helpers.logic', 'let helperLabel = "Ready";']]),
      ['logic/card.logic', 'logic/helpers.logic']);
    expect(result.source.indexOf('let helperLabel')).toBeLessThan(result.source.indexOf('let cardLabel'));
    expect(result.source.match(/let cardLabel/g)).toHaveLength(1);
  });

  it("keeps imported components' inline and external logic with safe owner-relative paths", () => {
    const uiFiles = new Map([
      [
        'ui/main.ui',
        '<logic>let fromMain = cardTitle;</logic>\n<import Card from="./components/Card.ui" />\n<Stack><Card /></Stack>',
      ],
      [
        'ui/components/Card.ui',
        '<logic src="../../logic/card.logic" />\n<logic>let inlineCard = true;</logic>\n<Text>{cardTitle}</Text>',
      ],
    ]);
    const logicFiles = new Map([
      ['logic/card.logic', 'import "./shared.logic";\nlet cardTitle = "Card";'],
      ['logic/shared.logic', 'let shared = true;'],
    ]);

    const result = assemblePreviewSource(
      'ui/main.ui',
      uiFiles.get('ui/main.ui')!,
      uiFiles,
      logicFiles
    );

    expect(result.source).toContain('let cardTitle = "Card";');
    expect(result.source).toContain('let inlineCard = true;');
    expect(result.source).toContain('import "logic/shared.logic";');
    expect(result.source).toContain('<Text>{cardTitle}</Text>');
    expect(result.source.match(/<logic>/g)).toHaveLength(1);
    expect(result.preIncludedLogicPaths).toEqual(['logic/card.logic']);
    expect(result.source.indexOf('let cardTitle')).toBeLessThan(
      result.source.indexOf('let fromMain')
    );
  });

  it('does not resolve component or logic references that traverse above the project root', () => {
    const uiFiles = new Map([
      [
        'main.ui',
        '<logic src="../outside.logic" />\n<import Escape from="../outside.ui" />\n<Stack><Escape /></Stack>',
      ],
      ['outside.ui', '<Text>Escaped</Text>'],
    ]);
    const result = assemblePreviewSource(
      'main.ui',
      uiFiles.get('main.ui')!,
      uiFiles,
      new Map([['outside.logic', 'let escaped = true;']])
    );

    expect(result.source).not.toContain('let escaped');
    expect(result.source).not.toContain('<Text>Escaped</Text>');
    expect(result.preIncludedLogicPaths).toEqual([]);
  });

  it('uses the shared XDB record shape and batches replacement and disposal notifications', () => {
    const files = new Map([
      [
        'data/tasks.xdb',
        textFile(
          'data/tasks.xdb',
          JSON.stringify({
            collection: 'tasks',
            records: [{ id: 'task-1', title: 'Ship it' }],
          })
        ),
      ],
    ]);
    const state = buildPreviewXDBState(files);
    expect(state.initialData.tasks).toEqual([
      expect.objectContaining({
        id: 'task-1',
        collection: 'tasks',
        data: { title: 'Ship it' },
        deleted: false,
      }),
    ]);

    const records = new Map<string, XDBRecord[]>([
      [
        'tasks',
        [
          {
            id: 'stale',
            collection: 'tasks',
            data: {},
            created_at: '',
            updated_at: '',
            deleted: false,
          },
        ],
      ],
      [
        'removed',
        [
          {
            id: 'old',
            collection: 'removed',
            data: {},
            created_at: '',
            updated_at: '',
            deleted: false,
          },
        ],
      ],
    ]);
    const xdb = {
      suppressNotifications: vi.fn(),
      resumeNotifications: vi.fn(),
      clear: vi.fn((collection: string) => records.set(collection, [])),
      getAllRaw: vi.fn((collection: string) => records.get(collection) ?? []),
      writeRecord: vi.fn((collection: string, record: XDBRecord) => {
        records.set(collection, [...(records.get(collection) ?? []), record]);
      }),
    };

    replacePreviewXDBCollections(xdb, state, ['tasks', 'removed']);
    expect(records.get('tasks')).toEqual([
      expect.objectContaining({ id: 'task-1', data: { title: 'Ship it' } }),
    ]);
    expect(records.get('removed')).toEqual([]);
    expect(xdb.suppressNotifications).toHaveBeenCalledTimes(1);
    expect(xdb.resumeNotifications).toHaveBeenCalledTimes(1);

    clearPreviewXDBCollections(xdb, state.collections);
    expect(records.get('tasks')).toEqual([]);
    expect(xdb.suppressNotifications).toHaveBeenCalledTimes(2);
    expect(xdb.resumeNotifications).toHaveBeenCalledTimes(2);
  });
});

/**
 * The preview-data reset policy. The seeding effect used to depend on the
 * whole file map, so editing a label in a .ui file threw away whatever
 * records the person had entered into the preview and reseeded from source.
 * Pinned here: only a change to an .xdb file (content, path, or presence)
 * changes the key the reseed is driven by; a .ui/.logic/asset edit keeps
 * the same key, and so keeps the preview's data.
 */
describe('Studio preview data reset policy', () => {
  const xdb = textFile('data/tasks.xdb', JSON.stringify({ collection: 'tasks', records: [{ id: 't1', title: 'One' }] }));
  const ui = textFile('ui/main.ui', '<Text>One</Text>');

  it('keeps the key when a source file that is not .xdb changes', () => {
    const before = previewDataKey(new Map([['data/tasks.xdb', xdb], ['ui/main.ui', ui]]));
    const edited = textFile('ui/main.ui', '<Text>Two</Text>');
    const after = previewDataKey(new Map([['data/tasks.xdb', xdb], ['ui/main.ui', edited]]));
    expect(after).toBe(before);
    expect(shouldReseedPreviewData(before, after)).toBe(false);
  });

  it('changes the key when an .xdb file is edited, added, renamed or removed', () => {
    const base = previewDataKey(new Map([['data/tasks.xdb', xdb], ['ui/main.ui', ui]]));
    const edited = textFile('data/tasks.xdb', JSON.stringify({ collection: 'tasks', records: [] }));
    expect(previewDataKey(new Map([['data/tasks.xdb', edited], ['ui/main.ui', ui]]))).not.toBe(base);
    const added = textFile('data/users.xdb', JSON.stringify({ collection: 'users', records: [] }));
    expect(previewDataKey(new Map([['data/tasks.xdb', xdb], ['data/users.xdb', added], ['ui/main.ui', ui]]))).not.toBe(base);
    expect(previewDataKey(new Map([['data/todo.xdb', xdb], ['ui/main.ui', ui]]))).not.toBe(base);
    const removed = previewDataKey(new Map([['ui/main.ui', ui]]));
    expect(removed).not.toBe(base);
    expect(shouldReseedPreviewData(base, removed)).toBe(true);
  });

  it('is stable across file-map ordering', () => {
    const a = previewDataKey(new Map([['data/tasks.xdb', xdb], ['ui/main.ui', ui]]));
    const b = previewDataKey(new Map([['ui/main.ui', ui], ['data/tasks.xdb', xdb]]));
    expect(a).toBe(b);
  });
});
