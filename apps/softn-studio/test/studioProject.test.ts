/**
 * What the generator does with text it did not write.
 *
 * Everything scaffoldProjectFiles interpolates is untrusted: the app name and
 * description are whatever the user typed into the brief, and page and
 * collection names can come straight back from the model. The generator built
 * HTML and JavaScript by string concatenation with no escaping at all, so a
 * name of `</title><script>…</script>` injected into the head of every generated
 * page, and — worse, because an HTML escaper is no help there — the same name
 * went inside a JavaScript string literal in generated logic, where a quote
 * closed the literal and ran whatever followed.
 */

import { describe, it, expect } from 'vitest';
import { generateBlueprintFromBrief, scaffoldProjectFiles } from '../src/lib/studioProject';
import type { ProjectBrief } from '../src/types/studio';

function scaffold(overrides: Partial<ProjectBrief>) {
  const brief: ProjectBrief = {
    appName: 'Test App',
    description: 'A description.',
    target: 'web',
    style: 'clean',
    pages: ['Home'],
    collections: [],
    authNeeded: false,
    ...overrides,
  } as ProjectBrief;
  return scaffoldProjectFiles(brief, generateBlueprintFromBrief(brief));
}

const html = (files: Array<{ path: string; content: unknown }>) =>
  files.filter((f) => f.path.endsWith('.html')).map((f) => String(f.content)).join('\n');

describe('an app name carrying markup', () => {
  const files = scaffold({ appName: 'PWN</title><script>alert(1)</script>' });

  it('never reaches generated HTML as markup', () => {
    const out = html(files);
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).not.toContain('</title><script>');
  });

  it('is still shown to the user, escaped', () => {
    expect(html(files)).toContain('PWN&lt;/title&gt;');
  });
});

describe('a description carrying an event handler', () => {
  it('does not survive as an attribute', () => {
    const files = scaffold({ description: 'PWN<img src=x onerror="alert(2)">' });
    const out = html(files);
    expect(out).not.toContain('onerror="alert(2)"');
    expect(out).toContain('&lt;img src=x');
  });
});

describe('a collection name carrying markup', () => {
  it('is escaped in the cards it appears on', () => {
    const files = scaffold({ collections: ['PWN<b>Widgets</b>'] });
    const out = html(files);
    expect(out).not.toContain('<b>Widgets</b>');
  });
});

describe('generated logic', () => {
  it('still parses when the app name contains a quote', () => {
    // The payload that made this necessary: a name that closes the string
    // literal it is interpolated into and appends a statement.
    const files = scaffold({ appName: 'x"); globalThis.__pwned = true; ("' });
    const logic = files.find((f) => f.path.endsWith('.logic'));
    expect(logic).toBeDefined();
    expect(() => new Function(String(logic!.content))).not.toThrow();
  });

  it('does not let the app name become code', () => {
    const files = scaffold({ appName: 'x"); globalThis.__pwned = true; ("' });
    const logic = String(files.find((f) => f.path.endsWith('.logic'))!.content);
    // The name is present as data, and the statement it tried to smuggle is not
    // sitting at the top level where it would run.
    expect(logic).toContain('__pwned');
    expect(logic).not.toMatch(/^\s*globalThis\.__pwned/m);
  });

  it('survives a newline in the app name', () => {
    const files = scaffold({ appName: 'line one\nline two' });
    const logic = String(files.find((f) => f.path.endsWith('.logic'))!.content);
    expect(() => new Function(logic)).not.toThrow();
  });
});

describe('a name that is only punctuation', () => {
  it('still produces a usable page filename', () => {
    const files = scaffold({ pages: ['///'] });
    const pages = files.filter((f) => f.path.endsWith('.html')).map((f) => f.path);
    expect(pages.length).toBeGreaterThan(0);
    for (const p of pages) expect(p).toMatch(/^pages\/[a-z0-9-]+\.html$/);
  });
});
