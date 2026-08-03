import { describe, expect, it, vi } from 'vitest';
import type { XDBRecord } from '@softn/core';
import type { VFSFile } from '../src/types/studio';
import {
  assemblePreviewSource,
  buildPreviewXDBState,
  clearPreviewXDBCollections,
  replacePreviewXDBCollections,
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
