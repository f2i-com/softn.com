/**
 * The bundle writer's names and a page's own logic file.
 *
 * - A name that is not ASCII is written as UTF-8 and flagged so (general
 *   purpose bit 11), in the local header and the central directory, so zip
 *   tools that follow the format read `café.ui`, not `cafÃ©.ui`. ASCII names
 *   are written as before, unflagged.
 * - A page's logic is the file of the page's own name with `.logic` for its
 *   `.ui`, not the path with its first `.ui` anywhere swapped.
 */
import { describe, expect, it } from 'vitest';
import { createBundleFromFiles, readBundle } from '../src/bundle/bundle';
import { createBundleRuntime } from '../src/bundle/runtime';
import type { SoftNBundle } from '../src/bundle/types';

/** Every entry's name and flags, from the local headers and the central directory. */
function headerFlags(zip: Uint8Array): { local: Map<string, number>; central: Map<string, number> } {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const decoder = new TextDecoder();
  const local = new Map<string, number>();
  const central = new Map<string, number>();
  for (let p = 0; p + 4 <= zip.length; ) {
    const signature = view.getUint32(p, true);
    if (signature === 0x04034b50) {
      const nameLength = view.getUint16(p + 26, true);
      const size = view.getUint32(p + 18, true);
      local.set(decoder.decode(zip.subarray(p + 30, p + 30 + nameLength)), view.getUint16(p + 6, true));
      p += 30 + nameLength + view.getUint16(p + 28, true) + size;
    } else if (signature === 0x02014b50) {
      const nameLength = view.getUint16(p + 28, true);
      central.set(decoder.decode(zip.subarray(p + 46, p + 46 + nameLength)), view.getUint16(p + 8, true));
      p += 46 + nameLength + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
    } else break;
  }
  return { local, central };
}

describe('the bundle writer', () => {
  it('flags a name that is not ASCII as UTF-8 and leaves ASCII names unflagged', async () => {
    const zip = await createBundleFromFiles(
      { name: 'Names', version: '1.0.0', main: 'main.ui', files: { ui: ['main.ui', 'café.ui'] } } as never,
      new Map<string, string | Uint8Array>([
        ['main.ui', '<div>main</div>'],
        ['café.ui', '<div>café</div>'],
        ['assets/日本.txt', '日本'],
      ])
    );
    const { local, central } = headerFlags(zip);
    for (const headers of [local, central]) {
      expect(headers.get('café.ui')! & 0x0800).toBe(0x0800);
      expect(headers.get('assets/日本.txt')! & 0x0800).toBe(0x0800);
      expect(headers.get('main.ui')).toBe(0);
      expect(headers.get('manifest.json')).toBe(0);
    }
    // And the archive reads back whole: every checksum is the bytes' own.
    const bundle = await readBundle(zip);
    expect(bundle.files.get('café.ui')?.content).toBe('<div>café</div>');
    expect(bundle.files.get('main.ui')?.content).toBe('<div>main</div>');
  });
});

describe("a page's own logic file", () => {
  const bundleOf = (files: Record<string, string>): SoftNBundle => ({
    manifest: { name: 'Logic', version: '1.0.0', main: Object.keys(files)[0], files: { ui: [] } } as never,
    files: new Map(Object.entries(files).map(([path, content]) => [path, { path, type: path.endsWith('.logic') ? 'logic' : 'ui', content, size: content.length }] as const)) as never,
    uiFiles: new Map(),
    logicFiles: new Map(),
    xdbData: new Map(),
  });

  it('is the page name with .logic for its .ui, wherever else ".ui" appears in the path', () => {
    const runtime = createBundleRuntime(
      bundleOf({
        'kit.ui/page.ui': '<div>{greeting}</div>',
        'kit.ui/page.logic': 'let greeting = "hello"',
        'kit.logic/page.ui': 'let wrong = "the first .ui swapped"',
      })
    );
    const doc = runtime.parseUI('kit.ui/page.ui');
    expect(doc.logic?.code).toContain('greeting = "hello"');
    expect(doc.logic?.code ?? '').not.toContain('wrong');
    runtime.dispose?.();
  });

  it('is not looked for at all for a page whose name does not end in .ui', () => {
    const runtime = createBundleRuntime(bundleOf({ 'page.softn.html': '<div>plain</div>' }));
    const doc = runtime.parseUI('page.softn.html');
    // Before, the lookup found the page itself and wrapped it as its own logic.
    expect(doc.logic).toBeUndefined();
    runtime.dispose?.();
  });
});
