/**
 * SoftN Token Types
 *
 * Defines all tokens recognized by the SoftN lexer.
 */

export enum TokenType {
  // End of file
  EOF = 'EOF',

  // Identifiers and literals
  IDENTIFIER = 'IDENTIFIER',
  STRING = 'STRING',
  NUMBER = 'NUMBER',
  TEXT = 'TEXT',

  // Tags
  TAG_OPEN = 'TAG_OPEN', // <
  TAG_CLOSE = 'TAG_CLOSE', // >
  TAG_SELF_CLOSE = 'TAG_SELF_CLOSE', // />
  TAG_END_OPEN = 'TAG_END_OPEN', // </
  SLASH = 'SLASH', // /

  // Attributes
  EQUALS = 'EQUALS', // =

  // Expressions
  EXPR_START = 'EXPR_START', // {
  EXPR_END = 'EXPR_END', // }

  // Directives
  AT = 'AT', // @ (events)
  COLON = 'COLON', // : (bindings)
  HASH = 'HASH', // # (control flow)

  // Control flow keywords
  IF = 'IF',
  ELSE = 'ELSE',
  ELSEIF = 'ELSEIF',
  EACH = 'EACH',
  END = 'END',
  EMPTY = 'EMPTY',
  IN = 'IN',

  // Special block keywords
  SCRIPT = 'SCRIPT',
  LOGIC = 'LOGIC',
  STYLE = 'STYLE',
  DATA = 'DATA',
  COMPONENT = 'COMPONENT',
  IMPORT = 'IMPORT',
  FROM = 'FROM',
  PROP = 'PROP',
  SLOT = 'SLOT',
  TEMPLATE = 'TEMPLATE',
  COLLECTION = 'COLLECTION',

  // Block content (raw content between tags)
  SCRIPT_CONTENT = 'SCRIPT_CONTENT',
  LOGIC_CONTENT = 'LOGIC_CONTENT',
  STYLE_CONTENT = 'STYLE_CONTENT',

  // Punctuation
  COMMA = 'COMMA', // ,
  DOT = 'DOT', // .
  LPAREN = 'LPAREN', // (
  RPAREN = 'RPAREN', // )
  LBRACKET = 'LBRACKET', // [
  RBRACKET = 'RBRACKET', // ]

  // Operators (for expressions)
  PLUS = 'PLUS',
  MINUS = 'MINUS',
  ASTERISK = 'ASTERISK',
  PERCENT = 'PERCENT',
  BANG = 'BANG',
  EQ = 'EQ', // ==
  NOT_EQ = 'NOT_EQ', // !=
  EQ_STRICT = 'EQ_STRICT', // ===
  NOT_EQ_STRICT = 'NOT_EQ_STRICT', // !==
  LT = 'LT', // <
  GT = 'GT', // >
  LTE = 'LTE', // <=
  GTE = 'GTE', // >=
  AND = 'AND', // &&
  OR = 'OR', // ||
  QUESTION = 'QUESTION', // ?
  OPTIONAL_CHAIN = 'OPTIONAL_CHAIN', // ?.
  OPTIONAL_BRACKET = 'OPTIONAL_BRACKET', // ?.[
  NULLISH_COALESCE = 'NULLISH_COALESCE', // ??
  NULLISH_ASSIGN = 'NULLISH_ASSIGN', // ??=
  OR_ASSIGN = 'OR_ASSIGN', // ||=
  AND_ASSIGN = 'AND_ASSIGN', // &&=
  ARROW = 'ARROW', // =>
  DOLLAR = 'DOLLAR', // $ (for $:)
  SEMICOLON = 'SEMICOLON', // ;
  SPREAD = 'SPREAD', // ...
  BACKTICK = 'BACKTICK', // `
  TEMPLATE_STRING = 'TEMPLATE_STRING', // template literal content
  TEMPLATE_EXPR_START = 'TEMPLATE_EXPR_START', // ${
  TEMPLATE_EXPR_END = 'TEMPLATE_EXPR_END', // } in template

  // Keywords (for expressions)
  LET = 'LET',
  CONST = 'CONST',
  FUNCTION = 'FUNCTION',
  ASYNC = 'ASYNC',
  AWAIT = 'AWAIT',
  RETURN = 'RETURN',
  TRUE = 'TRUE',
  FALSE = 'FALSE',
  NULL = 'NULL',
  UNDEFINED = 'UNDEFINED',
  TYPEOF = 'TYPEOF',
  INSTANCEOF = 'INSTANCEOF',
  NEW = 'NEW',
  THIS = 'THIS',
  DELETE = 'DELETE',
  VOID = 'VOID',

  // Comments
  COMMENT = 'COMMENT',
}

export interface Token {
  type: TokenType;
  literal: string;
  line: number;
  column: number;
  start: number;
  end: number;
}

export interface SourceLocation {
  line: number;
  column: number;
  start: number;
  end: number;
}

/**
 * Keywords map for quick lookup
 */
export const KEYWORDS: Record<string, TokenType> = {
  // Control flow
  if: TokenType.IF,
  else: TokenType.ELSE,
  elseif: TokenType.ELSEIF,
  each: TokenType.EACH,
  end: TokenType.END,
  empty: TokenType.EMPTY,
  in: TokenType.IN,

  // Block types
  script: TokenType.SCRIPT,
  logic: TokenType.LOGIC,
  style: TokenType.STYLE,
  data: TokenType.DATA,
  component: TokenType.COMPONENT,
  import: TokenType.IMPORT,
  from: TokenType.FROM,
  prop: TokenType.PROP,
  slot: TokenType.SLOT,
  template: TokenType.TEMPLATE,
  collection: TokenType.COLLECTION,

  // Expression keywords
  let: TokenType.LET,
  const: TokenType.CONST,
  function: TokenType.FUNCTION,
  async: TokenType.ASYNC,
  await: TokenType.AWAIT,
  return: TokenType.RETURN,
  true: TokenType.TRUE,
  false: TokenType.FALSE,
  null: TokenType.NULL,
  undefined: TokenType.UNDEFINED,
  typeof: TokenType.TYPEOF,
  instanceof: TokenType.INSTANCEOF,
  new: TokenType.NEW,
  this: TokenType.THIS,
  delete: TokenType.DELETE,
  void: TokenType.VOID,
};

/**
 * Check if a string is a keyword
 */
export function lookupKeyword(identifier: string): TokenType {
  return KEYWORDS[identifier] ?? TokenType.IDENTIFIER;
}

/**
 * Create a token
 */
export function createToken(
  type: TokenType,
  literal: string,
  line: number,
  column: number,
  start: number,
  end: number
): Token {
  return { type, literal, line, column, start, end };
}
