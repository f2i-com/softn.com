import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { composePreviewBundle, createPreviewAssets } from './previewBundle';
import { loadBundle } from './bundleLoader';
import { parseBundle } from './bundleExporter';
import { commitProjectSnapshot, prepareProjectSnapshot, captureSession, prepareSessionSnapshot } from './openProject';
import { buildProjectBundle } from './buildProjectBundle';
import { useProjectStore } from '../stores/projectStore';
import { useFilesStore } from '../stores/filesStore';
import { useSchemaStore } from '../stores/schemaStore';
import { useCanvasStore } from '../stores/canvasStore';

const ui = '<logic src="../logic/main.logic" /><App><Heading>{title}</Heading><Image src={asset("images/logo.svg")} /></App>';
const manifest = {
  name: 'Portable app', version: '1.0.0', main: 'screens/start.ui',
  files: { ui: ['screens/start.ui'], logic: ['logic/z-base.logic', 'logic/a-derived.logic', 'logic/main.logic'], xdb: [], assets: ['images/logo.svg'] },
};
const texts = new Map([
  ['screens/start.ui', ui],
  ['logic/z-base.logic', 'let baseTitle = "Portable";'],
  ['logic/a-derived.logic', 'let helperTitle = baseTitle + " app";'],
  ['logic/main.logic', 'import "./z-base.logic";\nlet title = helperTitle;'],
]);
const svg = strToU8('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>');
const fixture = () => zipSync({
  'manifest.json': strToU8(JSON.stringify(manifest)),
  ...Object.fromEntries([...texts].map(([path, text]) => [path, strToU8(text)])),
  'images/logo.svg': svg,
});

beforeEach(() => {
  useProjectStore.getState().reset(); useFilesStore.getState().reset();
  useSchemaStore.getState().reset(); useCanvasStore.getState().reset();
});
afterEach(() => vi.restoreAllMocks());

describe('portable Builder preview', () => {
  it('preloads helpers in manifest order and deduplicates imports like the runtime', async () => {
    const result = composePreviewBundle(texts, 'screens/start.ui', manifest);
    expect(result.source.indexOf('let baseTitle')).toBeLessThan(result.source.indexOf('let helperTitle'));
    expect(result.source.indexOf('let helperTitle')).toBeLessThan(result.source.indexOf('let title'));
    expect(result.logicBasePath).toBe('logic/main.logic');
    expect(result.preIncludedLogicPaths).toEqual(['logic/z-base.logic', 'logic/a-derived.logic']);
    expect(result.source).toContain('import "logic/z-base.logic";');
    expect(await result.importResolver('logic/main.logic')).toContain('import "logic/z-base.logic";');
  });

  it('keeps asset paths and helper order through open, save and recovery', async () => {
    commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(fixture())));
    expect([...useFilesStore.getState().nodes.values()].some((node) => node.path === 'images/logo.svg')).toBe(true);
    // A store rebuild must not alphabetically reorder the retained declaration.
    useFilesStore.setState({ logicFiles: new Map([...useFilesStore.getState().logicFiles.entries()].sort((a, b) => a[1].path.localeCompare(b[1].path))) });
    const first = parseBundle(await buildProjectBundle());
    expect(first.manifest.files.logic).toEqual(manifest.files.logic);
    expect(first.files.get('images/logo.svg')).toEqual(svg);
    expect(first.files.has('assets/images/logo.svg')).toBe(false);
    const recovery = JSON.stringify(captureSession('preview'));
    commitProjectSnapshot(prepareSessionSnapshot(recovery));
    const restored = parseBundle(await buildProjectBundle());
    expect(restored.files.get('images/logo.svg')).toEqual(svg);
    expect(restored.manifest.main).toBe('screens/start.ui');
  });

  it('exports asset file renames and deletions from the current file tree', async () => {
    commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(fixture())));
    const id = [...useFilesStore.getState().nodes.values()].find((node) => node.path === 'images/logo.svg')!.id;
    useFilesStore.getState().renameFile(id, 'new-logo.svg');
    const renamed = parseBundle(await buildProjectBundle());
    expect(renamed.files.get('images/new-logo.svg')).toEqual(svg);
    expect(renamed.files.has('images/logo.svg')).toBe(false);
    useFilesStore.getState().deleteFile(id);
    const removed = parseBundle(await buildProjectBundle());
    expect(removed.manifest.files.assets).toEqual([]);
  });

  it('provides real image URLs and releases them when preview assets are replaced', () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview-logo');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const assets = createPreviewAssets(new Map([['images/logo.svg', { name: 'logo.svg', type: 'image/svg+xml', data: svg }]]));
    expect(assets('images/logo.svg')).toBe('blob:preview-logo');
    expect(assets('./images/logo.svg')).toBe('blob:preview-logo');
    expect(assets.pathOf?.('blob:preview-logo')).toBe('images/logo.svg');
    expect((create.mock.calls[0][0] as Blob).type).toBe('image/svg+xml');
    expect(create).toHaveBeenCalledTimes(1);
    assets.dispose?.();
    expect(revoke).toHaveBeenCalledWith('blob:preview-logo');
    expect(assets('images/logo.svg')).toBe('');
  });
});
