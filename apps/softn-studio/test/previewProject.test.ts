import { describe, expect, it, vi } from 'vitest';
import type { XDBRecord } from '@softn/core';
import type { VFSFile } from '../src/types/studio';
import {
  buildPreviewXDBState,
  clearPreviewXDBCollections,
  composePreviewProject,
  previewDataKey,
  replacePreviewXDBCollections,
  shouldReseedPreviewData,
  stripTemplateComments,
  type PreviewComposition,
} from '../src/lib/previewProject';
import { READING_LIST } from '../src/examples/readingList';
import { READING_LIST_PYTHON } from '../src/examples/readingListPython';

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

/** A project's files as the VFS holds them. */
function project(entries: Array<{ path: string; content: string }>): Map<string, VFSFile> {
  return new Map(entries.map((entry) => [entry.path, textFile(entry.path, entry.content)]));
}

/** The composition, or the test fails naming the composer's refusal. */
function composed(files: Map<string, VFSFile>, main = 'ui/main.ui'): PreviewComposition {
  const result = composePreviewProject(files, main);
  if (!result.ok) throw new Error(`expected the preview to compose, but: ${result.error}`);
  return result.composition;
}

/**
 * The preview composes through core's composer, as Run does. Studio used to
 * assemble it itself: .logic only, bare paths from the bundle root, a missing
 * logic file skipped. Each of those made the preview disagree with the runtime.
 */
describe('Studio preview composition', () => {
  it('previews a Python app with its modules, in the language the runtime will run it in', () => {
    const composition = composed(project(READING_LIST_PYTHON.files));
    expect(composition.languages).toContain('python');
    expect(composition.python?.modules).toEqual(['shelf', 'main']);
    expect(composition.python?.files.main).toContain('def go(page_id):');
    expect(composition.logicBasePath).toBe('logic/main.py');
    // The markup keeps an empty logic block: the Python project is the code.
    expect(composition.source).toMatch(/<logic>\n<\/logic>$/);
  });

  it('previews a JavaScript app as before: its logic inlined, no Python project', () => {
    const composition = composed(project(READING_LIST.files));
    expect(composition.languages).toEqual(['javascript']);
    expect(composition.python).toBeUndefined();
    expect(composition.logicBasePath).toBe('logic/main.logic');
    expect(composition.source).toContain('let appName = "Reading list"');
    expect(composition.source).toContain('<Heading level={2}>Home</Heading>');
    expect(composition.source.match(/<logic>/g)).toHaveLength(1);
  });

  it('runs the manifest helpers once, before component and entry logic, and never a server file', () => {
    const files = project([
      {
        path: 'manifest.json',
        content: JSON.stringify({
          name: 'Helpers',
          main: 'ui/main.ui',
          files: { logic: ['logic/helpers.logic', 'logic/card.logic', 'logic/main.logic', 'logic/helpers.logic'] },
        }),
      },
      { path: 'ui/main.ui', content: '<logic src="../logic/main.logic" /><import Card from="./Card.ui" /><Card />' },
      { path: 'ui/Card.ui', content: '<logic src="../logic/card.logic" /><Text>{heading}</Text>' },
      { path: 'logic/main.logic', content: 'let heading = helperLabel + cardLabel;' },
      { path: 'logic/helpers.logic', content: 'import "./shared.logic";\nlet helperLabel = "From helper";' },
      { path: 'logic/card.logic', content: 'let cardLabel = helperLabel + " card";' },
      { path: 'logic/shared.logic', content: 'let shared = true;' },
      { path: 'server/api.logic', content: 'let serverOnly = true;' },
    ]);
    const { source } = composed(files);
    expect(source.indexOf('let helperLabel')).toBeLessThan(source.indexOf('let cardLabel'));
    expect(source.indexOf('let cardLabel')).toBeLessThan(source.indexOf('let heading'));
    expect(source.match(/let helperLabel/g)).toHaveLength(1);
    expect(source).toContain('import "logic/shared.logic";');
    expect(source).not.toContain('serverOnly');
  });

  it('refuses a <logic src> whose file is missing, as Run does, instead of previewing without it', () => {
    const files = project([{ path: 'ui/main.ui', content: '<logic src="../logic/missing.logic" />\n<Text>Hi</Text>' }]);
    const result = composePreviewProject(files, 'ui/main.ui');
    expect(result).toEqual({ ok: false, error: expect.stringContaining('logic/missing.logic is referenced by ui/main.ui but is not in the bundle') });
  });

  it('resolves a bare logic path from the importing file, as the runtime does, not from the bundle root', () => {
    const files = project([
      { path: 'ui/main.ui', content: '<logic src="logic/app.logic" />\n<Text>{label}</Text>' },
      { path: 'logic/app.logic', content: 'let label = "root";' },
    ]);
    const result = composePreviewProject(files, 'ui/main.ui');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('ui/logic/app.logic');
  });

  it('refuses references that traverse above the project root', () => {
    const files = project([
      { path: 'main.ui', content: '<logic src="../outside.logic" />\n<Stack />' },
      { path: 'outside.logic', content: 'let escaped = true;' },
    ]);
    const result = composePreviewProject(files, 'main.ui');
    expect(result.ok).toBe(false);
  });

  it('refuses an app that mixes JavaScript and Python logic', () => {
    const files = project([
      { path: 'ui/main.ui', content: '<logic src="../logic/main.py" />\n<logic>let js = 1</logic>\n<Text>x</Text>' },
      { path: 'logic/main.py', content: 'count = 0\n' },
    ]);
    const result = composePreviewProject(files, 'ui/main.ui');
    expect(!result.ok && result.error).toMatch(/mixes Python and JavaScript/);
  });

  it("rewrites an imported logic file's own imports relative to that file", async () => {
    const files = project([
      { path: 'ui/main.ui', content: '<logic src="../logic/main.logic" />\n<Text>x</Text>' },
      { path: 'logic/main.logic', content: 'import "./lib/util.logic";\nlet x = 1;' },
      { path: 'logic/lib/util.logic', content: 'import "./deeper.logic";\nlet util = 1;' },
      { path: 'logic/lib/deeper.logic', content: 'let deeper = 1;' },
    ]);
    const { importResolver } = composed(files);
    expect(await importResolver('logic/lib/util.logic')).toBe('import "logic/lib/deeper.logic";\nlet util = 1;');
    expect(await importResolver('logic/nope.logic')).toBeNull();
  });

  it('never resolves private editor state as a logic import', async () => {
    const files = project([
      { path: 'ui/main.ui', content: '<Text>x</Text>' },
      { path: 'builder/notes.logic', content: 'let secret = 1;' },
    ]);
    expect(await composed(files).importResolver('builder/notes.logic')).toBeNull();
  });
});

describe('template comment stripping in the preview', () => {
  it('keeps markup between a MIME wildcard and a later */ in the template', () => {
    const source = '<FileChooser accept="image/*" />\n<Text>Keep me</Text>\n<Text>{a */ b}</Text>';
    const out = stripTemplateComments(source);
    expect(out).toContain('<Text>Keep me</Text>');
    expect(out).toContain('accept="image/*"');
  });

  it("removes a template's // line comments and leaves logic and style alone", () => {
    const source = '// a note\n<Text>Shown</Text>\n<logic>\n// kept\nlet x = "/*"\n</logic>';
    const out = stripTemplateComments(source);
    expect(out).not.toContain('a note');
    expect(out).toContain('<Text>Shown</Text>');
    expect(out).toContain('// kept\nlet x = "/*"');
  });
});

describe('Studio preview data', () => {
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
