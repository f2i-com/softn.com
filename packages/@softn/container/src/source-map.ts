/**
 * Source-line mapping and code-frame formatter for `@softn/container`.
 *
 * Inside the ZIPP Web Worker, runtime preludes, ES module factories, and classic
 * `<script>` blocks are concatenated into a single program string before
 * `engine.initSource(...)`. Without mapping, ZIPP reports raw combined line
 * numbers (e.g. `:4812:14`) instead of the user's real file & line number
 * (e.g. `about.html:47:14` or `src/app.js:12:4`).
 *
 * `SourceMapRegistry` records every concatenated user segment (with its exact
 * wrapper header offset and original HTML start line) and translates both
 * compile-time errors and runtime stack frames back to exact source locations
 * with formatted 3-line code frames.
 */

export interface SourceSegment {
  /** Display file path inside the app archive (e.g. `src/app.js`, `about.html`). */
  file: string;
  /** 1-based start line of this segment inside the combined ZIPP program. */
  combinedStart: number;
  /** 1-based inclusive end line of this segment inside the combined ZIPP program. */
  combinedEnd: number;
  /** 1-based starting line inside the original file (1 for `.js` files, `<script>` line for inline HTML scripts). */
  sourceStartLine: number;
  /** Number of synthetic wrapper lines prepended before the user's code inside this segment. */
  wrapperLines: number;
  /** Original source text for generating a numbered code-frame snippet. */
  sourceText?: string;
}

export interface ResolvedSourceLocation {
  file: string;
  line: number;
  column?: number;
  snippet?: string;
}

export interface EvalFallbackSource {
  file: string;
  startLine: number;
  sourceText?: string;
  /** True only when the script actually executed via `(0, eval)` so 1-based eval lines are valid. */
  isEval?: boolean;
}

export interface EnrichedContainerError {
  message: string;
  file?: string;
  line?: number;
  column?: number;
  stack?: string;
  snippet?: string;
}

/** Count line breaks as JS counts them (`\r\n`, `\n`, or `\r`). */
export function countLineBreaks(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 10) {
      count++;
    } else if (ch === 13) {
      count++;
      if (text.charCodeAt(i + 1) === 10) i++;
    }
  }
  return count;
}

/**
 * Format a compact 3-line numbered code frame highlighting `localLine` (1-based
 * within `sourceText`) labeled with `displayLine` (1-based within the file).
 */
export function formatCodeFrame(
  sourceText: string,
  localLine: number,
  displayLine: number,
  column?: number,
): string | undefined {
  if (!sourceText || localLine < 1) return undefined;
  const lines = sourceText.split(/\r\n|\n|\r/);
  if (localLine > lines.length) return undefined;
  const from = Math.max(1, localLine - 1);
  const to = Math.min(lines.length, localLine + 1);
  const maxLabel = String(displayLine + (to - localLine)).length;
  const out: string[] = [];
  for (let i = from; i <= to; i++) {
    const label = String(displayLine + (i - localLine)).padStart(maxLabel, ' ');
    const prefix = i === localLine ? '>' : ' ';
    const raw = lines[i - 1] ?? '';
    const trimmed = raw.length > 160 ? `${raw.slice(0, 157)}...` : raw;
    out.push(`${prefix} ${label} | ${trimmed}`);
    if (i === localLine && typeof column === 'number' && column >= 1 && column <= 160) {
      const pad = ' '.repeat(maxLabel);
      const caret = ' '.repeat(Math.max(0, column - 1)) + '^';
      out.push(`  ${pad} | ${caret}`);
    }
  }
  return out.join('\n');
}

/**
 * Scan raw HTML text and return the 1-based line number of each `<script>` tag's
 * body start (the character immediately after `<script ...>`), in document order,
 * skipping HTML comments, quoted attributes, and inert/raw-text elements
 * (`<template>`, `<textarea>`, `<style>`, `<title>`, `<noscript>`, `<xmp>`).
 */
