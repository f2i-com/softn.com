/**
 * What the agent learns about the app by running it: check_app,
 * inspect_preview and run_app_function.
 *
 * Every one of them goes through what the preview goes through: Studio's
 * validator (the bundle inspector and the composer), composePreviewProject
 * (which composes exactly as the runtime does), core's parser, and — where
 * there is a document — the real SoftNRenderer, rendered off-screen into a
 * detached root and unmounted again. run_app_function builds a fresh script
 * runtime of its own, the engine the preview uses, so a test the agent runs
 * never touches the person's preview state.
 */

import { createElement } from 'react';
import type { Blueprint, VFSFile } from '../../types/studio';
import { validateProject } from '../validator';
import { buildPreviewXDBState, composePreviewProject, stripTemplateComments } from '../previewProject';
import { getBundleEntryPath } from '../studioProject';
import { normalizeProjectPath } from '../paths';
import { checkTemplateNames, type LogicNames, type TemplateFile } from './templateNames';
import type { CheckReport } from './types';
import { backendSqlProblems, migrationSqlProblems } from './sqlLint';

export interface RunFunctionRequest {
  name: string;
  args?: unknown[];
  /** Each a call ({ name, args }) or an assignment ({ set, value }); see setupAssignments for the other spellings taken. */
  setup_calls?: Array<{ name?: string; args?: unknown[]; set?: string | Record<string, unknown>; value?: unknown; [key: string]: unknown }>;
  page?: string;
}

/** The parts of checking that need a document or an engine, swappable in tests. */
export interface AgentEnvironment {
  checkApp(files: Map<string, VFSFile>, options: { page?: string; blueprint: Blueprint | null }): Promise<CheckReport>;
  inspectPreview(files: Map<string, VFSFile>, page?: string): Promise<{ ok: boolean; text: string }>;
  runFunction(files: Map<string, VFSFile>, request: RunFunctionRequest): Promise<{ ok: boolean; text: string }>;
}

/** The page a check renders: the one asked for, else the manifest's main, else the first .ui file. */
export function pageToCheck(files: Map<string, VFSFile>, page?: string): string | null {
  if (page) {
    const path = normalizeProjectPath(page.replace(/^\.\//, ''));
    return path && files.has(path) ? path : null;
  }
  const main = getBundleEntryPath(files);
  if (main && /\.ui$/i.test(main)) return main;
  return [...files.keys()].filter((p) => /\.ui$/i.test(p)).sort()[0] ?? null;
}

const HEADLESS_APP_ID = 'studio-agent-check';

/** What the headless render saw. */
interface RenderOutcome {
  errors: string[];
  warnings: string[];
  text: string;
  snapshot: string;
}

function formatConsoleArgs(args: unknown[]): string {
  const show = (a: unknown) => (a instanceof Error ? a.message : typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })());
  let rest = [...args];
  let head = '';
  // printf-style messages (React's warnings) with their arguments put in place.
  if (typeof rest[0] === 'string' && /%[sdoO]/.test(rest[0])) {
    const format = rest.shift() as string;
    head = format.replace(/%[sdoO]/g, () => (rest.length > 0 ? show(rest.shift()) : ''));
  }
  rest = rest.filter((a) => !(typeof a === 'string' && /^\s*at /.test(a)));
  return [head, ...rest.map(show)]
    .filter(Boolean)
    .join(' ')
    // A component stack says where in React, not where in the app.
    .replace(/\n\s+at [\s\S]*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

/** The text a person would see: no style sheets or scripts, whitespace collapsed. */
export function visibleText(root: Element): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      parts.push(node.textContent ?? '');
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = (node as Element).tagName.toLowerCase();
    if (tag === 'style' || tag === 'script' || tag === 'template') return;
    for (const child of Array.from(node.childNodes)) walk(child);
    parts.push(' ');
  };
  walk(root);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/** Wait until the rendered text stops changing, within a bound. */
async function settle(read: () => string, minMs: number, maxMs: number): Promise<void> {
  const start = Date.now();
  let last = read();
  let stableSince = Date.now();
  while (Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 50));
    const now = read();
    if (now !== last) {
      last = now;
      stableSince = Date.now();
    } else if (Date.now() - start >= minMs && Date.now() - stableSince >= 300) {
      return;
    }
  }
}

/**
 * Render `page` off-screen with the real renderer and report what went wrong
 * and what it shows. The document is Studio's own, so the node is placed far
 * off-screen and hidden from assistive technology, and removed afterwards.
 */
