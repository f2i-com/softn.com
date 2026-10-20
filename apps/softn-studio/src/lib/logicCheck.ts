/**
 * An app's logic, loaded the way the preview loads it: a fresh script runtime,
 * the engine the preview runs, given the page as the runtime composes it.
 *
 * The agent's check runs functions in it (agent/appCheck.ts). Studio's own
 * check asks it one thing, whether the logic compiles: a `function broken( {`
 * left in main.js used to leave the status bar at "No problems", Run enabled
 * and the preview saying "Running" over a panel that said otherwise.
 *
 * The engine is the judge of what compiles, and it says so without a file:
 * the logic it compiles is the app's files joined, so its message quotes a
 * line ("at this line of the logic: …") or says the end was reached with
 * something still open. Python's names the module and the line. Here each is
 * placed in its file, at its line.
 */

import {
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  parse,
} from '@softn/core';
import type { ValidationError, VFSFile } from '../types/studio';
import { buildPreviewXDBState, composePreviewProject, stripTemplateComments } from './previewProject';
import { isPrivatePath } from './paths';
import { isJavaScriptLogicPath, isPagePath, linkedScripts } from './sourceKinds';
import { getBundleEntryPath } from './studioProject';

export type PageComposition = Extract<ReturnType<typeof composePreviewProject>, { ok: true }>['composition'];
type ScriptRuntime = ReturnType<typeof createScriptRuntime>;

/** Console arguments as one line: printf-style messages filled in, stacks left out. */
export function formatConsoleArgs(args: unknown[]): string {
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

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
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

/** A context for a runtime of the check's own: state kept here, the store and navigation mocked, the console collected. */
export function quietContext(files: Map<string, VFSFile>, logs: string[]) {
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
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: {
      log: (...args: unknown[]) => logs.push(`log: ${formatConsoleArgs(args)}`),
      error: (...args: unknown[]) => logs.push(`error: ${formatConsoleArgs(args)}`),
      warn: (...args: unknown[]) => logs.push(`warn: ${formatConsoleArgs(args)}`),
    },
  };
}

/**
 * A fresh script runtime for a composed page — the engine the preview uses — with its logic loaded.
 * `appId` is what the logic's storage is kept under (`softn:<appId>:…`); a fresh one by default.
 */
export async function loadPageLogic(
  composition: Pick<PageComposition, 'importResolver' | 'logicBasePath' | 'preIncludedLogicPaths' | 'python'>,
  block: { type: string; code: string } | undefined,
  context: Parameters<typeof createScriptRuntime>[0],
  appId = `studio-agent-run-${Date.now().toString(36)}`,
): Promise<{ runtime: ScriptRuntime; loaded: Awaited<ReturnType<ScriptRuntime['loadScript']>> }> {
  const runtime = createScriptRuntime(
    context,
    undefined,
    appId,
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

/** The validator's type for logic that does not compile. */
export const LOGIC_SYNTAX = 'logic-syntax';

/** A finding as one line of the log: where, then what. */
export function describeProblem(problem: ValidationError): string {
  return `${problem.file}${problem.line ? `, line ${problem.line}` : ''}: ${problem.message}`;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Whether the engine refused to compile the logic, rather than the logic failing as it ran. */
export function isSyntaxError(text: string): boolean {
  return /\bSyntaxError\b/.test(text);
}

/** What a page composes to and the logic block it hands the engine, or null when there is none to load. */
function pageLogic(files: Map<string, VFSFile>, page: string): { composition: PageComposition; block: { type: string; code: string } | undefined } | null {
  const composed = composePreviewProject(files, page);
  // What the composer refuses the validator reports, in the composer's words.
  if (!composed.ok) return null;
  let block: { type: string; code: string } | undefined;
  try {
    const doc = parse(stripTemplateComments(composed.composition.source));
    block = doc.logic ?? doc.script;
  } catch {
    return null;
  }
  if (!block?.code.trim() && !composed.composition.python) return null;
  return { composition: composed.composition, block };
}

/**
 * What the check's loads keep their storage under, and take away again after each: the logic's
 * top level runs as it loads, and one that writes to localStorage would otherwise leave a set
 * of keys behind for every save.
 */
const CHECK_APP_ID = 'studio-logic-check';

function forgetCheckStorage(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(`softn:${CHECK_APP_ID}:`)) localStorage.removeItem(key);
    }
  } catch {
    // Storage may be unavailable; then nothing was kept in it.
  }
}