export function findInlineScriptStartLines(html: string): number[] {
  const result: number[] = [];
  const len = html.length;
  let line = 1;
  let i = 0;

  const advanceToTagEnd = (startPos: number): number => {
    let j = startPos;
    let quote = 0;
    while (j < len) {
      const c = html.charCodeAt(j);
      if (c === 10) {
        line++;
      } else if (c === 13) {
        line++;
        if (html.charCodeAt(j + 1) === 10) j++;
      } else if (quote !== 0) {
        if (c === quote) quote = 0;
      } else if (c === 34 || c === 39) {
        quote = c;
      } else if (c === 62) {
        return j + 1;
      }
      j++;
    }
    return j;
  };

  while (i < len) {
    const ch = html.charCodeAt(i);
    if (ch === 10) {
      line++;
      i++;
      continue;
    }
    if (ch === 13) {
      line++;
      i += html.charCodeAt(i + 1) === 10 ? 2 : 1;
      continue;
    }
    // Skip HTML comments `<!-- ... -->`
    if (ch === 60 && html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      const stop = end < 0 ? len : end + 3;
      line += countLineBreaks(html.slice(i, stop));
      i = stop;
      continue;
    }
    // Match `<script` opening tag followed by whitespace, `>`, or `/`
    if (ch === 60 && /^<script(?=[\s/>])/i.test(html.slice(i, i + 8))) {
      const j = advanceToTagEnd(i + 7);
      result.push(line);
      // Advance past `</script>` so `<script` inside JS strings isn't miscounted
      const closeMatch = /<\/script\s*>/i.exec(html.slice(j));
      if (closeMatch) {
        const endPos = j + closeMatch.index + closeMatch[0].length;
        line += countLineBreaks(html.slice(j, endPos));
        i = endPos;
      } else {
        i = j;
      }
      continue;
    }
    // Skip raw-text / inert elements whose bodies do not execute as live scripts
    if (ch === 60) {
      const inertMatch = /^<(textarea|style|title|noscript|xmp|template)(?=[\s/>])/i.exec(html.slice(i, i + 16));
      if (inertMatch) {
        const tag = inertMatch[1].toLowerCase();
        const j = advanceToTagEnd(i + 1 + tag.length);
        if (tag === 'template') {
          let depth = 1;
          let scan = j;
          const tmplRe = /<(\/?)template(?=[\s/>])/gi;
          tmplRe.lastIndex = scan;
          let m: RegExpExecArray | null;
          while ((m = tmplRe.exec(html)) !== null) {
            if (m[1] === '/') {
              depth--;
              const closeGt = html.indexOf('>', m.index);
              scan = closeGt < 0 ? len : closeGt + 1;
              if (depth === 0) break;
            } else {
              depth++;
            }
          }
          line += countLineBreaks(html.slice(j, depth === 0 ? scan : len));
          i = depth === 0 ? scan : len;
        } else {
          const closeRe = new RegExp(`<\\/${tag}\\s*>`, 'i');
          const closeMatch = closeRe.exec(html.slice(j));
          if (closeMatch) {
            const endPos = j + closeMatch.index + closeMatch[0].length;
            line += countLineBreaks(html.slice(j, endPos));
            i = endPos;
          } else {
            i = j;
          }
        }
        continue;
      }
      // Advance past any other HTML opening tag respecting quoted attributes
      // so `<div data-x="<!--">` or `<div title="<script>">` never confuses scanning.
      if (i + 1 < len && /[A-Za-z]/.test(html[i + 1])) {
        i = advanceToTagEnd(i + 2);
        continue;
      }
    }
    i++;
  }
  return result;
}

const RAW_LOCATION_RE = /(^|[\s(])(at\s+)?(<eval>|<anonymous>|eval|script|module|https?:\/\/(?:app\.)?softn\.local\/[^\s):]*)?:(\d+):(\d+)/gm;
const LINE_ONLY_RE = /\bline\s+(\d+)(?:,?\s*col(?:umn)?\s+(\d+))?/gi;

export class SourceMapRegistry {
  private segments: SourceSegment[] = [];

  clear(): void {
    this.segments = [];
  }

  addSegment(segment: SourceSegment): void {
    this.segments.push(segment);
  }

  getSegments(): readonly SourceSegment[] {
    return this.segments;
  }

  /**
   * Resolve a 1-based combined program line number (and optional 1-based column)
   * back to the user's source file, 1-based line number, and optional code frame.
   */
  resolveCombinedLine(combinedLine: number, column?: number): ResolvedSourceLocation | null {
    if (!Number.isFinite(combinedLine) || combinedLine < 1) return null;
    for (const seg of this.segments) {
      if (combinedLine >= seg.combinedStart && combinedLine <= seg.combinedEnd) {
        const rawOffset = combinedLine - seg.combinedStart - seg.wrapperLines;
        const localLine = Math.max(1, rawOffset + 1);
        const displayLine = seg.sourceStartLine + (localLine - 1);
        const snippet = seg.sourceText
          ? formatCodeFrame(seg.sourceText, localLine, displayLine, column)
          : undefined;
        return {
          file: seg.file,
          line: displayLine,
          ...(typeof column === 'number' && column >= 1 ? { column } : {}),
          ...(snippet ? { snippet } : {}),
        };
      }
    }
    return null;
  }