async function renderHeadless(files: Map<string, VFSFile>, page: string): Promise<RenderOutcome | { composeError: string }> {
  const composed = composePreviewProject(files, page);
  if (!composed.ok) return { composeError: composed.error };
  const { composition } = composed;
  const [{ createRoot }, components, core] = await Promise.all([import('react-dom/client'), import('@softn/components'), import('@softn/core')]);
  components.registerAllBuiltins?.();

  const errors: string[] = [];
  const warnings: string[] = [];
  const original = { error: console.error, warn: console.warn };
  console.error = (...args: unknown[]) => {
    errors.push(formatConsoleArgs(args));
  };
  console.warn = (...args: unknown[]) => {
    const line = formatConsoleArgs(args);
    if (/\[SoftN\]/.test(line)) warnings.push(line);
  };
  const onWindowError = (event: ErrorEvent) => errors.push(`Uncaught: ${event.message}`);
  const onRejection = (event: PromiseRejectionEvent) => errors.push(`Unhandled rejection: ${formatConsoleArgs([event.reason])}`);
  window.addEventListener('error', onWindowError);
  window.addEventListener('unhandledrejection', onRejection);

  // A render must not find the last check's records or storage.
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(`softn:${HEADLESS_APP_ID}:`)) localStorage.removeItem(key);
    }
  } catch {
    // Storage may be unavailable; the render does not need it.
  }

  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.setAttribute('data-softn-agent-check', 'true');
  host.style.cssText = 'position:fixed;left:-20000px;top:0;width:1024px;height:768px;overflow:hidden;pointer-events:none;';
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    root.render(
      createElement(core.SoftNRenderer, {
        source: stripTemplateComments(composition.source),
        importResolver: composition.importResolver,
        logicBasePath: composition.logicBasePath,
        preIncludedLogicPaths: composition.preIncludedLogicPaths,
        python: composition.python,
        initialData: buildPreviewXDBState(files).initialData,
        appId: HEADLESS_APP_ID,
        scriptExecutionMode: 'main',
        resumeSavedSyncRoom: false,
        onError: (error: Error) => errors.push(`Render error: ${error.message}`),
      }),
    );
    // Python's engine takes longer the first time it loads.
    await settle(() => visibleText(host), composition.python ? 1500 : 500, composition.python ? 12_000 : 5_000);
    return { errors: dedupe(errors), warnings: dedupe(warnings), text: visibleText(host), snapshot: describeDom(host) };
  } finally {
    root.unmount();
    host.remove();
    console.error = original.error;
    console.warn = original.warn;
    window.removeEventListener('error', onWindowError);
    window.removeEventListener('unhandledrejection', onRejection);
  }
}

function dedupe(lines: string[]): string[] {
  return [...new Set(lines.filter(Boolean))].slice(0, 12);
}

/**
 * A page as an accessibility-tree-like outline: headings, text, and the
 * controls a person can use, each with its label and state.
 */
