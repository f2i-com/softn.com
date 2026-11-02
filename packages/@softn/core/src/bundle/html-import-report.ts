/**
 * What becomes of an ordinary HTML page brought into SoftN: what carries across as it is, what SoftN reads in its own
 * way, and what does not run — each with where it is and what to do instead. It reads the page and its inline code;
 * it runs nothing and changes nothing, and nothing interactive goes unmentioned: every script, handler and form is in
 * the report, so an import never drops behaviour without a word.
 *
 * The rules are SoftN's own, as the guides state them (html-and-softn, ui-language#as-html, permissions), and where the
 * runtime decides something it is the runtime's own function that is asked here (scriptLanguage, isRemoteReference,
 * pageFilePath, bundlePathOf), so the two cannot come to disagree. This only tells a person beforehand.
 *
 * Every step is linear in the page: a scan by hand rather than regular expressions over it, as a page can be anything
 * (the composer's own tag reader records what a backtracking one did to a host).
 */
import { parse } from '../parser';
import { isRemoteReference, scriptLanguage } from '../parser/html';
import { bundlePathOf } from '../renderer/html-elements';
import { pageFilePath } from './source-composer';

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
}

export interface HtmlImportOptions {
  /** The project's files by path from its root, when known: a page's own file that is missing is then reported. */
  files?: readonly string[];
  /** This page's path from the project's root (`pages/about.html`): what its own paths are read from. */
  page?: string;
}

interface Tag {
  name: string;
  attrs: Map<string, string>;
  line: number;
  /** For a <script> or <style>: what it holds. */
  body?: string;
}

const EMBEDS = new Set(['iframe', 'embed', 'object', 'portal', 'frame', 'frameset']);
/** Elements whose content is text to a browser, so a tag inside one is not a tag. */
const TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);
const MEDIA = new Set(['img', 'video', 'audio', 'source']);
/** How far an import's list of names is looked for: a list is short, and a page need not be read again for each `{`. */
const IMPORT_REACH = 4000;

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

