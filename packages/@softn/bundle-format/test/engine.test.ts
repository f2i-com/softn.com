/**
 * Which engine runs a bundle: the one rule every runtime, editor and server reader applies.
 * The PHP readers (apps/softn-api/lib/bundle.php, the single-app host's softn-serve.php)
 * carry it in their own language and are held to the same cases by their own suites.
 */
import { describe, expect, it } from 'vitest';
import { declaresContainer, manifestRunsInContainer, zeroConfigEntry } from '../src/engine';

describe('a manifest that says its bundle runs in the web container', () => {
  it('says "engine": 2, as a number, or "container": true', () => {
    expect(declaresContainer({ engine: 2 })).toBe(true);
    expect(declaresContainer({ container: true })).toBe(true);
    // JSON has one kind of number: 2.0 and 2e0 are 2.
    expect(declaresContainer(JSON.parse('{"engine":2.0}'))).toBe(true);
    expect(declaresContainer(JSON.parse('{"engine":2e0}'))).toBe(true);
  });

  it('says nothing by anything that only looks like it', () => {
    for (const manifest of [{}, { engine: '2' }, { engine: [2] }, { engine: 1 }, { engine: 2.5 }, { engine: true }, { container: 1 }, { container: 'true' }, { Engine: 2 }]) {
      expect(declaresContainer(manifest), JSON.stringify(manifest)).toBe(false);
    }
    for (const notAManifest of [null, undefined, 2, 'engine', [{ engine: 2 }]]) {
      expect(declaresContainer(notAManifest), JSON.stringify(notAManifest)).toBe(false);
    }
  });
});

describe('a project the editors show as a web container', () => {
  it('says so, over a page', () => {
    expect(manifestRunsInContainer({ engine: 2, main: 'index.html' })).toBe(true);
    expect(manifestRunsInContainer({ engine: 2, main: 'pages/Home.HTM' })).toBe(true);
    expect(manifestRunsInContainer({ container: true, main: 'app.html' })).toBe(true);
    // No entry named yet: a project being written.
    expect(manifestRunsInContainer({ engine: 2 })).toBe(true);
    expect(manifestRunsInContainer({ engine: 2, main: '' })).toBe(true);
  });

  it('is the SoftN bundle its entry is, when the entry is not a page, whatever the manifest says', () => {
    // Every runtime runs these on SoftN's engine: the container reads pages, not `.ui`.
    expect(manifestRunsInContainer({ engine: 2, main: 'ui/main.ui' })).toBe(false);
    expect(manifestRunsInContainer({ container: true, main: 'main.ui' })).toBe(false);
    expect(manifestRunsInContainer({ main: 'index.html' })).toBe(false);
    expect(manifestRunsInContainer(null)).toBe(false);
  });
});

describe('the page a bundle with no manifest opens', () => {
  it('is index.html, else app.html, else the first page at the root by name', () => {
    expect(zeroConfigEntry(['z.html', 'index.html', 'app.html'])).toBe('index.html');
    expect(zeroConfigEntry(['z.html', 'app.html', 'a.html'])).toBe('app.html');
    expect(zeroConfigEntry(['b.html', 'a.htm', 'style.css'])).toBe('a.htm');
    expect(zeroConfigEntry(['home.html'])).toBe('home.html');
  });

  it('is none for an archive with no page at its root', () => {
    expect(zeroConfigEntry(['readme.md', 'pages/index.htm', 'pages/about.html'])).toBeNull();
    expect(zeroConfigEntry([])).toBeNull();
    // A page in a folder is not the root's, though index.html anywhere else would not be either.
    expect(zeroConfigEntry(['site/index.html'])).toBeNull();
  });
});
