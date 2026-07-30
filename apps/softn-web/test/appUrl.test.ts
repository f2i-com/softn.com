/**
 * App URLs under a deployment base.
 *
 * The router used to spell its routes as literals beginning with "/app/", so a
 * build served from /web/ wrote URLs it could not read back: every reload, and
 * every browser Back, dropped the user on Home.
 */

import { describe, it, expect } from 'vitest';
import { parseAppPath, buildAppPath, publicPath } from '../src/lib/appUrl';

describe('at the site root', () => {
  it('round-trips an app', () => {
    expect(buildAppPath('SnakeGame', null, '/')).toBe('/app/SnakeGame');
    expect(parseAppPath('/app/SnakeGame', '/')).toEqual({ appName: 'SnakeGame', page: null });
  });

  it('round-trips a page within an app', () => {
    const url = buildAppPath('SnakeGame', 'settings', '/');
    expect(url).toBe('/app/SnakeGame/settings');
    expect(parseAppPath(url, '/')).toEqual({ appName: 'SnakeGame', page: 'settings' });
  });

  it('sends Home to the base itself', () => {
    expect(buildAppPath(null, null, '/')).toBe('/');
    expect(parseAppPath('/', '/')).toEqual({ appName: null, page: null });
  });
});

describe('under a subpath', () => {
  it('round-trips an app and a page', () => {
    const url = buildAppPath('SnakeGame', 'settings', '/web/');
    expect(url).toBe('/web/app/SnakeGame/settings');
    expect(parseAppPath(url, '/web/')).toEqual({ appName: 'SnakeGame', page: 'settings' });
  });

  it('reads a base written without its trailing slash the same way', () => {
    expect(buildAppPath('SnakeGame', null, '/web')).toBe('/web/app/SnakeGame');
    expect(parseAppPath('/web/app/SnakeGame', '/web')).toEqual({ appName: 'SnakeGame', page: null });
  });

  it('sends Home to the base rather than to the site root', () => {
    expect(buildAppPath(null, null, '/web/')).toBe('/web/');
  });

  it('does not answer to the root-relative form of its own routes', () => {
    // The bug this whole module exists for: /app/SnakeGame belongs to whatever
    // else is deployed at the root, not to this build.
    expect(parseAppPath('/app/SnakeGame', '/web/')).toEqual({ appName: null, page: null });
  });
});

describe('names that need encoding', () => {
  it('round-trips a space', () => {
    const url = buildAppPath('AI Chat', null, '/');
    expect(url).toBe('/app/AI%20Chat');
    expect(parseAppPath(url, '/')).toEqual({ appName: 'AI Chat', page: null });
  });

  it('round-trips a slash without inventing a page segment', () => {
    const url = buildAppPath('a/b', 'c/d', '/web/');
    expect(url).toBe('/web/app/a%2Fb/c%2Fd');
    expect(parseAppPath(url, '/web/')).toEqual({ appName: 'a/b', page: 'c/d' });
  });

  it("round-trips an apostrophe and a hash", () => {
    const url = buildAppPath("Texas Hold'em", '#1', '/');
    expect(parseAppPath(url, '/')).toEqual({ appName: "Texas Hold'em", page: '#1' });
  });

  it('treats a half-written escape as no route at all', () => {
    // decodeURIComponent throws on a lone percent sign, which would otherwise
    // take the whole shell down before it rendered.
    expect(parseAppPath('/app/%', '/')).toEqual({ appName: null, page: null });
  });
});

describe('paths to files shipped in public/', () => {
  it('follows the base', () => {
    expect(publicPath('demos/index.json', '/')).toBe('/demos/index.json');
    expect(publicPath('demos/index.json', '/web/')).toBe('/web/demos/index.json');
    expect(publicPath('/demos/index.json', '/web')).toBe('/web/demos/index.json');
  });
});
