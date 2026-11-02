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
    expect(one(report, /1 inline handler/).verdict).toBe('supported');
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
    expect(form.verdict).toBe('converted');
    expect(form.what).toContain('nothing is sent');
    expect(form.instead).toContain('fetch');
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
  });

  it('reads a project’s paths as the composer does', () => {
    const files = ['index.html', 'js/app.js', 'main.js', 'css/site.css', 'site.css', 'images/x.png', 'pages/about.html'];
    const report = reportHtmlImport(
      '<link rel="stylesheet" href="/css/site.css"><link rel="stylesheet" href="site.css?v=3"><script src="/js/app.js"></script><script src="main.js?v=3"></script><img src="/images/x.png" alt=""><img src="images/x.png?v=1" alt="">',
      { files }
    );
    expect(report.unsupported).toBe(0);
    const paged = reportHtmlImport('<script src="../main.js"></script><img src="../images/x.png" alt="">', { files, page: 'pages/about.html' });
    expect(paged.unsupported).toBe(0);
    const out = reportHtmlImport('<script src="../../secret.js"></script>', { files, page: 'pages/about.html' });
    expect(one(out, /climbs out of the project/).verdict).toBe('unsupported');
    expect(one(reportHtmlImport('<script src="nope.js"></script>', { files }), /no such file, so the app does not open/).verdict).toBe('unsupported');
  });

  it('asks the runtime what a script is', () => {
    expect(one(reportHtmlImport('<script type="javascript">run()</script>'), /inline <script>/).verdict).toBe('converted');
    expect(one(reportHtmlImport('<script src="main.py" type="text/python"></script>'), /becomes the page’s logic/).verdict).toBe('converted');
    expect(one(reportHtmlImport('<script src="data:text/javascript,run()"></script>'), /is not loaded/).verdict).toBe('unsupported');
    expect(find(reportHtmlImport('<script type="application/json">{"a":1}</script>'), /is not code/)).toHaveLength(1);
  });

  it('reads what browsers read: tags without spaces or quotes, and not what they pass over', () => {
    expect(one(reportHtmlImport('<script src=https://x.example/a.js?v=1></script>'), /code from another site/).verdict).toBe('unsupported');
    expect(find(reportHtmlImport('<img src="a.png"alt="b">', { files: ['index.html'] }), /no such file/)).toHaveLength(1);
    expect(find(reportHtmlImport('<textarea><iframe src="x"></iframe></textarea><title><iframe></title>'), /is not drawn/)).toHaveLength(0);
    expect(find(reportHtmlImport('<!-- <iframe src="x"></iframe> '), /is not drawn/)).toHaveLength(0);
    expect(find(reportHtmlImport('<![CDATA[ <iframe src="x"></iframe> ]]>'), /is not drawn/)).toHaveLength(0);
    // İ is two code units in lower case: a later tag is still found where it is.
    expect(find(reportHtmlImport('<script>let a = "İİİİ";</script><iframe src="x"></iframe>'), /is not drawn/)).toHaveLength(1);
    expect(find(reportHtmlImport('<SCRIPT SRC="https://x.example/a.js"></SCRIPT>'), /code from another site/)).toHaveLength(1);
  });

  it('names what is taken out on the way: other sites’ files, @import, javascript: links, and code in handlers', () => {
    expect(one(reportHtmlImport('<img src="https://x.example/a.jpg" alt="">'), /a file on another site/).verdict).toBe('converted');
    expect(one(reportHtmlImport('<style>@import url(https://f.example/a.css); p { color: red }</style>'), /@import/).verdict).toBe('unsupported');
    expect(one(reportHtmlImport('<a href="javascript:go()">x</a>'), /javascript: link/).verdict).toBe('unsupported');
    expect(one(reportHtmlImport('<button onclick="return confirm(\'Sure?\')">x</button>'), /confirm\(\) and prompt\(\)/).verdict).toBe('unsupported');
    expect(one(reportHtmlImport('<form action="contact.php"></form>'), /sending leaves the app/).verdict).toBe('unsupported');
    expect(one(reportHtmlImport('<form action="contact.php" onsubmit="event.preventDefault(); go()"></form>'), /cancels the submit/).verdict).toBe('supported');
    expect(one(reportHtmlImport('<script>const x = await import("./later.js");</script>'), /import\(\)/).verdict).toBe('unsupported');
  });

  it('takes no longer for a hostile page than for a long one', () => {
    const size = 200_000;
    const pages = [
      '<!--'.repeat(size / 4),
      '<a '.repeat(size / 3),
      `<script>import a${' '.repeat(size)}</script>`,
      `<script>${'import { '.repeat(size / 9)}</script>`,
      `<script>${'require("'.repeat(size / 9)}</script>`,
      '<script></script>'.repeat(size / 17),
      `<a b="${'c'.repeat(size)}`,
    ];
    for (const hostile of pages) {
      const started = performance.now();
      reportHtmlImport(hostile.replace(/<a /g, '<a '), {});
      expect(performance.now() - started, hostile.slice(0, 20)).toBeLessThan(4000);
    }
  });
});
