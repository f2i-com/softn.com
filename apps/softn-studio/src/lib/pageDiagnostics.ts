/**
 * What core's parser says about a project's pages, each read as its own file.
 *
 * One reading for both checks: Studio's (validator.ts, the problem list under
 * the canvas, which holds Run and Publish back) and the agent's
 * (agent/appCheck.ts, check_app). Studio's used to parse nothing at all: a page
 * missing a closing tag left the status bar at "No problems" and Run enabled,
 * while the preview printed the parser's error to a console no one sees.
 *
 * A page is read with its `//` template comment lines blanked rather than
 * removed, so a diagnostic's line is the file's own line: the composed page
 * the preview draws inlines its imports, and a line of that is one the
 * person cannot find in any file.
 */

import { parse, resolveBundlePath, UI_IMPORT_PATTERN } from '@softn/core';
import type { ValidationError, VFSFile } from '../types/studio';
import { isPrivatePath } from './paths';
import { isPagePath } from './sourceKinds';

/**
 * What the composer does with `<import Name from="./x.ui" />`: core's own pattern, so the
 * files checked are the files placed. The check had a copy that took only `from="…"`; the
 * composer also places `from "…"`, and a page imported that way was placed and never checked.
 */
export const UI_IMPORT = new RegExp(UI_IMPORT_PATTERN.source, 'g');

/**
 * A page as the parser should read it for line numbers that match the
 * file: `//` template comment lines blanked, not removed, and nothing
 * collapsed or trimmed (stripTemplateComments does both, for the preview).
 */
export function blankTemplateComments(source: string): string {
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

/** One thing the parser said, at the line and column it said it. */
export interface PageDiagnostic {
  severity: 'error' | 'warning';
  message: string;
  line?: number;
  column?: number;
}

/** What the parser says of `source`: its diagnostics, or the error it threw. */
export function pageDiagnostics(source: string): PageDiagnostic[] {
  try {
    const doc = parse(source);
    return (doc.diagnostics ?? []).map((d) => ({
      severity: d.severity === 'error' ? 'error' : 'warning',
      message: d.message,
      line: d.loc.line,
      column: d.loc.column,
    }));
  } catch (err) {
    const loc = (err as { loc?: { line?: unknown; column?: unknown } } | null)?.loc;
    return [{
      severity: 'error',
      message: err instanceof Error ? err.message : String(err),
      ...(typeof loc?.line === 'number' ? { line: loc.line } : {}),
      ...(typeof loc?.column === 'number' ? { column: loc.column } : {}),
    }];
  }
}

/** A diagnostic as the agent has always read one: "Parse error at line 4:4: …". */
export function describeDiagnostic(d: PageDiagnostic): string {
  return d.line !== undefined ? `Parse ${d.severity} at line ${d.line}:${d.column ?? 1}: ${d.message}` : `Parse ${d.severity}: ${d.message}`;
}

/** The parser's errors and warnings for `source`, as lines. */
export function parseDiagnostics(source: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const d of pageDiagnostics(source)) (d.severity === 'error' ? errors : warnings).push(describeDiagnostic(d));
  return { errors, warnings };
}

/**
 * Parse errors in the page and the pages it imports, each against its own
 * file and lines. The composed page inlines its imports, so an error in an
 * imported page used to be reported against the main page at a line of the
 * composed source — a line the model could not find in either file (a real
 * run spent a step "fixing" the wrong file). Empty when no file fails on its
 * own.
 */
export function ownParseErrors(files: Map<string, VFSFile>, page: string): string[] {
  return pageAndImports(files, page).flatMap((path) => {
    const content = files.get(path)?.content;
    return typeof content === 'string' ? parseDiagnostics(blankTemplateComments(content)).errors.map((e) => `${path}: ${e}`) : [];
  });
}

/** `page` and every page it imports, as the composer places them: itself first, each once, those in the project only. */
export function pageAndImports(files: Map<string, VFSFile>, page: string): string[] {
  const out: string[] = [];
  const queue = [page];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const file = files.get(path);
    if (!file || typeof file.content !== 'string') continue;
    out.push(path);
    for (const match of file.content.matchAll(UI_IMPORT)) {
      try {
        queue.push(resolveBundlePath(path, match[2]));
      } catch {
        // An unsafe path is the composer's to report.
      }
    }
  }
  return out;
}

/** The validator's type for what the parser says of a page. */
export const PAGE_PARSE = 'page-parse';

/**
 * Every page of the project, parsed on its own: an error is an error (the
 * runtime draws a page that does not parse as best it can, which is not the
 * page that was written), a warning a warning, each with its file and line
 * (the problem list shows them as `pages/home.html:4`).
 */
export function pageParseProblems(files: Map<string, VFSFile>): ValidationError[] {
  const problems: ValidationError[] = [];
  for (const [path, file] of files) {
    if (typeof file.content !== 'string' || !isPagePath(path) || isPrivatePath(path)) continue;
    for (const d of pageDiagnostics(blankTemplateComments(file.content))) {
      problems.push({
        file: path,
        ...(d.line !== undefined ? { line: d.line } : {}),
        level: d.severity,
        type: PAGE_PARSE,
        message: d.severity === 'error' ? `The page does not parse${d.column !== undefined ? ` (column ${d.column})` : ''}: ${d.message}` : d.message,
        ...(d.severity === 'error' ? { suggestion: 'The page is not drawn as written until this is fixed, and Run and Publish wait for it.' } : {}),
      });
    }
  }
  return problems;
}
