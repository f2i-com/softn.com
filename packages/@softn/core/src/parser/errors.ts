/**
 * SoftN Parser Errors
 *
 * Custom error types for parser error reporting.
 */

import type { Token, SourceLocation } from './token';

export class SoftNParseError extends Error {
  public loc: SourceLocation;
  public source?: string;

  constructor(message: string, loc: SourceLocation, source?: string) {
    super(message);
    this.name = 'SoftNParseError';
    this.loc = loc;
    this.source = source;
  }

  /**
   * Format error with source context
   */
  public format(): string {
    let result = `${this.name}: ${this.message}\n`;
    result += `  at line ${this.loc.line}, column ${this.loc.column}\n`;

    if (this.source) {
      const lines = sourceLines(this.source);
      const line = lines[this.loc.line - 1];
      if (line) {
        result += `\n  ${this.loc.line} | ${line}\n`;
        result += `    | ${caretPad(this.loc.column)}^\n`;
      }
    }

    return result;
  }
}

export class UnexpectedTokenError extends SoftNParseError {
  public expected?: string;
  public got: Token;

  constructor(got: Token, expected?: string, source?: string) {
    const message = expected
      ? `Unexpected token "${got.literal}" (${got.type}), expected ${expected}`
      : `Unexpected token "${got.literal}" (${got.type})`;

    super(
      message,
      {
        line: got.line,
        column: got.column,
        start: got.start,
        end: got.end,
      },
      source
    );

    this.name = 'UnexpectedTokenError';
    this.expected = expected;
    this.got = got;
  }
}

export class UnclosedTagError extends SoftNParseError {
  public tagName: string;

  constructor(tagName: string, loc: SourceLocation, source?: string) {
    super(`Unclosed tag: <${tagName}>`, loc, source);
    this.name = 'UnclosedTagError';
    this.tagName = tagName;
  }
}

export class MismatchedTagError extends SoftNParseError {
  public openTag: string;
  public closeTag: string;

  constructor(openTag: string, closeTag: string, loc: SourceLocation, source?: string) {
    super(`Mismatched tags: expected </${openTag}>, got </${closeTag}>`, loc, source);
    this.name = 'MismatchedTagError';
    this.openTag = openTag;
    this.closeTag = closeTag;
  }
}

export class InvalidExpressionError extends SoftNParseError {
  constructor(expression: string, loc: SourceLocation, source?: string) {
    super(`Invalid expression: ${expression}`, loc, source);
    this.name = 'InvalidExpressionError';
  }
}

export class DuplicatePropError extends SoftNParseError {
  public propName: string;

  constructor(propName: string, loc: SourceLocation, source?: string) {
    super(`Duplicate property: ${propName}`, loc, source);
    this.name = 'DuplicatePropError';
    this.propName = propName;
  }
}

export class InvalidControlFlowError extends SoftNParseError {
  constructor(message: string, loc: SourceLocation, source?: string) {
    super(message, loc, source);
    this.name = 'InvalidControlFlowError';
  }
}

export class InvalidCollectionError extends SoftNParseError {
  constructor(message: string, loc: SourceLocation, source?: string) {
    super(message, loc, source);
    this.name = 'InvalidCollectionError';
  }
}

/**
 * A page's lines as an excerpt quotes them, counted as the lexer counts them
 * (by LF), with no `\r` left at the end of one saved with CR LF to send the
 * caret line back over the quoted one.
 */
function sourceLines(source: string): string[] {
  return source.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/**
 * The spaces before the caret under column `column`. A token that begins
 * with the line break before it (words after an element) is at column 0,
 * and `' '.repeat(-1)` threw out of the error's own report.
 */
function caretPad(column: number): string {
  return ' '.repeat(Math.max(0, column - 1));
}

/**
 * Create error context for better error messages
 */
export function createErrorContext(
  source: string,
  loc: SourceLocation,
  contextLines: number = 2
): string {
  const lines = sourceLines(source);
  const startLine = Math.max(0, loc.line - 1 - contextLines);
  const endLine = Math.min(lines.length, loc.line + contextLines);

  let result = '';
  for (let i = startLine; i < endLine; i++) {
    const lineNum = i + 1;
    const prefix = lineNum === loc.line ? '> ' : '  ';
    result += `${prefix}${lineNum.toString().padStart(4)} | ${lines[i]}\n`;

    if (lineNum === loc.line) {
      result += `       | ${caretPad(loc.column)}^\n`;
    }
  }

  return result;
}
