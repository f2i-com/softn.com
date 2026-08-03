import { describe, expect, it } from 'vitest';
import type { Plugin } from 'vite';
import softnPlugin from '../src/index';

const SOURCE = '<div>Hello</div>';

interface PluginTransformResult {
  code: string;
  map?: unknown;
}

function transform(
  plugin: Plugin,
  code = SOURCE,
  id = '/src/view.softn'
): PluginTransformResult | null {
  const hook = plugin.transform;
  if (!hook) throw new Error('transform hook is missing');
  const handler = (typeof hook === 'function' ? hook : hook.handler) as unknown as (
    this: { error(error: unknown): never },
    source: string,
    file: string
  ) => PluginTransformResult | string | null | Promise<PluginTransformResult | string | null>;
  const result = handler.call(
    {
      error(error: unknown): never {
        throw error instanceof Error ? error : new Error(JSON.stringify(error));
      },
    } as never,
    code,
    id
  );
  if (result instanceof Promise) throw new Error('expected the SoftN transform to be synchronous');
  if (typeof result === 'string') return { code: result };
  return result;
}

describe('SoftN Vite transform', () => {
  it('keeps source maps on cache hits', () => {
    const plugin = softnPlugin({ cache: true, sourceMaps: true });

    const first = transform(plugin)!;
    const cached = transform(plugin)!;

    expect(first.map).toBeTruthy();
    expect(cached.map).toEqual(first.map);
  });

  it('does not share option-dependent output between plugin instances', () => {
    const withoutHmr = transform(softnPlugin({ hmr: false }), SOURCE, '/src/shared.softn');
    const withHmr = transform(softnPlugin({ hmr: true }), SOURCE, '/src/shared.softn');

    expect((withoutHmr as { code: string }).code).not.toContain('import.meta.hot.accept');
    expect((withHmr as { code: string }).code).toContain('import.meta.hot.accept');
  });

  it('handles stateful include regexes consistently', () => {
    const plugin = softnPlugin({ include: [/\.softn$/g], cache: false });

    expect(transform(plugin, SOURCE, '/src/first.softn')).not.toBeNull();
    expect(transform(plugin, SOURCE, '/src/second.softn')).not.toBeNull();
  });

  it('generates a valid component identifier from Windows and numeric file names', () => {
    const result = transform(pluginWithoutSourceMaps(), SOURCE, 'C:\\views\\123 bad-name.softn');

    expect((result as { code: string }).code).toContain('function SoftN123BadName(props)');
  });
});

function pluginWithoutSourceMaps(): Plugin {
  return softnPlugin({ sourceMaps: false });
}
