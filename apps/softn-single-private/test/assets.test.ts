import { expect, it } from 'vitest';
import { createServedAssetResolver, entryUrl } from '../src/assets';

const endpoint = '/games/index.php';
const entries = new Set(['images/hero.png', 'models/hero/hero.gltf', 'models/hero/hero.bin']);
const text = new Map([['data/levels.json', '{"levels":[]}']]);

it('answers a served entry with a same-origin URL under the endpoint', () => {
  const assets = createServedAssetResolver(endpoint, entries, text);
  expect(assets('images/hero.png')).toBe('/games/index.php?entry=images/hero.png');
  expect(assets('./images/hero.png')).toBe('/games/index.php?entry=images/hero.png');
  expect(assets('images/hero.png')).toBe(assets('images/hero.png'));
  assets.dispose();
});

it('keeps the URL free of a scheme so the markup judge treats it as this origin', () => {
  const url = entryUrl(endpoint, 'sounds/a b&c.wav');
  expect(url).toBe('/games/index.php?entry=sounds/a%20b%26c.wav');
  expect(/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)).toBe(false);
  expect(url.startsWith('//')).toBe(false);
});

it('maps a minted URL back to the bundle path for model loaders', () => {
  const assets = createServedAssetResolver(endpoint, entries, text);
  const url = assets('models/hero/hero.gltf');
  expect(assets.pathOf(url)).toBe('models/hero/hero.gltf');
  expect(assets.pathOf('/games/index.php?entry=models/hero/other.gltf')).toBeUndefined();
  assets.dispose();
  expect(assets.pathOf(url)).toBeUndefined();
});

it('serves a text entry from the pack as a blob URL with its MIME type', () => {
  const assets = createServedAssetResolver(endpoint, entries, text);
  const url = assets('data/levels.json');
  expect(url).toMatch(/^blob:/);
  expect(assets.pathOf(url)).toBe('data/levels.json');
  assets.dispose();
  expect(assets('data/levels.json')).toBe('');
});

it.each(['../secret.png', '/etc/passwd', 'C:/x.png', '', 'missing.png'])(
  'answers nothing for %j',
  (path) => {
    const assets = createServedAssetResolver(endpoint, entries, text);
    expect(assets(path)).toBe('');
    assets.dispose();
  }
);

it('refuses an endpoint that is not a path on this origin', () => {
  expect(() =>
    createServedAssetResolver('https://example.test/index.php', entries, text)
  ).toThrow();
  expect(() => createServedAssetResolver('//example.test/index.php', entries, text)).toThrow();
  expect(() => createServedAssetResolver('index.php', entries, text)).toThrow();
});