export function describeDom(root: Element): string {
  const lines: string[] = [];
  let pendingText = '';
  const flush = () => {
    const text = pendingText.replace(/\s+/g, ' ').trim();
    if (text) lines.push(`text: ${text.slice(0, 200)}`);
    pendingText = '';
  };
  const labelOf = (el: Element) =>
    (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      pendingText += ` ${node.textContent ?? ''}`;
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (tag === 'style' || tag === 'script' || tag === 'template') return;
    if (el.hidden || el.style?.display === 'none') return;
    const role = el.getAttribute('role');
    const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' ? ' (disabled)' : '';
    if (/^h[1-6]$/.test(tag)) {
      flush();
      lines.push(`heading ${tag[1]}: ${labelOf(el)}`);
      return;
    }
    if (tag === 'button' || role === 'button' || role === 'tab' || role === 'menuitem' || role === 'switch') {
      flush();
      const state = el.getAttribute('aria-selected') === 'true' ? ' (selected)' : el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true' ? ' (on)' : '';
      lines.push(`${role && role !== 'button' ? role : 'button'} "${labelOf(el)}"${state}${disabled}`);
      return;
    }
    if (tag === 'input') {
      flush();
      const input = el as HTMLInputElement;
      const type = (input.type || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') lines.push(`${type} "${labelOf(el) || input.name}" ${input.checked ? 'checked' : 'unchecked'}${disabled}`);
      else lines.push(`textbox (${type}) "${labelOf(el)}" value="${String(input.value).slice(0, 60)}"${disabled}`);
      return;
    }
    if (tag === 'textarea') {
      flush();
      lines.push(`textbox (multiline) "${labelOf(el)}" value="${String((el as HTMLTextAreaElement).value).slice(0, 60)}"${disabled}`);
      return;
    }
    if (tag === 'select') {
      flush();
      const select = el as HTMLSelectElement;
      lines.push(`combobox "${el.getAttribute('aria-label') ?? ''}" selected="${select.options[select.selectedIndex]?.text ?? ''}" options=${select.options.length}${disabled}`);
      return;
    }
    if (tag === 'a' && el.hasAttribute('href')) {
      flush();
      lines.push(`link "${labelOf(el)}"`);
      return;
    }
    if (tag === 'img') {
      flush();
      lines.push(`image "${el.getAttribute('alt') ?? ''}"`);
      return;
    }
    if (tag === 'canvas') {
      flush();
      lines.push('canvas');
      return;
    }
    const block = /^(div|p|li|section|header|footer|main|nav|article|aside|td|th|tr|label|form|ul|ol|table)$/.test(tag);
    if (block) flush();
    for (const child of Array.from(el.childNodes)) walk(child);
    if (block) flush();
  };
  walk(root);
  flush();
  // Collapse runs of identical lines (a long list renders the same row shape).
  const out: string[] = [];
  for (const line of lines) {
    if (out.length > 0 && out[out.length - 1] === line) continue;
    out.push(line);
  }
  return out.slice(0, 150).join('\n') + (out.length > 150 ? `\n… ${out.length - 150} more line(s)` : '');
}

async function parseDiagnostics(source: string): Promise<{ errors: string[]; warnings: string[] }> {
  const core = await import('@softn/core');
  const errors: string[] = [];
  const warnings: string[] = [];
  try {
    const doc = core.parse(source);
    for (const d of doc.diagnostics ?? []) {
      const line = `Parse ${d.severity} at line ${d.loc.line}:${d.loc.column}: ${d.message}`;
      (d.severity === 'error' ? errors : warnings).push(line);
    }
  } catch (err) {
    errors.push(`Parse error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { errors, warnings };
}

/**
 * Template mistakes that parse and render without a word, found in the
 * source: a block-bodied arrow in an event handler is read as an object
 * literal, so the handler never runs; `:value` on a text field is one-way,
 * so typing never reaches the state.
 */
export function lintTemplates(files: Map<string, VFSFile>): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const [path, file] of files) {
    if (!/\.ui$/i.test(path) || typeof file.content !== 'string') continue;
    // Blank out other languages, keeping line numbers.
    const template = file.content.replace(/<(logic|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (block) => block.replace(/[^\n]/g, ' '));
    const lineOf = (index: number) => template.slice(0, index).split('\n').length;
    for (const match of template.matchAll(/@([\w-]+)=\{\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g)) {
      errors.push(`${path} line ${lineOf(match.index)}: @${match[1]} has a block-bodied arrow (\`=> { … }\`), which templates read as an object literal — the handler never runs. Use a single expression, e.g. @${match[1]}={() => doIt()}, and put statements in a logic function.`);
    }
    for (const match of template.matchAll(/<(Input|TextArea)\b[^>]*\s:value=\{/g)) {
      warnings.push(`${path} line ${lineOf(match.index)}: <${match[1]} :value={…}> is one-way, so typing never changes the state. Use :bind={name}.`);
    }
  }
  return { errors, warnings };
}

/**
 * A `.ui` file as the parser should read it for line numbers that match the
 * file: `//` template comment lines blanked, not removed, and nothing
 * collapsed or trimmed (stripTemplateComments does both, for the preview).
 */
function blankTemplateComments(source: string): string {
  const spans: Array<[number, number]> = [];
  for (const match of source.matchAll(/<(logic|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi)) spans.push([match.index, match.index + match[0].length]);
  let out = '';
  let cursor = 0;
  for (const [start, end] of [...spans, [source.length, source.length] as [number, number]]) {
    out += source.slice(cursor, start).replace(/^\/\/.*$/gm, '');
    out += source.slice(start, end);
    cursor = end;
  }
  return out;
}

/** What the composer does with `<import Name from="./x.ui" />`: the same pattern, so the files checked are the files pasted in. */
const UI_IMPORT = /<import\s+(\w+)\s+from=["']([^"']+)["']\s*\/>/g;

type CoreModule = typeof import('@softn/core');

/** A fresh script runtime for a composed page — the engine the preview uses — with its logic loaded. */
async function loadPageLogic(
  core: CoreModule,
  composition: Extract<ReturnType<typeof composePreviewProject>, { ok: true }>['composition'],
  block: { type: string; code: string } | undefined,
  context: Parameters<CoreModule['createScriptRuntime']>[0],
): Promise<{ runtime: ReturnType<CoreModule['createScriptRuntime']>; loaded: Awaited<ReturnType<ReturnType<CoreModule['createScriptRuntime']>['loadScript']>> }> {
  const runtime = core.createScriptRuntime(
    context,
    undefined,
    `studio-agent-run-${Date.now().toString(36)}`,
    composition.importResolver,
    composition.logicBasePath,
    { mode: 'main', preIncludedLogicPaths: composition.preIncludedLogicPaths, pythonProject: composition.python },
  );
  try {
    const loaded = await withTimeout(runtime.loadScript((block ?? { type: 'logic', code: '' }) as never), composition.python ? 30_000 : 10_000, 'Loading the logic');
    return { runtime, loaded };
  } catch (err) {
    runtime.cleanup();
    throw err;
  }
}

function quietContext(core: CoreModule, files: Map<string, VFSFile>, logs: string[]) {
  const state: Record<string, unknown> = {};
  return {
    state,
    setState: (path: string, value: unknown) => {
      const parts = path.split('.');
      let target: Record<string, unknown> = state;
      for (const part of parts.slice(0, -1)) {
        const next = target[part];
        if (!next || typeof next !== 'object') target[part] = {};
        target = target[part] as Record<string, unknown>;
      }
      target[parts[parts.length - 1]] = value;
    },
    batchSetState: (changes: Record<string, unknown>) => Object.assign(state, changes),
    data: buildPreviewXDBState(files).initialData as Record<string, never[]>,
    xdb: core.createMockXDBModule(),
    nav: core.createMockNavModule(),
    console: {
      log: (...args: unknown[]) => logs.push(`log: ${formatConsoleArgs(args)}`),
      error: (...args: unknown[]) => logs.push(`error: ${formatConsoleArgs(args)}`),
      warn: (...args: unknown[]) => logs.push(`warn: ${formatConsoleArgs(args)}`),
    },
  };
}

const NONE = { errors: [] as string[], warnings: [] as string[] };

/** A host's rules for a private backend's routes (apps/softn-host-php/runtime/request-worker.mjs). */
const ROUTE_PATH = /^\/api\/[a-zA-Z0-9/_-]+$/;
const ROUTE_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);
const HANDLER_NAME = /^[$A-Z_a-z][$\w]*$/;

interface ServerRoute { path?: unknown; method?: unknown; handler?: unknown }

/**
 * A private backend (manifest.json's `server`), checked the way its host starts it: the routes
 * are ones the host serves, the migrations it lists exist, and the entry loads and defines a
 * function for every route. A host refuses a whole version whose backend does not start, so an
 * app that looked finished in the preview could not be published; this finds it first.
 */
async function backendProblems(files: Map<string, VFSFile>): Promise<{ errors: string[]; warnings: string[] }> {
  const manifestFile = files.get('manifest.json');
  if (!manifestFile || typeof manifestFile.content !== 'string') return NONE;
  let server: { entry?: unknown; routes?: unknown; database?: { migrations?: unknown } } | undefined;
  try {
    server = (JSON.parse(manifestFile.content) as { server?: typeof server }).server;
  } catch {
    return NONE; // The validator reports manifest.json that does not parse.
  }
  if (!server || typeof server !== 'object') return NONE;
  const errors: string[] = [];
  const warnings: string[] = [];
  const entry = typeof server.entry === 'string' ? server.entry : '';
  const source = entry ? files.get(entry)?.content : undefined;
  if (typeof source !== 'string') {
    errors.push(`manifest.json: server.entry names ${entry || 'no file'}, which is not a text file in the project.`);
    return { errors, warnings };
  }
  const handlers: Array<{ handler: string; label: string }> = [];
  const declared = new Set<string>();
  for (const route of (Array.isArray(server.routes) ? server.routes : []) as ServerRoute[]) {
    const label = `${typeof route?.method === 'string' ? route.method : '?'} ${typeof route?.path === 'string' ? route.path : '?'}`;
    if (typeof route?.path !== 'string' || !ROUTE_PATH.test(route.path)) errors.push(`manifest.json: route ${label} needs a path under /api/ made of letters, digits, /, _ and - (matched exactly: pass an id in the query or the body).`);
    if (typeof route?.method !== 'string' || !ROUTE_METHODS.has(route.method)) errors.push(`manifest.json: route ${label} needs a method of GET, POST, PUT or DELETE.`);
    if (declared.has(label)) errors.push(`manifest.json: route ${label} is declared twice.`);
    declared.add(label);
    if (typeof route?.handler !== 'string' || !HANDLER_NAME.test(route.handler)) errors.push(`manifest.json: route ${label} needs a handler: the name of a function in ${entry}.`);
    else handlers.push({ handler: route.handler, label });
  }
  const migrations = Array.isArray(server.database?.migrations) ? (server.database!.migrations as unknown[]) : [];
  for (const path of migrations) {
    const sql = typeof path === 'string' ? files.get(path)?.content : undefined;
    if (typeof sql !== 'string') errors.push(`manifest.json: server.database.migrations lists ${String(path)}, which is not a text file in the project.`);
    else errors.push(...migrationSqlProblems(path as string, sql));
  }
  errors.push(...backendSqlProblems(entry, source));
  for (const path of files.keys()) {
    if (/^server\/migrations\/[^/]+\.sql$/.test(path) && !migrations.includes(path)) warnings.push(`${path} is not listed in manifest.json's server.database.migrations, so the host never runs it.`);
  }
  // Loaded as its host loads it: a backend's top level only defines functions (a host refuses SQL outside a request).
  const core = await import('@softn/core');
  const logs: string[] = [];
  const runtime = core.createScriptRuntime(quietContext(core, files, logs) as never, undefined, `studio-agent-backend-${Date.now().toString(36)}`, undefined, undefined, { mode: 'main' } as never);
  try {
    const loaded = await withTimeout(runtime.loadScript({ type: 'logic', code: source } as never), 10_000, 'Loading the backend');
    const defined = new Set(Object.keys(loaded.functions ?? {}));
    for (const { handler, label } of handlers) {
      if (!defined.has(handler)) errors.push(`${entry}: route ${label} names ${handler}, which ${entry} does not define as a top-level function.`);
    }
  } catch (err) {
    errors.push(`${entry} does not load, so its host would refuse the whole version: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    runtime.cleanup();
  }
  return { errors, warnings };
}

/**
 * The markup of `page` and every .ui file it imports, checked for names
 * nothing defines (templateNames.ts), against the names the page's logic
 * exposes once the runtime has loaded it. Answers nothing when the logic does
 * not load: the render reports that, and without the logic's names every name
 * would look undefined.
 */
export async function templateNameErrors(files: Map<string, VFSFile>, page: string): Promise<{ errors: string[]; warnings: string[] }> {
  const composed = composePreviewProject(files, page);
  if (!composed.ok) return NONE;
  const { composition } = composed;
  const core = await import('@softn/core');

  // The page and what it imports, parsed as their own files so lines match.
  const templates: TemplateFile[] = [];
  const queue = [page];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const file = files.get(path);
    if (!file || typeof file.content !== 'string') continue;
    const importedTags = new Set<string>();
    for (const match of file.content.matchAll(UI_IMPORT)) {
      importedTags.add(match[1]);
      try {
        queue.push(core.resolveBundlePath(path, match[2]));
      } catch {
        // An unsafe path is the composer's to report.
      }
    }
    let doc;
    try {
      doc = core.parse(blankTemplateComments(file.content));
    } catch {
      continue;
    }
    // A file that does not parse is reported as such; its partial tree would only add noise.
    if ((doc.diagnostics ?? []).some((d) => d.severity === 'error')) continue;
    templates.push({ path, doc, importedTags });
  }
  if (templates.length === 0) return NONE;

  let block: { type: string; code: string } | undefined;
  try {
    const doc = core.parse(stripTemplateComments(composition.source));
    block = doc.logic ?? doc.script;
  } catch {
    return NONE;
  }
  const logic: LogicNames = { state: new Set(), functions: new Set(), computed: new Set() };
  if (block || composition.python) {
    const logs: string[] = [];
    const original = console.error;
    // A load error is the render's to report; here it only means there are no names to check against.
    console.error = (...args: unknown[]) => logs.push(`error: ${formatConsoleArgs(args)}`);
    try {
      const { runtime, loaded } = await loadPageLogic(core, composition, block, quietContext(core, files, logs) as never);
      runtime.cleanup();
      const visible = (name: string) => !name.startsWith('__');
      for (const name of Object.keys(loaded.state)) if (visible(name)) logic.state.add(name);
      for (const name of Object.keys(loaded.functions)) if (visible(name)) logic.functions.add(name);
      for (const name of Object.keys(loaded.computed)) if (visible(name)) logic.computed.add(name);
    } catch {
      return NONE;
    } finally {
      console.error = original;
    }
  }
  return checkTemplateNames({
    files: templates,
    logic,
    dataNames: Object.keys(buildPreviewXDBState(files).initialData),
    helpers: Object.keys(core.builtinHelpers),
    python: !!composition.python,
  });
}

/**
 * Parse errors in the page and the pages it imports, each against its own
 * file and lines. The composed page inlines its imports, so an error in an
 * imported page used to be reported against the main page at a line of the
 * composed source — a line the model could not find in either file (a real
 * run spent a step "fixing" the wrong file). Empty when no file fails on its
 * own, and the composed report is kept.
 */
async function ownParseErrors(files: Map<string, VFSFile>, page: string): Promise<string[]> {
  const core = await import('@softn/core');
  const errors: string[] = [];
  const queue = [page];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const file = files.get(path);
    if (!file || typeof file.content !== 'string') continue;
    for (const match of file.content.matchAll(UI_IMPORT)) {
      try {
        queue.push(core.resolveBundlePath(path, match[2]));
      } catch {
        // An unsafe path is the composer's to report.
      }
    }
    const own = await parseDiagnostics(blankTemplateComments(file.content));
    errors.push(...own.errors.map((e) => `${path}: ${e}`));
  }
  return errors;
}

/** The real environment: validator and composer everywhere, the render wherever there is a document. */
export const browserEnvironment: AgentEnvironment = {
  async checkApp(files, { page, blueprint }) {
    const errors: string[] = [];
    const warnings: string[] = [];
    for (const problem of validateProject(files, blueprint)) {
      if (problem.level === 'info') continue;
      const line = `${problem.file}: ${problem.message}`;
      (problem.level === 'error' ? errors : warnings).push(line);
    }
    const lint = lintTemplates(files);
    errors.push(...lint.errors);
    warnings.push(...lint.warnings);
    const backend = await backendProblems(files);
    errors.push(...backend.errors);
    warnings.push(...backend.warnings);
    const target = pageToCheck(files, page);
    if (!target) {
      if (page) errors.push(`${page} is not a file in the project.`);
      else errors.push('There is no .ui page to render: manifest.json\'s main should name one, e.g. "main": "ui/main.ui".');
      return { ok: false, errors: dedupe(errors), warnings: dedupe(warnings), renderedHeadless: false };
    }
    const composed = composePreviewProject(files, target);
    if (!composed.ok) {
      const line = `${target}: the composer refused the app: ${composed.error}`;
      if (!errors.some((e) => e.includes(composed.error))) errors.push(line);
      return { ok: false, errors: dedupe(errors), warnings: dedupe(warnings), page: target, renderedHeadless: false };
    }
    const diagnostics = await parseDiagnostics(stripTemplateComments(composed.composition.source));
    const own = diagnostics.errors.length > 0 ? await ownParseErrors(files, target) : [];
    errors.push(...(own.length > 0 ? own : diagnostics.errors.map((e) => `${target}: ${e}`)));
    warnings.push(...diagnostics.warnings.map((w) => `${target}: ${w}`));
    if (diagnostics.errors.length === 0) {
      const names = await templateNameErrors(files, target);
      errors.push(...names.errors);
      warnings.push(...names.warnings);
    }

    let rendered: string | undefined;
    let renderedHeadless = false;
    if (typeof document !== 'undefined' && typeof window !== 'undefined') {
      const outcome = await renderHeadless(files, target);
      if ('composeError' in outcome) {
        errors.push(`${target}: ${outcome.composeError}`);
      } else {
        renderedHeadless = true;
        // The renderer reports the same parse errors at composed lines; with each file's own report above they only mislead.
        const renderErrors = own.length > 0 ? outcome.errors.filter((e) => !/Parse error at line/.test(e)) : outcome.errors;
        errors.push(...renderErrors.map((e) => `${target} (render): ${e}`));
        warnings.push(...outcome.warnings.map((w) => `${target} (render): ${w}`));
        rendered = outcome.text.slice(0, 600);
        if (!outcome.text) warnings.push(`${target} (render): the page rendered no visible text.`);
      }
    }
    const errs = dedupe(errors);
    return { ok: errs.length === 0, errors: errs, warnings: dedupe(warnings), page: target, rendered, renderedHeadless };
  },

  async inspectPreview(files, page) {
    const target = pageToCheck(files, page);
    if (!target) return { ok: false, text: page ? `${page} is not a file in the project.` : 'There is no .ui page to render.' };
    if (typeof document === 'undefined') return { ok: false, text: 'inspect_preview needs a browser document, and there is none here. Use check_app.' };
    const outcome = await renderHeadless(files, target);
    if ('composeError' in outcome) return { ok: false, text: `${target} cannot be composed: ${outcome.composeError}` };
    const errors = outcome.errors.length > 0 ? `\n\nErrors while rendering:\n${outcome.errors.map((e) => `- ${e}`).join('\n')}` : '';
    return { ok: true, text: `${target} renders:\n${outcome.snapshot || '(nothing visible)'}${errors}` };
  },

  async runFunction(files, request) {
    return runAppFunction(files, request);
  },
};

function preview(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = 'undefined';
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * One state variable's change, short enough to read: a list says how many
 * items it gained and lost and shows them, rather than both lists whole.
 */
function describeChange(key: string, before: unknown, after: unknown): string {
  if (Array.isArray(before) && Array.isArray(after)) {
    const was = new Set(before.map((item) => JSON.stringify(item)));
    const now = new Set(after.map((item) => JSON.stringify(item)));
    const added = after.filter((item) => !was.has(JSON.stringify(item)));
    const removed = before.filter((item) => !now.has(JSON.stringify(item)));
    const parts = [`${before.length} → ${after.length} items`];
    if (added.length > 0) parts.push(`added ${added.slice(0, 3).map(preview).join(', ')}${added.length > 3 ? ` and ${added.length - 3} more` : ''}`);
    if (removed.length > 0) parts.push(`removed ${removed.slice(0, 3).map(preview).join(', ')}${removed.length > 3 ? ` and ${removed.length - 3} more` : ''}`);
    return `${key}: ${parts.join('; ')}`;
  }
  return `${key}: ${preview(before)} → ${preview(after)}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not finish within ${Math.round(ms / 1000)} s`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function snapshotState(state: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (typeof value === 'function') continue;
    try {
      out[key] = JSON.parse(JSON.stringify(value ?? null)) as unknown;
    } catch {
      out[key] = String(value);
    }
  }
  return out;
}

type SetupCall = NonNullable<RunFunctionRequest['setup_calls']>[number];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The state a setup call assigns, when it is an assignment, or null when it
 * is a call. The documented shape is { "set": "name", "value": … }. Models
 * also write the assignment as a call to a function named "set" — with
 * ["name", value], a { name: value } map, or the name beside the value — and
 * were told only that "set" is not a function, three times, until the run
 * stopped. An app that has its own function called set keeps it.
 */
export function setupAssignments(step: SetupCall, functions: Record<string, unknown>): Array<[string, unknown]> | null {
  if (typeof step.set === 'string') return [[step.set, step.value]];
  if (isPlainObject(step.set)) return Object.entries(step.set);
  const name = step.name;
  if ((name !== 'set' && name !== 'setState') || typeof functions[name] === 'function') return null;
  const args = Array.isArray(step.args) ? step.args : [];
  if (typeof args[0] === 'string' && args.length >= 2) return [[args[0], args[1]]];
  if (isPlainObject(args[0])) return Object.entries(args[0]);
  const key = [step.state, step.key, step.variable, step.stateName].find((k): k is string => typeof k === 'string');
  if (key !== undefined && 'value' in step) return [[key, step.value]];
  return null;
}

/**
 * Load a page's logic in a fresh runtime, run its setup calls, call one
 * function, and report what came back and what changed.
 */
export async function runAppFunction(files: Map<string, VFSFile>, request: RunFunctionRequest): Promise<{ ok: boolean; text: string }> {
  const target = pageToCheck(files, request.page);
  if (!target) return { ok: false, text: request.page ? `${request.page} is not a file in the project.` : 'There is no .ui page whose logic to load.' };
  const composed = composePreviewProject(files, target);
  if (!composed.ok) return { ok: false, text: `${target} cannot be composed: ${composed.error}` };
  const { composition } = composed;
  const core = await import('@softn/core');
  let doc;
  try {
    doc = core.parse(stripTemplateComments(composition.source));
  } catch (err) {
    return { ok: false, text: `${target} does not parse: ${err instanceof Error ? err.message : String(err)}` };
  }
  const block = doc.logic ?? doc.script;
  if (!block && !composition.python) return { ok: false, text: `${target} has no logic to run.` };

  const logs: string[] = [];
  const context = quietContext(core, files, logs);
  const state = context.state;
  const original = console.error;
  console.error = (...args: unknown[]) => logs.push(`error: ${formatConsoleArgs(args)}`);
  let runtime: ReturnType<CoreModule['createScriptRuntime']> | null = null;
  try {
    const started = await loadPageLogic(core, composition, block, context as never);
    runtime = started.runtime;
    const { loaded } = started;
    Object.assign(state, loaded.state);
    if (loaded.functions._init) await withTimeout(loaded.functions._init(), 10_000, '_init()');
    const lines: string[] = [];
    for (const step of request.setup_calls ?? []) {
      const sets = setupAssignments(step, loaded.functions);
      if (sets) {
        for (const [key, value] of sets) {
          runtime.updateContext({ [key]: value } as never);
          state[key] = value;
          lines.push(`set ${key} = ${preview(value)}`);
        }
        continue;
      }
      const fn = step.name ? loaded.functions[step.name] : undefined;
      if (!fn) {
        return {
          ok: false,
          text: `Setup call ${step.name ?? '(unnamed)'} is not a function of the app. Functions: ${Object.keys(loaded.functions).filter((n) => !n.startsWith('__')).sort().join(', ') || '(none)'}. To set a state variable first, pass { "set": "stateName", "value": ... } as the setup call.`,
        };
      }
      const value = await withTimeout(fn(...(step.args ?? [])), 10_000, `${step.name}()`);
      lines.push(`${step.name}(${(step.args ?? []).map(preview).join(', ')}) → ${preview(value)}`);
    }
    const fn = loaded.functions[request.name];
    if (!fn) {
      return { ok: false, text: `${request.name} is not a function of the app. Functions: ${Object.keys(loaded.functions).filter((n) => !n.startsWith('__')).sort().join(', ') || '(none)'}` };
    }
    const before = snapshotState(state);
    const value = await withTimeout(fn(...(request.args ?? [])), 10_000, `${request.name}()`);
    const after = snapshotState(state);
    const changed: string[] = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const a = JSON.stringify(before[key]);
      const b = JSON.stringify(after[key]);
      if (a !== b) changed.push(`  ${describeChange(key, before[key], after[key])}`);
    }
    const errors = logs.filter((l) => l.startsWith('error:'));
    const text = [
      ...(lines.length > 0 ? ['Setup:', ...lines.map((l) => `  ${l}`)] : []),
      `${request.name}(${(request.args ?? []).map(preview).join(', ')}) returned ${preview(value)}`,
      changed.length > 0 ? `State changed:\n${changed.join('\n')}` : 'State did not change.',
      ...(logs.length > 0 ? [`Console:\n${logs.slice(0, 10).map((l) => `  ${l}`).join('\n')}`] : []),
    ].join('\n');
    return { ok: errors.length === 0, text };
  } catch (err) {
    return { ok: false, text: `Error: ${err instanceof Error ? err.message : String(err)}${logs.length > 0 ? `\nConsole:\n${logs.slice(0, 10).map((l) => `  ${l}`).join('\n')}` : ''}` };
  } finally {
    console.error = original;
    runtime?.cleanup();
  }
}

/** A check report as the text the model reads. */
export function formatCheckReport(report: CheckReport): string {
  const head = report.ok
    ? `Check passed${report.page ? ` for ${report.page}` : ''}${report.renderedHeadless ? ' (composed and rendered)' : ' (composed; no render available here)'}.`
    : `Check found ${report.errors.length} error(s)${report.page ? ` in ${report.page}` : ''}:`;
  const parts = [head];
  if (!report.ok) parts.push(report.errors.map((e) => `- ${e}`).join('\n'));
  if (report.warnings.length > 0) parts.push(`Warnings:\n${report.warnings.map((w) => `- ${w}`).join('\n')}`);
  if (report.rendered !== undefined) parts.push(`Rendered text: ${report.rendered || '(empty)'}`);
  return parts.join('\n');
}