/** Load the logic as the check does, under the check's own storage, cleared after; throws what the engine threw. */
async function loadForCheck(
  files: Map<string, VFSFile>,
  composition: Parameters<typeof loadPageLogic>[0],
  block: { type: string; code: string } | undefined,
): Promise<void> {
  try {
    const { runtime } = await loadPageLogic(composition, block, quietContext(files, []) as never, CHECK_APP_ID);
    runtime.cleanup();
  } finally {
    forgetCheckStorage();
  }
}

/** Load `code` alone, with nothing it imports, and say what the engine said when it did not compile. */
async function compilesAlone(files: Map<string, VFSFile>, code: string): Promise<string | null> {
  try {
    await loadForCheck(files, { importResolver: async () => null, logicBasePath: undefined, preIncludedLogicPaths: [], python: undefined }, { type: 'logic', code });
    return null;
  } catch (err) {
    const text = message(err);
    return isSyntaxError(text) ? text : null;
  }
}

/** The engine's words for a JavaScript compile, split: what it said, and the line it quoted or that the end was reached. */
function readJavaScriptError(text: string): { said: string; quoted?: string; atEnd: boolean } {
  const said = text.replace(/^(?:\w*Error:\s*)?SyntaxError:\s*/, '');
  const quoted = /, at this line of the logic: ([\s\S]*)$/.exec(said);
  if (quoted) return { said: said.slice(0, quoted.index), quoted: quoted[1].trim(), atEnd: false };
  const end = /, at the end of the logic: [\s\S]*$/.exec(said);
  if (end) return { said: said.slice(0, end.index), atEnd: true };
  return { said, atEnd: false };
}

/** The 1-based line of `text` that reads `quoted` (trimmed, perhaps cut short with "…"), or null. */
function lineQuoted(text: string, quoted: string): number | null {
  const cut = quoted.endsWith('…') ? quoted.slice(0, -1) : null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (cut !== null ? line.startsWith(cut) : line === quoted) return i + 1;
  }
  return null;
}

/** The last line of `text` with anything on it. */
function lastLine(text: string): number {
  const lines = text.replace(/\s+$/, '').split('\n');
  return Math.max(1, lines.length);
}

/** A JavaScript source the engine joins into a page's logic: a file, or a page's inline block starting at `offset`. */
interface JavaScriptSource {
  file: string;
  code: string;
  /** Lines before the code in its file: 0 for a logic file, the block's start for a page's inline logic. */
  offset: number;
}

/**
 * The JavaScript a page's logic can be made of: the `.logic` files and the
 * `.js` files the pages link (lib/sourceKinds.ts; not Studio's own notes or a
 * server's code), and the inline `<logic>` and `<script>` blocks of every
 * page. Those whose code is in what the engine was given come first; the rest
 * are what that code imports, which the engine places as it loads.
 */
