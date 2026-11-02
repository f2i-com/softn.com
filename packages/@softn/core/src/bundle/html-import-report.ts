/**
 * What becomes of an ordinary HTML page brought into SoftN: what carries across as it is, what SoftN reads in its own
 * way, and what does not run — each with where it is and what to do instead. It reads the page and its inline code;
 * it runs nothing and changes nothing, and nothing interactive goes unmentioned: every script, handler and form is in
 * the report, so an import never drops behaviour without a word.
 *
 * The rules are SoftN's own, as the guides state them (ui-language#as-html and #browser-code, permissions), at
 * HTML_IMPORT_RULES. The runtime is what enforces them; this only tells a person beforehand.
 */
import { parse } from '../parser';

/** The SoftN version whose behaviour these notes describe. */
export const HTML_IMPORT_RULES = '0.0.31';

export type ImportVerdict = 'supported' | 'converted' | 'unsupported';

export type ImportFeature = 'html' | 'css' | 'script' | 'events' | 'modules' | 'network' | 'dom' | 'forms' | 'embeds' | 'framework' | 'server';

export interface ImportNote {
  verdict: ImportVerdict;
  feature: ImportFeature;
  /** What was found, in a sentence. */
  what: string;
  /** Line in the page, from 1, where there is one. */
  line?: number;
  /** For anything that does not run as it did: what to do instead. */
  instead?: string;
}

export interface HtmlImportReport {
  notes: ImportNote[];
  supported: number;
  converted: number;
  unsupported: number;
  rules: string;
}

export interface HtmlImportOptions {
  /** The project's files by path from its root, when known: a page's own file that is missing is then reported. */
  files?: readonly string[];
}

interface Tag {
  name: string;
  attrs: Map<string, string>;
  line: number;
  /** For a <script> or <style>: what it holds. */
  body?: string;
}

const OTHER_SITE = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;
const EMBEDS = new Set(['iframe', 'embed', 'object', 'portal', 'frame', 'frameset']);
const NOT_CODE = /^(?!(?:text|application)\/(?:javascript|ecmascript)$|module$|$)/i;

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

/** The start tags of a page (and what a script or style holds), comments left out. A report's reading, not the parser's. */
function tags(source: string): Tag[] {
  const found: Tag[] = [];
  const text = source.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '));
  const start = /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = start.exec(text))) {
    const name = match[1].toLowerCase();
    const attrs = new Map<string, string>();
    const attr = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let a: RegExpExecArray | null;
    while ((a = attr.exec(match[2]))) attrs.set(a[1].toLowerCase(), a[2] ?? a[3] ?? a[4] ?? '');
    const tag: Tag = { name, attrs, line: lineAt(text, match.index) };
    if (name === 'script' || name === 'style') {
      const end = text.toLowerCase().indexOf(`</${name}`, start.lastIndex);
      tag.body = text.slice(start.lastIndex, end < 0 ? text.length : end);
      if (end >= 0) start.lastIndex = end;
    }
    found.push(tag);
  }
  return found;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a page's code uses that does not run as it does in a browser tab. */