/** The line of an offset, from a table of where lines start. */
function lineFinder(source: string): (index: number) => number {
  const starts = [0];
  for (let i = source.indexOf('\n'); i >= 0; i = source.indexOf('\n', i + 1)) starts.push(i + 1);
  return (index) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (starts[middle] <= index) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

/** Where the end tag of a text element starts, in any case, or -1. */
function closingTag(source: string, name: string, from: number): number {
  for (let at = source.indexOf('</', from); at >= 0; at = source.indexOf('</', at + 2)) {
    if (source.slice(at + 2, at + 2 + name.length).toLowerCase() !== name) continue;
    const next = source.charCodeAt(at + 2 + name.length);
    if (Number.isNaN(next) || isSpace(next) || next === 47 || next === 62) return at;
  }
  return -1;
}

/**
 * The start tags of a page, read as a browser's tokenizer reads them, and what a script or style holds. What a browser
 * passes over is passed over: comments, a comment left open to the end, CDATA, and what a textarea or title holds.
 */
function tags(source: string): Tag[] {
  const found: Tag[] = [];
  const lineOf = lineFinder(source);
  const end = source.length;
  let at = 0;
  while (at < end) {
    const open = source.indexOf('<', at);
    if (open < 0) break;
    if (source.startsWith('<!--', open) || source.startsWith('<![CDATA[', open)) {
      const closer = source.startsWith('<!--', open) ? '-->' : ']]>';
      const close = source.indexOf(closer, open + 4);
      if (close < 0) break;
      at = close + closer.length;
      continue;
    }
    if (!isLetter(source.charCodeAt(open + 1))) {
      at = open + 1;
      continue;
    }
    let p = open + 1;
    while (p < end && !isSpace(source.charCodeAt(p)) && source[p] !== '>' && source[p] !== '/') p++;
    const name = source.slice(open + 1, p).toLowerCase();
    const attrs = new Map<string, string>();
    let closed = false;
    while (p < end) {
      while (p < end && (isSpace(source.charCodeAt(p)) || source[p] === '/')) p++;
      if (source[p] === '>') {
        p++;
        closed = true;
        break;
      }
      const nameStart = p;
      if (source[p] === '=') p++;
      while (p < end && !isSpace(source.charCodeAt(p)) && source[p] !== '=' && source[p] !== '>' && source[p] !== '/') p++;
      const attribute = source.slice(nameStart, p).toLowerCase();
      while (p < end && isSpace(source.charCodeAt(p))) p++;
      let value = '';
      if (source[p] === '=') {
        p++;
        while (p < end && isSpace(source.charCodeAt(p))) p++;
        const quote = source[p];
        if (quote === '"' || quote === "'") {
          const close = source.indexOf(quote, p + 1);
          if (close < 0) {
            p = end;
            break;
          }
          value = source.slice(p + 1, close);
          p = close + 1;
        } else {
          const valueStart = p;
          while (p < end && !isSpace(source.charCodeAt(p)) && source[p] !== '>') p++;
          value = source.slice(valueStart, p);
        }
      }
      if (attribute !== '' && !attrs.has(attribute)) attrs.set(attribute, value);
    }
    if (!closed) break;
    const tag: Tag = { name, attrs, line: lineOf(open) };
    if (TEXT_ELEMENTS.has(name)) {
      const close = closingTag(source, name, p);
      if (name === 'script' || name === 'style') tag.body = source.slice(p, close < 0 ? end : close);
      p = close < 0 ? end : close + 2;
    }
    found.push(tag);
    at = p;
  }
  return found;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** An `import` at `at`, read by hand: what it names and where from, or null where it is not one this reads. */
function importAt(code: string, at: number): { defaultOrNamespace: boolean; names: string; from: string } | null {
  const skip = (p: number) => {
    while (p < code.length && isSpace(code.charCodeAt(p))) p++;
    return p;
  };
  const word = (p: number) => {
    const start = p;
    while (p < code.length && /[\w$]/.test(code[p])) p++;
    return code.slice(start, p);
  };
  let p = skip(at + 6);
  let defaultOrNamespace = false;
  let names = '';
  if (code[p] !== '"' && code[p] !== "'") {
    const first = word(p);
    if (first !== '' && first !== 'from') {
      defaultOrNamespace = true;
      p = skip(p + first.length);
      if (code[p] === ',') p = skip(p + 1);
    }
    if (code[p] === '*') {
      defaultOrNamespace = true;
      p = skip(p + 1);
      if (word(p) !== 'as') return null;
      p = skip(p + 2);
      p = skip(p + word(p).length);
    }
    if (code[p] === '{') {
      const close = code.slice(p, p + IMPORT_REACH).indexOf('}');
      if (close < 0) return null;
      names = code.slice(p + 1, p + close);
      p = skip(p + close + 1);
    }
    if (word(p) !== 'from') return null;
    p = skip(p + 4);
  }
  const quote = code[p];
  if (quote !== '"' && quote !== "'") return null;
  const close = code.slice(p + 1, p + 1 + IMPORT_REACH).indexOf(quote);
  return close < 0 ? null : { defaultOrNamespace, names, from: code.slice(p + 1, p + 1 + close) };
}

/** What a page's code uses that does not run as it does in a browser tab. */
function codeNotes(code: string, line: number, notes: ImportNote[]): void {
  const add = (verdict: ImportVerdict, feature: ImportFeature, what: string, instead?: string) => notes.push({ verdict, feature, what, line, ...(instead ? { instead } : {}) });
  const packageNote = (from: string) => add('unsupported', 'modules', `A package is imported ("${from}"): packages are not read.`, 'Copy the part you need into a file of the project, or use a SoftN component for it.');
  for (const match of code.matchAll(/\bimport\b/g)) {
    const found = importAt(code, match.index);
    if (found === null) continue;
    if (!/^\.{0,2}\//.test(found.from)) packageNote(found.from);
    else if (found.defaultOrNamespace || /\bas\b/.test(found.names)) {
      add('unsupported', 'modules', `"${found.from}" is imported as a default, a namespace or under another name, which is not read.`, `Import the names themselves: import { name } from "${found.from}".`);
    } else {
      add('converted', 'modules', `"${found.from}" is imported by name: that file's code is placed with the page's, and its names are seen by every file.`);
    }
  }
  for (const match of code.matchAll(/\brequire\s*\(\s*["']([^"'\n]{1,300})["']\s*\)/g)) packageNote(match[1]);
  if (/\bimport\s*\(/.test(code)) add('unsupported', 'modules', 'import() while the page runs is not given.', 'Name the file in a <script src="…"> of the page, or with import { name } from "./file.js".');
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
  const page = options.page ?? 'index.html';
  const files = options.files ? new Set(options.files.map((f) => f.replace(/^\.?\//, ''))) : null;
  /** The project's file a script or stylesheet names, as the composer finds it; null where it climbs out of the project. */
  const fileOf = (written: string): string | null => {
    try {
      return pageFilePath(page, written);
    } catch {
      return null;
    }
  };
  const missing = (file: string | null) => files !== null && file !== null && !files.has(file);

  // What the parser itself says, in its own words: an error is what will not be read, and a warning that names
  // another framework's syntax (React, Vue, Svelte, Angular, Handlebars) is what does nothing here.
  for (const d of parse(source).diagnostics ?? []) {
    const framework = /\b(?:React|JSX|Vue|Svelte|Angular|Handlebars)\b|\{\{/.test(d.message);
    if (d.severity !== 'error' && !framework) continue;
    add({ verdict: 'unsupported', feature: framework ? 'framework' : 'html', what: d.message, line: d.loc?.line, instead: 'Write it with SoftN’s syntax: {expression}, @event, :bind, #if and #each.' });
  }
  const php = source.search(/<\?php/i);
  if (php >= 0) {
    add({ verdict: 'unsupported', feature: 'server', what: 'PHP in the page does not run in an app.', line: lineFinder(source)(php), instead: 'Move server work to server routes (server .logic on the PHP or Rust host, or FormLogic) and call them with fetch.' });
  }

  const all = tags(source);
  const htmlTags = new Set(all.map((t) => t.name).filter((n) => !['script', 'style', 'link'].includes(n)));
  const handlerCode: string[] = [];
  let handlerLine = 0;
  for (const tag of all) {
    for (const [name, value] of tag.attrs) {
      if (/^on[a-z]+$/.test(name)) {
        handlerCode.push(value);
        handlerLine ||= tag.line;
      }
    }
    const src = tag.attrs.get('src') ?? '';
    const href = tag.attrs.get('href') ?? '';
    if (tag.name === 'script') {
      const language = scriptLanguage(tag.attrs.get('type'));
      const file = src && !isRemoteReference(src) ? fileOf(src) : null;
      if (language === 'other') {
        add({ verdict: 'converted', feature: 'script', what: `A <script type="${tag.attrs.get('type')}"> is not code and is passed over.`, line: tag.line });
      } else if (src && isRemoteReference(src)) {
        add({ verdict: 'unsupported', feature: 'script', what: `<script src="${src}">: code from another site is not loaded.`, line: tag.line, instead: 'Copy the code into a file of the project and name it with <script src="…">. A framework’s build (React, Vue) does not run as it is.' });
      } else if (src && file === null) {
        add({ verdict: 'unsupported', feature: 'script', what: `<script src="${src}"> climbs out of the project, so the app does not open.`, line: tag.line, instead: 'Name a file inside the project.' });
      } else if (src && missing(file)) {
        add({ verdict: 'unsupported', feature: 'script', what: `<script src="${src}">: the project has no such file, so the app does not open.`, line: tag.line, instead: 'Add the file to the project, at that path from this page.' });
      } else if (src) {
        add({ verdict: 'converted', feature: 'script', what: `<script src="${src}"> becomes the page’s logic: its top-level variables are the page’s state and its functions what the page calls, run in SoftN’s sandbox.`, line: tag.line });
      } else if ((tag.body ?? '').trim()) {
        if (language === 'python') continue;
        add({ verdict: 'converted', feature: 'script', what: 'An inline <script> becomes a logic block of the page, run in SoftN’s sandbox.', line: tag.line });
        codeNotes(tag.body ?? '', tag.line, notes);
      }
    } else if (tag.name === 'link' && /\bstylesheet\b/i.test(tag.attrs.get('rel') ?? '')) {
      const file = isRemoteReference(href) ? null : fileOf(href);
      if (isRemoteReference(href)) add({ verdict: 'unsupported', feature: 'css', what: `<link rel="stylesheet" href="${href}">: stylesheets from other sites are not loaded.`, line: tag.line, instead: 'Copy the stylesheet (and any font files it needs) into the project and link it by its path.' });
      else if (file === null) add({ verdict: 'unsupported', feature: 'css', what: `<link rel="stylesheet" href="${href}"> climbs out of the project, so the app does not open.`, line: tag.line, instead: 'Name a file inside the project.' });
      else if (missing(file)) add({ verdict: 'unsupported', feature: 'css', what: `<link rel="stylesheet" href="${href}">: the project has no such file.`, line: tag.line, instead: 'Add the stylesheet to the project.' });
      else add({ verdict: 'supported', feature: 'css', what: `<link rel="stylesheet" href="${href}"> places the project’s stylesheet as a <style> block would.`, line: tag.line });
    } else if (tag.name === 'style') {
      add({ verdict: 'supported', feature: 'css', what: 'A <style> block: its rules hold inside the app, not on the page around it.', line: tag.line });
      if (/@import\b/i.test(tag.body ?? '')) add({ verdict: 'unsupported', feature: 'css', what: 'An @import in a stylesheet is taken out: the rest of its rules hold.', line: tag.line, instead: 'Copy what it imports into the project, in the stylesheet or a <link> of its own.' });
    } else if (EMBEDS.has(tag.name)) {
      add({ verdict: 'unsupported', feature: 'embeds', what: `<${tag.name}>${src ? ` of ${src}` : ''} is not drawn: an app does not embed other pages or plugins.`, line: tag.line, instead: 'Link to the page instead, or build that part as a page of the app.' });
    } else if (tag.name === 'base' || (tag.name === 'meta' && tag.attrs.has('http-equiv'))) {
      add({ verdict: 'unsupported', feature: 'html', what: `<${tag.name}${tag.name === 'meta' ? ` http-equiv="${tag.attrs.get('http-equiv')}"` : ''}> is passed over.`, line: tag.line, instead: tag.name === 'base' ? 'Write paths from the project’s root.' : 'Leave it out: the app’s host sets its own headers.' });
    } else if (tag.name === 'form') {
      const action = (tag.attrs.get('action') ?? '').trim();
      const handler = tag.attrs.get('onsubmit') ?? '';
      if (/\bpreventDefault\b|\breturn\s+false\b/.test(handler)) {
        add({ verdict: 'supported', feature: 'forms', what: 'A <form> whose onsubmit cancels the submit keeps its page, and its handler runs.', line: tag.line });
      } else if (action && isRemoteReference(action)) {
        add({ verdict: 'converted', feature: 'forms', what: `<form action="${action}">: without net permission for that host the address is taken out, so the form keeps its page and nothing is sent. With it, sending leaves the app.`, line: tag.line, instead: 'To keep the person in the app and still send, leave out action and send it from an onsubmit handler with fetch, with net for the host in permission.json.' });
      } else if (action) {
        add({ verdict: 'unsupported', feature: 'forms', what: `<form action="${action}">: sending leaves the app for that address, where the app has nothing.`, line: tag.line, instead: 'Leave out action and handle the submit on the page (onsubmit), calling a server route with fetch if it needs one.' });
      } else {
        add({ verdict: 'supported', feature: 'forms', what: `A <form> with no action keeps its page when it is sent${handler ? ', its handler runs,' : ''} and it checks itself as a browser does (required, pattern, min, max…).`, line: tag.line });
      }
    } else if (tag.name === 'a' && /^javascript:/i.test(href.trim())) {
      add({ verdict: 'unsupported', feature: 'html', what: 'A javascript: link is taken out, so the link does nothing.', line: tag.line, instead: 'Use onclick on the element.' });
    } else if (MEDIA.has(tag.name) && src) {
      const file = bundlePathOf(src);
      if (/^(?:https?:)?\/\//i.test(src.trim())) {
        add({ verdict: 'converted', feature: 'html', what: `<${tag.name} src="${src}">: a file on another site is shown only as permission.json allows net for it. Otherwise its src is taken out.`, line: tag.line, instead: 'Copy the file into the project, or declare net for the host.' });
      } else if (missing(file)) {
        add({ verdict: 'unsupported', feature: 'html', what: `<${tag.name} src="${src}">: the project has no such file, so the address is left as written.`, line: tag.line, instead: 'Add the file to the project, at that path from its root.' });
      }
    }
  }
  if (handlerCode.length) {
    add({ verdict: 'supported', feature: 'events', what: `${plural(handlerCode.length, 'inline handler')} (onclick and the like) run when their event fires, with event and this; event.preventDefault() and a closing return false cancel the browser’s default.`, line: handlerLine });
    codeNotes(handlerCode.join('\n'), handlerLine, notes);
  }
  if (htmlTags.size) {
    add({ verdict: 'supported', feature: 'html', what: `${plural(htmlTags.size, 'kind')} of HTML element (${[...htmlTags].slice(0, 8).map((t) => `<${t}>`).join(', ')}${htmlTags.size > 8 ? ', …' : ''}) read as a browser reads them; <html>, <head> and <body> are read through, and <title> names the page.` });
  }

  const order: ImportVerdict[] = ['unsupported', 'converted', 'supported'];
  notes.sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict) || (a.line ?? 0) - (b.line ?? 0));
  const count = (verdict: ImportVerdict) => notes.filter((n) => n.verdict === verdict).length;
  return { notes, supported: count('supported'), converted: count('converted'), unsupported: count('unsupported') };
}
