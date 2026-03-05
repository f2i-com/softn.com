import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { readZip, processBundle } from '../src/lib/bundleProcessor';

function makeZip(files: Record<string, string | Uint8Array>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    entries[path] = typeof content === 'string' ? strToU8(content) : content;
  }
  return zipSync(entries, { level: 6 });
}

describe('bundleProcessor', () => {
  it('inlines nested imports and logic files', () => {
    const zip = makeZip({
      'manifest.json': JSON.stringify({
        name: 'Test',
        version: '1.0.0',
        main: 'ui/main.ui',
        files: { ui: ['ui/main.ui', 'ui/components/Inner.ui'], logic: ['logic/main.logic'], xdb: [], assets: [] },
      }),
      'ui/main.ui': [
        '<import Inner from="./components/Inner.ui" />',
        '<logic src="../logic/main.logic" />',
        '<div><Inner /></div>',
      ].join('\n'),
      'ui/components/Inner.ui': [
        '<import Leaf from="./Leaf.ui" />',
        '<div><Leaf /></div>',
      ].join('\n'),
      'ui/components/Leaf.ui': '<span>Leaf</span>',
      'logic/main.logic': 'let counter = 0;',
    });

    const { textFiles } = readZip(zip);
    const { source } = processBundle(textFiles, {
      name: 'Test',
      version: '1.0.0',
      main: 'ui/main.ui',
      files: {},
    });

    expect(source).toContain('<span>Leaf</span>');
    expect(source).toContain('<logic>');
    expect(source).toContain('let counter = 0;');
    expect(source).not.toContain('<import');
  });

  it('skips circular imports without crashing', () => {
    const zip = makeZip({
      'manifest.json': JSON.stringify({
        name: 'Test',
        version: '1.0.0',
        main: 'ui/main.ui',
        files: { ui: ['ui/main.ui', 'ui/A.ui', 'ui/B.ui'], logic: [], xdb: [], assets: [] },
      }),
      'ui/main.ui': '<import A from="./A.ui" /><A />',
      'ui/A.ui': '<import B from="./B.ui" /><div>A<B /></div>',
      'ui/B.ui': '<import A from="./A.ui" /><div>B</div>',
    });

    const { textFiles } = readZip(zip);
    const { source } = processBundle(textFiles, {
      name: 'Test',
      version: '1.0.0',
      main: 'ui/main.ui',
      files: {},
    });

    expect(source).toContain('<div>A');
    expect(source).toContain('<div>B</div>');
  });

  it('rejects oversize bundle input', () => {
    const tooLarge = new Uint8Array(210 * 1024 * 1024);
    expect(() => readZip(tooLarge)).toThrow('Bundle too large');
  });
});
