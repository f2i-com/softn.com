/**
 * App URLs under a deployment base.
 *
 * The router used to spell its routes as literals beginning with "/app/", so a
 * build served from /web/ wrote URLs it could not read back: every reload, and
 * every browser Back, dropped the user on Home.
 */

import { describe, it, expect } from 'vitest';
import { parseAppPath, buildAppPath, publicPath, savedOnlyName, tabAddress, tabLink } from '../src/lib/appUrl';

describe('the address a tab is at', () => {
  it('writes no slash into the path, which Apache answers with its own 404 before any rule runs', () => {
    expect(buildAppPath(tabAddress({ name: 'My/App' }), null, '/web/')).toBe('/web/app/~My~2FApp');
    expect(buildAppPath(tabAddress({ name: 'My\\App' }), null, '/web/')).toBe('/web/app/~My~5CApp');
  });

  it.each(['My/App', 'a/b/c.d', '/', 'Back\\slash', '%', '100%25', 'a%2Fb', '~', '~odd', 'x~2Fy', '~7E', '~~', '.', '..', 'Notes v1.2', 'Émile', '長い名前', 'a?b#c'])('reads %j back as it was written', (name) => {
    const url = buildAppPath(tabAddress({ name }), 'settings', '/web/');
    const { appName, page } = parseAppPath(url, '/web/');
    expect(savedOnlyName(appName!)).toBe(name);
    expect(page).toBe('settings');
  });

  it('keeps a slash in a page a slash, for the same reason', () => {
    const url = buildAppPath('notes', 'admin/users', '/web/');
    expect(url).toBe('/web/app/notes/admin/users');
    expect(parseAppPath(url, '/web/')).toEqual({ appName: 'notes', page: 'admin/users' });
  });

  it.each(['../twenty48', '../../../publish', 'a/../../b', '..', '.', './x', 'a//b', '/a', 'a/'])('writes no address for a page called %j, which the browser would collapse into another', (page) => {
    const url = buildAppPath('notes', page, '/web/');
    expect(url).toBe('/web/app/notes');
    expect(new URL(url, 'https://softn.example').pathname).toBe('/web/app/notes');
  });

  it.each(['...', '..a', 'a..', 'v1.2', '.hidden', '%2e%2e', '..\\..\\x'])('keeps a page called %j, which is no step in a path', (page) => {
    const url = buildAppPath('notes', page, '/web/');
    expect(new URL(url, 'https://softn.example').pathname.startsWith('/web/app/notes/')).toBe(true);
    expect(parseAppPath(url, '/web/')).toEqual({ appName: 'notes', page });
  });

  it('keeps where an app opened by a link came from, and nothing for the directory', () => {
    expect(tabLink({ bundleUrl: 'https://softn.example/demos/Twenty48.softn' })).toBe('/demos/Twenty48.softn');
    expect(tabLink({ bundleUrl: 'https://softn.example/x.softn?v=2' })).toBe('/x.softn?v=2');
    expect(tabLink({ bundleUrl: 'https://softn.example/api/apps/notes/bundle.softn', directorySlug: 'notes' })).toBeNull();
    expect(tabLink({})).toBeNull();
  });

  it('is a directory app’s slug, whatever its bundle calls itself', () => {
    expect(tabAddress({ name: 'notes', directorySlug: 'my-team-board' })).toBe('my-team-board');
    expect(savedOnlyName('my-team-board')).toBeNull();
  });

  it('marks an app with no directory page, so that no name reads as a slug', () => {
    expect(tabAddress({ name: 'notes' })).toBe('~notes');
    expect(savedOnlyName('~notes')).toBe('notes');
    expect(savedOnlyName(tabAddress({ name: '~odd' }))).toBe('~odd');
  });

  it('survives the address bar, spaces and all', () => {
    const url = buildAppPath(tabAddress({ name: 'My Notes' }), null, '/web/');
    expect(url).toBe('/web/app/~My%20Notes');
    expect(savedOnlyName(parseAppPath(url, '/web/').appName!)).toBe('My Notes');
  });
});

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
    expect(url).toBe('/web/app/a%2Fb/c/d');
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