function javaScriptSources(files: Map<string, VFSFile>, joined: string): JavaScriptSource[] {
  const texts = new Map<string, string>();
  for (const [path, file] of files) {
    if (typeof file.content === 'string' && !isPrivatePath(path) && !/^server\//.test(path)) texts.set(path, file.content);
  }
  const linked = linkedScripts(texts);
  const out: JavaScriptSource[] = [];
  for (const [path, text] of texts) {
    if (isJavaScriptLogicPath(path) && (/\.logic$/i.test(path) || linked.has(path))) out.push({ file: path, code: text, offset: 0 });
    else if (isPagePath(path)) {
      for (const match of text.matchAll(/<(logic|script)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)) {
        if (/\bsrc\s*=/.test(match[2]) || !match[3].trim()) continue;
        const start = match.index + match[0].indexOf('>') + 1;
        out.push({ file: path, code: match[3], offset: text.slice(0, start).split('\n').length - 1 });
      }
    }
  }
  const inJoined = (source: JavaScriptSource) => source.code.split('\n').some((line) => line.trim().length > 3 && joined.includes(line.trim()));
  return [...out.filter(inJoined), ...out.filter((source) => !inJoined(source))];
}

/**
 * Where a JavaScript compile failed. Each source is compiled on its own (its
 * imports left out), and the first that fails alone is the one: its own
 * message then quotes a line of that file, or says the file ends with
 * something open. Failing that (two files that each compile, and do not once
 * joined), the line the engine quoted is looked for in every source.
 */
async function placeJavaScriptError(files: Map<string, VFSFile>, text: string, joined: string, fallback: string): Promise<ValidationError> {
  const sources = javaScriptSources(files, joined);
  for (const source of sources) {
    const alone = await compilesAlone(files, source.code);
    if (alone === null) continue;
    const own = readJavaScriptError(alone);
    const at = own.quoted !== undefined ? lineQuoted(source.code, own.quoted) : own.atEnd ? lastLine(source.code) : null;
    return logicProblem(source.file, at === null ? undefined : at + source.offset, own);
  }
  const read = readJavaScriptError(text);
  if (read.quoted !== undefined) {
    for (const source of sources) {
      const at = lineQuoted(source.code, read.quoted);
      if (at !== null) return logicProblem(source.file, at + source.offset, read);
    }
  }
  return logicProblem(fallback, undefined, read);
}

function logicProblem(file: string, line: number | undefined, read: { said: string; quoted?: string; atEnd: boolean }): ValidationError {
  const where = read.quoted !== undefined
    ? `: ${read.quoted}`
    : read.atEnd
      ? ': the file ends with a brace, bracket or string still open'
      : '';
  return {
    file,
    ...(line !== undefined ? { line } : {}),
    level: 'error',
    type: LOGIC_SYNTAX,
    message: `The logic does not compile: ${read.said}${where}`,
    suggestion: 'Nothing in the app runs until its logic compiles, and Run and Publish wait for it.',
  };
}

/** Python's own words name the module and the line: "invalid syntax … (main.py:15:12)". */
function placePythonError(files: Map<string, VFSFile>, text: string, fallback: string): ValidationError {
  const said = text.replace(/^(?:\w*Error:\s*)?SyntaxError:\s*/, '');
  const at = /\s*\(([^():\s]+\.py):(\d+)(?::(\d+))?\)\s*$/.exec(said);
  const module = at?.[1];
  const file = module ? [...files.keys()].find((path) => path === module) ?? [...files.keys()].find((path) => path.endsWith(`/${module}`)) : undefined;
  const column = at?.[3] !== undefined ? ` (column ${at[3]})` : '';
  return {
    file: file ?? fallback,
    ...(at ? { line: Number(at[2]) } : {}),
    level: 'error',
    type: LOGIC_SYNTAX,
    message: `The logic does not compile${column}: ${at ? said.slice(0, at.index) : said}`,
    suggestion: 'Nothing in the app runs until its logic compiles, and Run and Publish wait for it.',
  };
}

/**
 * The pages whose logic to load: the app's main page first, then the rest.
 * Most of them compose to the main page's logic (a page the app imports is
 * given the app's), which is loaded once.
 */
function pagesToLoad(files: Map<string, VFSFile>): string[] {
  const entry = getBundleEntryPath(files);
  const pages = [...files.keys()].filter((path) => isPagePath(path) && !isPrivatePath(path)).sort();
  return entry && pages.includes(entry) ? [entry, ...pages.filter((path) => path !== entry)] : pages;
}

/** The engine's answer for each set of files it was asked about, while those files are held. */
const answers = new WeakMap<Map<string, VFSFile>, Promise<ValidationError[]>>();

/**
 * Whether the app's logic compiles, page by page, as the engine compiles it:
 * a problem for each logic that does not, at its file and line. Logic that
 * compiles and then fails as it runs is the preview's to report, as it is the
 * runtime's.
 */
export function logicSyntaxProblems(files: Map<string, VFSFile>): Promise<ValidationError[]> {
  // The same files are asked about once: the check (lib/projectCheck.ts) and the log, which
  // places the preview's own report of the same failure (VisualCanvas.tsx), share the answer.
  const known = answers.get(files);
  if (known) return known;
  const answer = checkLogic(files);
  answers.set(files, answer);
  return answer;
}

/*
 * Not run as a check (lib/previewFaults.ts's duringCheck): while one is going, a line the
 * runtime prints that names no function of the app's is taken for the check's and kept from the
 * preview, and this one runs after every change to the logic, at the moment the preview is
 * loading the same logic and reporting why it did not start. What this load prints is what the
 * preview's prints, which the log says once. Nor is the console swapped here (appCheck's renders
 * do that): two checks swapping it at once, each giving back what it found, can leave it with the
 * other's for good.
 */
async function checkLogic(files: Map<string, VFSFile>): Promise<ValidationError[]> {
  const problems: ValidationError[] = [];
  const loaded = new Set<string>();
  for (const page of pagesToLoad(files)) {
    const logic = pageLogic(files, page);
    if (!logic) continue;
    const { composition, block } = logic;
    const key = `${JSON.stringify(composition.python ?? null)}\u0000${block?.code ?? ''}`;
    if (loaded.has(key)) continue;
    loaded.add(key);
    try {
      await loadForCheck(files, composition, block);
    } catch (err) {
      const text = message(err);
      if (!isSyntaxError(text)) continue;
      const problem = composition.python
        ? placePythonError(files, text, page)
        : await placeJavaScriptError(files, text, block?.code ?? '', page);
      if (!problems.some((p) => p.file === problem.file && p.line === problem.line && p.message === problem.message)) problems.push(problem);
    }
  }
  return problems;
}