  /**
   * Resolve a 1-based line number from an indirect `(0, eval)(code)` call
   * using the script's own metadata (`file`, `startLine`, `sourceText`).
   */
  resolveEvalLine(evalLine: number, fallback: EvalFallbackSource, column?: number): ResolvedSourceLocation | null {
    if (!Number.isFinite(evalLine) || evalLine < 1) return null;
    if (fallback.sourceText) {
      const maxLines = countLineBreaks(fallback.sourceText) + 1;
      if (evalLine > maxLines) return null;
    }
    const localLine = Math.max(1, evalLine);
    const displayLine = fallback.startLine + (localLine - 1);
    const snippet = fallback.sourceText
      ? formatCodeFrame(fallback.sourceText, localLine, displayLine, column)
      : undefined;
    return {
      file: fallback.file,
      line: displayLine,
      ...(typeof column === 'number' && column >= 1 ? { column } : {}),
      ...(snippet ? { snippet } : {}),
    };
  }

  /**
   * Rewrite combined `:line:col` references inside an error message or stack trace
   * and return structured `{ message, file, line, column, stack, snippet }`.
   */
  enrichError(err: unknown, evalFallback?: EvalFallbackSource): EnrichedContainerError {
    const rawMessage = err instanceof Error ? err.message : String(err ?? 'Unknown error');
    const rawStack = err instanceof Error && typeof err.stack === 'string' ? err.stack : undefined;
    let firstLocation: ResolvedSourceLocation | null = null;

    const mapOne = (lineNum: number, colNum?: number): ResolvedSourceLocation | null => {
      const mapped =
        this.resolveCombinedLine(lineNum, colNum) ??
        (evalFallback && evalFallback.isEval !== false ? this.resolveEvalLine(lineNum, evalFallback, colNum) : null);
      if (mapped && !firstLocation) firstLocation = mapped;
      return mapped;
    };

    const remapText = (text: string): string => {
      let out = text.replace(
        RAW_LOCATION_RE,
        (full, lead: string, atPrefix: string | undefined, srcTag: string | undefined, lineStr: string, colStr: string) => {
          // Require an explicit frame marker (`at `, a known eval/virtual source name, or `(:line:col)`)
          // so unrelated text like `zipp:preamble:1:24` or timestamps `10:05:30` are never corrupted.
          if (!atPrefix && !srcTag && lead !== '(') return full;
          const lineNum = Number(lineStr);
          const colNum = Number(colStr);
          const mapped = mapOne(lineNum, colNum);
          if (!mapped) return full;
          return `${lead}${atPrefix ?? ''}${mapped.file}:${mapped.line}:${colNum}`;
        },
      );
      out = out.replace(LINE_ONLY_RE, (full, lineStr: string, colStr?: string) => {
        const lineNum = Number(lineStr);
        const colNum = colStr ? Number(colStr) : undefined;
        const mapped = mapOne(lineNum, colNum);
        if (!mapped) return full;
        return colNum !== undefined
          ? `${mapped.file}:${mapped.line}:${colNum}`
          : `${mapped.file}:${mapped.line}`;
      });
      return out;
    };

    const remappedMessage = remapText(rawMessage);
    const remappedStack = rawStack ? remapText(rawStack) : undefined;

    // If the error came from a known script (evalFallback) without an explicit line number,
    // still surface the file and starting line so developers immediately know which script failed.
    if (!firstLocation && evalFallback) {
      firstLocation = {
        file: evalFallback.file,
        line: evalFallback.startLine,
        ...(evalFallback.sourceText
          ? { snippet: formatCodeFrame(evalFallback.sourceText, 1, evalFallback.startLine) }
          : {}),
      };
    }

    const loc = firstLocation as ResolvedSourceLocation | null;
    const prefixLoc = loc
      ? `${loc.file}:${loc.line}${loc.column !== undefined ? `:${loc.column}` : ''}`
      : '';
    const finalMessage =
      prefixLoc && !remappedMessage.includes(prefixLoc)
        ? `${prefixLoc} — ${remappedMessage}`
        : remappedMessage;

    return {
      message: finalMessage,
      ...(loc ? { file: loc.file, line: loc.line } : {}),
      ...(loc?.column !== undefined ? { column: loc.column } : {}),
      ...(remappedStack ? { stack: remappedStack } : {}),
      ...(loc?.snippet ? { snippet: loc.snippet } : {}),
    };
  }
}