function codeNotes(code: string, line: number, notes: ImportNote[]): void {
  const add = (verdict: ImportVerdict, feature: ImportFeature, what: string, instead?: string) => notes.push({ verdict, feature, what, line, ...(instead ? { instead } : {}) });
  for (const m of code.matchAll(/\bimport\s+(?:([\w$]+)\s*,?\s*)?(\*\s+as\s+[\w$]+)?\s*(\{[^}]*\})?\s*from\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    const from = m[4] ?? m[5] ?? '';
    if (m[5] !== undefined || !/^\.{1,2}\//.test(from)) {
      add('unsupported', 'modules', `A package is imported ("${from}"): packages are not read.`, 'Copy the part you need into a file of the project, or use a SoftN component for it.');
    } else if (m[1] || m[2] || /\bas\b/.test(m[3] ?? '')) {
      add('unsupported', 'modules', `"${from}" is imported as a default, a namespace or under another name, which is not read.`, `Import the names themselves: import { name } from "${from}".`);
    } else {
      add('converted', 'modules', `"${from}" is imported by name: that file's code is placed with the page's, and its names are seen by every file.`);
    }
  }
  if (/\bfetch\s*\(/.test(code)) add('converted', 'network', 'fetch: an address of the app’s own is read from its files with no network; any other host only as permission.json allows net for it, and with no cookie of the page.');
  if (/\bnew\s+(XMLHttpRequest|WebSocket|EventSource)\b/.test(code)) add('unsupported', 'network', `${/WebSocket/.test(code) ? 'WebSocket' : /EventSource/.test(code) ? 'EventSource' : 'XMLHttpRequest'} is not given to an app’s code.`, 'Use fetch, with net permission for the host in permission.json.');
  if (/\b(?:window\.)?(confirm|prompt)\s*\(/.test(code)) add('unsupported', 'dom', 'confirm() and prompt() cannot wait for an answer in an app.', 'Ask with a <Confirm> or a field on the page.');
  if (/\bdocument\.write(?:ln)?\s*\(/.test(code)) add('unsupported', 'dom', 'document.write is not given.', 'Build the content with createElement, innerHTML or SoftN markup.');
  if (/\bdocument\b/.test(code)) add('converted', 'dom', 'The code works on the page through document: it is given the page’s own HTML to query and change, and what it writes is drawn through the same checks as markup (no <script>, <iframe>, onerror or javascript: through innerHTML).');
}

/**
 * The report for one HTML page. `source` is the page as written; nothing in it is run.
 */
export function reportHtmlImport(source: string, options: HtmlImportOptions = {}): HtmlImportReport {
  const notes: ImportNote[] = [];
  const add = (note: ImportNote) => notes.push(note);
  const files = options.files ? new Set(options.files.map((f) => f.replace(/^\.?\//, ''))) : null;
  const missing = (path: string) => files !== null && !OTHER_SITE.test(path) && !path.startsWith('data:') && !files.has(path.replace(/^\.?\//, '').split(/[?#]/)[0]);

  // What the parser itself says, in its own words: an error is what will not be read, and a warning that names
  // another framework's syntax (React, Vue, Svelte, Angular, Handlebars) is what does nothing here.
  for (const d of parse(source).diagnostics ?? []) {
    const framework = /\b(?:React|JSX|Vue|Svelte|Angular|Handlebars)\b|\{\{/.test(d.message);
    if (d.severity !== 'error' && !framework) continue;
    add({ verdict: 'unsupported', feature: framework ? 'framework' : 'html', what: d.message, line: d.loc?.line, instead: 'Write it with SoftN’s syntax: {expression}, @event, :bind, #if and #each.' });
  }
  if (/<\?php/i.test(source)) {
    add({ verdict: 'unsupported', feature: 'server', what: 'PHP in the page does not run in an app.', line: lineAt(source, source.search(/<\?php/i)), instead: 'Move server work to server routes (server .logic on the PHP or Rust host, or FormLogic) and call them with fetch.' });
  }

  const all = tags(source);
  const htmlTags = new Set(all.map((t) => t.name).filter((n) => n === n.toLowerCase() && !['script', 'style', 'link'].includes(n)));
  let handlers = 0;
  let handlerLine = 0;
  for (const tag of all) {
    for (const name of tag.attrs.keys()) if (/^on[a-z]+$/.test(name)) { handlers++; handlerLine ||= tag.line; }
    const src = tag.attrs.get('src') ?? '';
    const href = tag.attrs.get('href') ?? '';
    if (tag.name === 'script') {
      const type = tag.attrs.get('type') ?? '';
      if (NOT_CODE.test(type) && type !== '') {
        add({ verdict: 'converted', feature: 'script', what: `A <script type="${type}"> is not code and is passed over.`, line: tag.line });
      } else if (src && OTHER_SITE.test(src)) {
        add({ verdict: 'unsupported', feature: 'script', what: `<script src="${src}">: code from another site is not loaded.`, line: tag.line, instead: 'Copy the code into a file of the project and name it with <script src="…">. A framework’s build (React, Vue) does not run as it is.' });
      } else if (src && missing(src)) {
        add({ verdict: 'unsupported', feature: 'script', what: `<script src="${src}">: the project has no such file.`, line: tag.line, instead: 'Add the file to the project, at that path from its root.' });
      } else if (src) {
        add({ verdict: 'converted', feature: 'script', what: `<script src="${src}"> becomes the page’s logic: its top-level variables are the page’s state and its functions what the page calls, run in SoftN’s sandbox.`, line: tag.line });
      } else if ((tag.body ?? '').trim()) {
        add({ verdict: 'converted', feature: 'script', what: 'An inline <script> becomes a logic block of the page, run in SoftN’s sandbox.', line: tag.line });
        codeNotes(tag.body ?? '', tag.line, notes);
      }
    } else if (tag.name === 'link' && /\bstylesheet\b/i.test(tag.attrs.get('rel') ?? '')) {
      if (OTHER_SITE.test(href)) add({ verdict: 'unsupported', feature: 'css', what: `<link rel="stylesheet" href="${href}">: stylesheets from other sites are not loaded.`, line: tag.line, instead: 'Copy the stylesheet (and any font files it needs) into the project and link it with a path from the project’s root.' });
      else if (missing(href)) add({ verdict: 'unsupported', feature: 'css', what: `<link rel="stylesheet" href="${href}">: the project has no such file.`, line: tag.line, instead: 'Add the stylesheet to the project.' });
      else add({ verdict: 'supported', feature: 'css', what: `<link rel="stylesheet" href="${href}"> places the project’s stylesheet as a <style> block would.`, line: tag.line });
    } else if (tag.name === 'style') {
      add({ verdict: 'supported', feature: 'css', what: 'A <style> block: its rules hold inside the app, not on the page around it.', line: tag.line });
    } else if (EMBEDS.has(tag.name)) {
      add({ verdict: 'unsupported', feature: 'embeds', what: `<${tag.name}>${src ? ` of ${src}` : ''} is not drawn: an app does not embed other pages or plugins.`, line: tag.line, instead: 'Link to the page instead, or build that part as a page of the app.' });
    } else if (tag.name === 'base' || (tag.name === 'meta' && tag.attrs.has('http-equiv'))) {
      add({ verdict: 'unsupported', feature: 'html', what: `<${tag.name}${tag.name === 'meta' ? ` http-equiv="${tag.attrs.get('http-equiv')}"` : ''}> is passed over.`, line: tag.line, instead: tag.name === 'base' ? 'Write paths from the project’s root.' : 'Leave it out: the app’s host sets its own headers.' });
    } else if (tag.name === 'form') {
      const action = tag.attrs.get('action');
      if (action && OTHER_SITE.test(action)) add({ verdict: 'converted', feature: 'forms', what: `A <form action="${action}"> goes to that address when it is sent, and the app is left behind.`, line: tag.line, instead: 'To keep the person in the app, leave out action and handle the submit (onsubmit, or @submit.prevent) with fetch.' });
      else if (!action) add({ verdict: 'supported', feature: 'forms', what: 'A <form> with no action keeps its page when it is sent: its handler runs, and it checks itself as a browser does (required, pattern, min, max…).', line: tag.line });
    } else if (['img', 'video', 'audio', 'source'].includes(tag.name) && src && missing(src)) {
      add({ verdict: 'unsupported', feature: 'html', what: `<${tag.name} src="${src}">: the project has no such file, so the address is left as written.`, line: tag.line, instead: 'Add the file to the project, at that path from its root.' });
    }
  }
  if (handlers) add({ verdict: 'converted', feature: 'events', what: `${plural(handlers, 'inline handler')} (onclick and the like) run when their event fires, with event and this; event.preventDefault() and a closing return false cancel the browser’s default.`, line: handlerLine });
  if (htmlTags.size) {
    add({ verdict: 'supported', feature: 'html', what: `${plural(htmlTags.size, 'kind')} of HTML element (${[...htmlTags].slice(0, 8).map((t) => `<${t}>`).join(', ')}${htmlTags.size > 8 ? ', …' : ''}) read as a browser reads them; <html>, <head> and <body> are read through, and <title> names the page.` });
  }

  const order: ImportVerdict[] = ['unsupported', 'converted', 'supported'];
  notes.sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict) || (a.line ?? 0) - (b.line ?? 0));
  const count = (verdict: ImportVerdict) => notes.filter((n) => n.verdict === verdict).length;
  return { notes, supported: count('supported'), converted: count('converted'), unsupported: count('unsupported'), rules: HTML_IMPORT_RULES };
}
