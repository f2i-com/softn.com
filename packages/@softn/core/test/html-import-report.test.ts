/**
 * What the report says of representative HTML pages (test/fixtures/html-import): a plain site carries across, a page's
 * own code is read as SoftN reads it with every handler and script named, and what does not run — code and stylesheets
 * from other sites, packages, other kinds of import, embeds, PHP, a form that leaves the app — is unsupported with what
 * to do instead. The report reads; it never runs a page's code.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reportHtmlImport, type HtmlImportReport, type ImportNote } from '../src/bundle/html-import-report';

const page = (name: string) => readFileSync(join(__dirname, 'fixtures/html-import', name), 'utf8');
const find = (report: HtmlImportReport, pattern: RegExp) => report.notes.filter((n) => pattern.test(n.what));
const one = (report: HtmlImportReport, pattern: RegExp): ImportNote => {
  const found = find(report, pattern);
  expect(found, `one note for ${pattern}: ${report.notes.map((n) => n.what).join(' / ')}`).toHaveLength(1);
  return found[0];
};

afterEach(() => {
  delete (globalThis as { reportRan?: boolean }).reportRan;
});

describe('an HTML page brought into SoftN', () => {
  it('a plain site carries across, and its own files are checked', () => {
    const report = reportHtmlImport(page('static-site.html'), { files: ['index.html', 'styles.css', 'menu.html'] });
    expect(one(report, /<link rel="stylesheet" href="styles.css">/).verdict).toBe('supported');
    expect(one(report, /^A <style> block/).verdict).toBe('supported');
    expect(one(report, /<form> with no action/).verdict).toBe('supported');
    const image = one(report, /images\/loaf.jpg/);
    expect([image.verdict, image.line, image.instead]).toEqual(['unsupported', 19, 'Add the file to the project, at that path from its root.']);
    expect(one(report, /kinds of HTML element/).what).toContain('<header>');
    expect(report.unsupported).toBe(1);
    // Without a file list, nothing is said of files.
    expect(reportHtmlImport(page('static-site.html')).unsupported).toBe(0);
  });

  it('a page’s own code is read as SoftN reads it, and every script and handler is named', () => {
    const report = reportHtmlImport(page('interactive.html'), { files: ['index.html', 'tasks.js'] });
    expect(one(report, /<script src="tasks.js"> becomes the page’s logic/).verdict).toBe('converted');
    expect(one(report, /inline <script>/).line).toBe(12);
    expect(one(report, /1 inline handler/).verdict).toBe('converted');
    expect(one(report, /^fetch:/).what).toContain('permission.json');
    expect(one(report, /through document/).verdict).toBe('converted');
    const ask = one(report, /confirm\(\) and prompt\(\)/);
    expect([ask.verdict, ask.instead]).toEqual(['unsupported', 'Ask with a <Confirm> or a field on the page.']);
    expect(report.notes.every((n) => n.verdict !== 'unsupported' || n.instead), 'everything that does not run says what to do instead').toBe(true);
  });

  it('code, stylesheets and packages from elsewhere do not run, and say what to do instead', () => {
    const report = reportHtmlImport(page('cdn-react.html'));
    const scripts = find(report, /code from another site is not loaded/);
    expect(scripts.map((n) => n.line)).toEqual([6, 7]);
    expect(scripts.every((n) => n.verdict === 'unsupported' && /Copy the code into a file/.test(n.instead ?? ''))).toBe(true);
    expect(one(report, /fonts.googleapis.com/).feature).toBe('css');
    expect(one(report, /A package is imported \("react"\)/).verdict).toBe('unsupported');
    expect(one(report, /"\.\/chart\.js" is imported as a default/).instead).toBe('Import the names themselves: import { name } from "./chart.js".');
    expect(one(report, /WebSocket/).instead).toMatch(/Use fetch/);
    expect(report.notes[0].verdict, 'what will not run comes first').toBe('unsupported');
  });

  it('server code, embeds, a form that leaves the app and the head’s redirects are named', () => {
    const report = reportHtmlImport(page('server-form.html'));
    expect(one(report, /PHP in the page/).feature).toBe('server');
    expect(one(report, /<iframe> of https:\/\/www.youtube.com\/embed\/abc is not drawn/).verdict).toBe('unsupported');
    const form = one(report, /form action="https:\/\/example.com\/contact.php"/);
    expect([form.verdict, form.instead]).toEqual(['converted', 'To keep the person in the app, leave out action and handle the submit (onsubmit, or @submit.prevent) with fetch.']);
    expect(one(report, /<base> is passed over/).verdict).toBe('unsupported');
    expect(one(report, /http-equiv="refresh"/).verdict).toBe('unsupported');
  });

  it('framework syntax is reported in the parser’s own words', () => {
    const report = reportHtmlImport('<div v-if="open">{{ name }}</div>');
    const framework = report.notes.filter((n) => n.feature === 'framework');
    expect(framework.map((n) => n.verdict)).toEqual(['unsupported', 'unsupported']);
    expect(framework[0].what).toContain('Vue');
    expect(framework.every((n) => n.instead?.includes('SoftN’s syntax'))).toBe(true);
  });

  it('reads a page without running any of it', () => {
    const hostile = '<script>globalThis.reportRan = true</script><img src=x onerror="globalThis.reportRan = true"><a href="javascript:globalThis.reportRan=true">x</a>';
    const report = reportHtmlImport(hostile);
    expect((globalThis as { reportRan?: boolean }).reportRan).toBeUndefined();
    expect(report.converted).toBeGreaterThan(0);
    expect(report.rules).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
