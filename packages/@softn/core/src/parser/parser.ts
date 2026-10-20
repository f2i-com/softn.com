/**
 * SoftN Parser
 *
 * Parses .softn source code into an Abstract Syntax Tree.
 */

import { Lexer } from './lexer';
import { Token, TokenType, SourceLocation } from './token';
import {
  SoftNDocument,
  ImportDeclaration,
  ComponentDeclaration,
  PropDeclaration,
  ScriptBlock,
  LogicBlock,
  DataBlock,
  CollectionDeclaration,
  StyleBlock,
  TemplateNode,
  ElementNode,
  SlotNode,
  TemplateSlotNode,
  ExpressionNode,
  IfBlock,
  EachBlock,
  PropNode,
  EventNode,
  BindingNode,
  Expression,
  ArrowFunctionExpression,
  AssignmentOperator,
  ObjectExpression,
  SpreadElement,
  BindingPattern,
  BindingTarget,
  ParamPattern,
  PropValue,
  TopLevelElement,
  ParseDiagnostic,
  createDocument,
  createElementNode,
  createTextNode,
  decodeHtmlEntities,
  createIdentifier,
  createLiteral,
  isEventModifier,
  patternNames,
  patternText,
  isImportDeclaration,
  isComponentDeclaration,
  isScriptBlock,
  isLogicBlock,
  isDataBlock,
  isStyleBlock,
  isTemplateNode,
} from './ast';
import {
  VOID_ELEMENTS,
  HEAD_ELEMENTS,
  DocumentWrapper,
  callbackName,
  documentWrapper,
  htmlAttributeName,
  htmlHandlerEvent,
  isHtmlElementTag,
  isRemoteReference,
  normalizeTagName,
  sameTagName,
  scriptLanguage,
} from './html';
import {
  SoftNParseError,
  UnexpectedTokenError,
  UnclosedTagError,
  MismatchedTagError,
  InvalidCollectionError,
} from './errors';

/** The tokens that begin an assignment's right-hand side, by operator. */
const ASSIGNMENT_OPERATORS: ReadonlyMap<TokenType, AssignmentOperator> = new Map([
  [TokenType.EQUALS, '='],
  [TokenType.PLUS_ASSIGN, '+='],
  [TokenType.MINUS_ASSIGN, '-='],
  [TokenType.ASTERISK_ASSIGN, '*='],
  [TokenType.SLASH_ASSIGN, '/='],
  [TokenType.PERCENT_ASSIGN, '%='],
  [TokenType.EXPONENT_ASSIGN, '**='],
  [TokenType.NULLISH_ASSIGN, '??='],
  [TokenType.OR_ASSIGN, '||='],
  [TokenType.AND_ASSIGN, '&&='],
]);

/**
 * Words the lexer types as keywords because markup gives them meaning:
 * after `<` (`<data>`, `<slot>`), after `#` (`#each`, `#end`) or inside an
 * import. In an expression they are ordinary names, and common ones: a
 * variable called `data`, `style`, `from` or `end` could not be read
 * (`{data.title}` was "Unexpected token data"), and `#each (prop in props)`
 * failed on its own loop variable. JavaScript's reserved words are not here.
 */
const CONTEXTUAL_KEYWORDS: ReadonlySet<TokenType> = new Set([
  TokenType.EACH,
  TokenType.END,
  TokenType.EMPTY,
  TokenType.ELSEIF,
  TokenType.SCRIPT,
  TokenType.LOGIC,
  TokenType.STYLE,
  TokenType.DATA,
  TokenType.COMPONENT,
  TokenType.FROM,
  TokenType.PROP,
  TokenType.SLOT,
  TokenType.TEMPLATE,
  TokenType.COLLECTION,
]);

/**
 * Operators that need a value on their left. One of these where a value
 * should begin means the value is missing, and the parser would go on to
 * apply the operator to a synthetic `undefined` without a word: see
 * parsePrimary.
 */
const NEEDS_LEFT_OPERAND: ReadonlySet<TokenType> = new Set([
  TokenType.SLASH,
  TokenType.ASTERISK,
  TokenType.PERCENT,
  TokenType.EXPONENT,
  TokenType.EQ,
  TokenType.NOT_EQ,
  TokenType.EQ_STRICT,
  TokenType.NOT_EQ_STRICT,
  TokenType.LT,
  TokenType.GT,
  TokenType.LTE,
  TokenType.GTE,
  TokenType.AND,
  TokenType.OR,
  TokenType.NULLISH_COALESCE,
  TokenType.QUESTION,
  TokenType.DOT,
  TokenType.OPTIONAL_CHAIN,
  TokenType.IN,
  TokenType.INSTANCEOF,
  ...ASSIGNMENT_OPERATORS.keys(),
]);

/**
 * Operators that need a value on their right, and the closers that can
 * stand where that value should be: `{a + }`, `fn(x, !)`, `{ok ? "yes" : }`.
 * The stand-in `undefined` made each of these a complete expression with
 * nothing said, so `{total + }` rendered "NaN" or "5undefined".
 */
const NEEDS_RIGHT_OPERAND: ReadonlySet<TokenType> = new Set([
  TokenType.PLUS,
  TokenType.MINUS,
  TokenType.ASTERISK,
  TokenType.SLASH,
  TokenType.PERCENT,
  TokenType.EXPONENT,
  TokenType.EQ,
  TokenType.NOT_EQ,
  TokenType.EQ_STRICT,
  TokenType.NOT_EQ_STRICT,
  TokenType.LT,
  TokenType.GT,
  TokenType.LTE,
  TokenType.GTE,
  TokenType.AND,
  TokenType.OR,
  TokenType.NULLISH_COALESCE,
  TokenType.IN,
  TokenType.INSTANCEOF,
  TokenType.BANG,
  TokenType.TYPEOF,
  TokenType.VOID,
  TokenType.QUESTION,
  TokenType.COLON,
  TokenType.ARROW,
  TokenType.SPREAD,
  ...ASSIGNMENT_OPERATORS.keys(),
]);

const CLOSES_EXPRESSION: ReadonlySet<TokenType> = new Set([
  TokenType.EXPR_END,
  TokenType.RPAREN,
  TokenType.RBRACKET,
  TokenType.COMMA,
  TokenType.COLON,
  TokenType.TEMPLATE_EXPR_END,
]);

/** A short name for what an expression is, for a diagnostic about it. */
/** What `{ name = value }` is told when it is a record being made and not a pattern. */
/**
 * Statements markup does not read in the body of an arrow: a block of them
 * is reported and not run (see parseArrowBody). Each is a word that cannot
 * begin an expression.
 */
const NOT_READ_STATEMENTS: ReadonlySet<string> = new Set([
  'if', 'let', 'const', 'var', 'for', 'while', 'do', 'switch', 'try', 'throw',
  'function', 'class', 'async', 'await', 'break', 'continue',
]);

const COVER_DEFAULT_MESSAGE =
  'A name with a default (name = value) inside { } is only read where a record is taken apart: ' +
  'as the parameter of an arrow, ({ name = value }) => …. In a record that is being made, write name: value';

/** Whether any part of a pattern has a default written for it. */
function patternHasDefault(pattern: BindingPattern): boolean {
  if (pattern.type === 'NamePattern') return false;
  if (pattern.type === 'ArrayPattern') {
    return (
      pattern.elements.some((element) => element.default !== undefined || patternHasDefault(element.pattern)) ||
      (pattern.rest !== undefined && patternHasDefault(pattern.rest))
    );
  }
  return pattern.properties.some(
    ({ value }) => value.default !== undefined || patternHasDefault(value.pattern)
  );
}

/**
 * Give every node under `node` the place `loc`: for an expression read from
 * text that is not the page's, whose places are in that text.
 */
function relocate(node: unknown, loc: SourceLocation): void {
  if (Array.isArray(node)) {
    for (const item of node) relocate(item, loc);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc') (node as { loc: SourceLocation }).loc = { ...loc };
    else relocate(value, loc);
  }
}

/**
 * A page's `<style>` blocks as one stylesheet: the rules of each, in the
 * order the blocks are written, at the place the first one stands.
 */
function joinStyleBlocks(first: StyleBlock, next: StyleBlock): StyleBlock {
  const content = [first.content, next.content].filter((rules) => rules !== '').join('\n');
  return { type: 'StyleBlock', content, loc: first.loc };
}

function describeExpression(expr: Expression): string {
  switch (expr.type) {
    case 'Literal':
      return `the literal ${expr.raw}`;
    case 'CallExpression':
      return 'a call';
    case 'BinaryExpression':
      return `a "${expr.operator}" expression`;
    case 'UnaryExpression':
      return `a "${expr.operator}" expression`;
    case 'ConditionalExpression':
      return 'a conditional';
    case 'UpdateExpression':
      return `a "${expr.operator}" expression`;
    case 'NewExpression':
      return 'a "new" expression';
    case 'ArrowFunctionExpression':
      return 'an arrow function';
    case 'ObjectExpression':
      return 'an object literal';
    case 'ArrayExpression':
      return 'an array literal';
    case 'TemplateLiteral':
      return 'a template literal';
    default:
      return `a ${expr.type}`;
  }
}

export class Parser {
  private lexer: Lexer;
  private source: string;
  private curToken: Token;
  private peekToken: Token;
  /** The token before `curToken`: what a missing value would have followed. */
  private prevToken: Token;
  /** Accumulated diagnostics during fault-tolerant parsing */
  private diagnostics: ParseDiagnostic[] = [];
  /**
   * A missing-value diagnostic for the expression being read, held until the
   * expression closes (see parsePrimary and closeExpression).
   */
  private pendingOperand: ParseDiagnostic | null = null;
  /**
   * The `<script>`, `<logic>` and `<style>` blocks written inside an element,
   * waiting to be placed on the document as if written at its top. An HTML
   * page puts its `<style>` and `<script>` wherever it likes, often at the
   * end of `<body>`; read as elements, their content was dropped unsaid.
   */
  private nestedBlocks: Array<ScriptBlock | LogicBlock | StyleBlock> = [];
  /** The elements being read, outermost first: what an end tag an HTML element leaves out may end. */
  private openTags: string[] = [];
  /**
   * HTML's list of active formatting elements: each `<b>`, `<i>`, `<a>`…
   * opened and not yet ended by its own end tag, oldest first, with a marker
   * where a cell, a caption or the like begins. One that something else
   * ended (an `<em>` inside a `</ul>`, an `<i>` inside a `</b>`) is opened
   * again, with its attributes, before the next text or inline element, as a
   * browser does (reconstructFormatting): `<b><i>x</b>y</i>` is
   * `<b><i>x</i></b><i>y</i>`.
   */
  private activeFormatting: Array<ElementNode | 'marker'> = [];
  /** The elements being read, as openTags names them, where there is an element. */
  private openElements: Array<ElementNode | undefined> = [];
  /** The same elements, to ask whether one is open in one step. */
  private openSet = new Set<ElementNode>();
  /** Each formatting element's attributes as Noah's Ark compares them, worked out once (attributesKey). */
  private attributeKeys = new WeakMap<ElementNode, string>();
  /**
   * What an element does when `next`, the element open inside it on the way
   * to the block a formatting element's end tag was read in, returns (see
   * adoptBlock and takeAdoption). What `next` moved out of itself, or `next`
   * itself where it moved nothing, is what moves on: the formatting element
   * and an inline element move it after them and end (`hoist`); a block
   * wraps what it held before it in a copy of the formatting element
   * (`split`); a formatting element on the way moves it into a copy of
   * itself, after it, and reads on into the copy (`wrap`).
   */
  private adoptions = new Map<ElementNode, { next: ElementNode; kind: 'hoist' | 'split' | 'wrap'; formatting: ElementNode }>();
  /** The blocks moved out of the formatting element just read, to stand after it (see adoptBlock). */
  private adoptedAfter: TemplateNode[] = [];
  /** The formatting elements still to open inside the one being opened again (reopenElements). */
  private reopenInside: ElementNode[] = [];
  /** Whether the page has been said to nest too deep (MAX_TREE_DEPTH). */
  private reportedTooDeep = false;
  /** What the table just read moved out of itself, to stand before it (see parseElement). */
  private fostered: TemplateNode[] = [];
  /** Whether the top-level elements being read are inside a document's `<head>`. */
  private inHead: boolean = false;
  /** The text of a document's `<title>`. */
  private title: string | undefined;

  constructor(source: string) {
    this.source = source;
    this.lexer = new Lexer(source);
    this.curToken = this.pullToken();
    this.prevToken = this.curToken;
    this.peekToken = this.pullToken();
  }

  /**
   * Record a parse diagnostic and continue parsing
   */
  private addDiagnostic(error: unknown): void {
    // Whatever is being reported ended the expression a held diagnostic
    // belonged to, and says more about it.
    this.pendingOperand = null;
    if (error instanceof SoftNParseError) {
      this.diagnostics.push({
        message: error.message,
        severity: 'error',
        loc: error.loc,
      });
    } else {
      this.diagnostics.push({
        message: error instanceof Error ? error.message : String(error),
        severity: 'error',
        loc: this.currentLoc(),
      });
    }
  }

  /**
   * Skip tokens until we find a likely recovery point (next top-level element or EOF)
   */
  private skipToRecoveryPoint(): void {
    let lastPos = this.curToken.start;
    while (!this.curTokenIs(TokenType.EOF)) {
      // Stop at likely new element start points
      if (this.curTokenIs(TokenType.TAG_OPEN) || this.curTokenIs(TokenType.HASH)) {
        break;
      }
      // Stop at closing tags (let the parent handle it)
      if (this.curTokenIs(TokenType.TAG_END_OPEN)) {
        break;
      }
      this.nextToken();
      // Guard against stuck tokens — break if position didn't advance
      if (this.curToken.start <= lastPos) break;
      lastPos = this.curToken.start;
    }
  }

  /**
   * Skip tokens until we find a likely child recovery point or closing tag
   */
  private skipToChildRecoveryPoint(_parentTag: string): void {
    let lastPos = this.curToken.start;
    while (!this.curTokenIs(TokenType.EOF)) {
      if (this.curTokenIs(TokenType.TAG_OPEN) || this.curTokenIs(TokenType.HASH) ||
          this.curTokenIs(TokenType.EXPR_START) || this.curTokenIs(TokenType.TEXT)) {
        break;
      }
      if (this.curTokenIs(TokenType.TAG_END_OPEN)) {
        break;
      }
      this.nextToken();
      // Guard against stuck tokens
      if (this.curToken.start <= lastPos) break;
      lastPos = this.curToken.start;
    }
  }

  /**
   * Parse the source into a SoftN document
   */
  public parse(): SoftNDocument {
    const doc = createDocument({
      loc: { line: 1, column: 1, start: 0, end: this.source.length },
    });

    // A space on one line between two things is content between two template
    // nodes and nothing beside a declaration (`<logic src="…" /> <App>`), so
    // one is held until what follows it is known.
    let heldSpace: SourceLocation | null = null;
    let afterTemplateNode = false;
    const pushTemplate = (node: TemplateNode): void => {
      if (heldSpace && afterTemplateNode) doc.template.push(createTextNode(' ', heldSpace));
      heldSpace = null;
      afterTemplateNode = true;
      doc.template.push(node);
    };

    const place = (element: TopLevelElement): void => {
      if (isImportDeclaration(element)) {
        doc.imports.push(element);
      } else if (isComponentDeclaration(element)) {
        doc.component = element;
      } else if (isScriptBlock(element)) {
        // An HTML page writes several, in its head and at the end of its
        // body, and means all of them, in order; the last used to replace
        // the others where a page was parsed without the composer.
        doc.script = doc.script
          ? { type: 'ScriptBlock', code: [doc.script.code, element.code].filter((code) => code !== '').join('\n'), loc: doc.script.loc }
          : element;
      } else if (isLogicBlock(element)) {
        doc.logic = element;
      } else if (isDataBlock(element)) {
        // A page that writes either block more than once means all of
        // them. The last used to replace the others, and nothing said
        // that the first block's rules or collections were gone.
        doc.data = doc.data ? this.joinDataBlocks(doc.data, element) : element;
      } else if (isStyleBlock(element)) {
        doc.style = doc.style ? joinStyleBlocks(doc.style, element) : element;
      } else if (isTemplateNode(element)) {
        pushTemplate(element);
      }
    };

    while (!this.curTokenIs(TokenType.EOF)) {
      this.skipComments();

      if (this.curTokenIs(TokenType.EOF)) break;

      try {
        if (this.curTokenIs(TokenType.TAG_OPEN)) this.endsLikeFormatting(this.tagNameAhead(), undefined, '', []);
        // Formatting elements something else ended, opened again around what follows.
        const before = this.curToken.start;
        for (const reopened of this.reconstructFormatting()) pushTemplate(reopened);
        if (this.curToken.start !== before) {
          // What followed was read into them: read on from there.
        } else if (this.curTokenIs(TokenType.TAG_OPEN)) {
          const element = this.parseTopLevelElement();
          if (element && !isTemplateNode(element)) {
            heldSpace = null;
            afterTemplateNode = false;
          }
          // What a table moved out of itself stands before it.
          for (const moved of this.fostered.splice(0)) pushTemplate(moved);
          if (element) place(element);
          for (const moved of this.adoptedAfter.splice(0)) pushTemplate(moved);
          // Blocks written inside it come after it, in the order written.
          for (const block of this.nestedBlocks.splice(0)) place(block);
        } else if (this.curTokenIs(TokenType.TAG_END_OPEN)) {
          // A closing tag with nothing open: the `</head>`, `</body>` and
          // `</html>` of a page written as a whole document, or a stray one,
          // which was always passed over; but a `</p>`, which is an empty
          // paragraph, as in HTML.
          const at = this.currentLoc();
          this.nextToken();
          const closing = normalizeTagName(this.readTagName());
          if (closing === 'head') this.inHead = false;
          if (FORMATTING_ELEMENTS.has(closing)) this.deactivateClosed(closing);
          if (closing === 'p' || closing === 'br') pushTemplate(createElementNode(closing, at, { selfClosing: closing === 'br' }));
          while (!this.curTokenIs(TokenType.TAG_CLOSE) && !this.curTokenIs(TokenType.EOF)) {
            this.nextToken();
          }
          if (this.curTokenIs(TokenType.TAG_CLOSE)) this.nextToken();
        } else if (this.curTokenIs(TokenType.HASH)) {
          // Control flow at top level
          const controlFlow = this.parseControlFlow();
          if (controlFlow) {
            pushTemplate(controlFlow);
          }
        } else if (this.curTokenIs(TokenType.TEXT)) {
          if (this.curToken.literal.trim() === '') {
            heldSpace = this.currentLoc();
          } else {
            // Words after a declaration begin the template: the space they
            // were given for following a tag is not theirs.
            const literal = afterTemplateNode ? this.curToken.literal : this.curToken.literal.replace(/^\s+/, '');
            pushTemplate(createTextNode(literal, this.currentLoc()));
          }
          this.nextToken();
        } else if (this.curTokenIs(TokenType.EXPR_START)) {
          pushTemplate(this.parseExpressionNode());
        } else {
          this.nextToken();
        }
      } catch (error) {
        // Record the error and skip to the next recoverable point
        this.addDiagnostic(error);
        this.skipToRecoveryPoint();
      }
    }

    for (const block of this.nestedBlocks.splice(0)) place(block);
    if (this.title !== undefined) doc.title = this.title;

    // Attach diagnostics if any were collected
    if (this.diagnostics.length > 0) {
      doc.diagnostics = this.diagnostics;
    }

    return doc;
  }

  /**
   * Parse a top-level element (import, component, script, data, style, or regular element)
   */
  private parseTopLevelElement(): TopLevelElement | null {
    this.expectToken(TokenType.TAG_OPEN);

    // A page written as a whole HTML document.
    const name = this.isPropertyName() ? normalizeTagName(this.curToken.literal) : '';
    const wrapper = documentWrapper(name);
    if (wrapper) {
      return this.parseDocumentWrapper(wrapper);
    }
    // At the top of a page, `<title>`, `<meta>` and `<link>` are the head's
    // wherever they stand, as a browser reads them.
    if (HEAD_ELEMENTS.has(name) && (this.inHead || name !== 'noscript')) {
      this.readHeadElement();
      return null;
    }

    // Check for special elements
    if (this.curTokenIs(TokenType.IMPORT)) {
      return this.parseImport();
    }
    if (this.curTokenIs(TokenType.COMPONENT)) {
      return this.parseComponentDeclaration();
    }
    if (this.curTokenIs(TokenType.DATA)) {
      return this.parseDataBlock();
    }
    const block = this.blockAhead();
    if (block) {
      return this.parseBlock(block);
    }

    // Regular element
    return this.parseElement();
  }

  /**
   * Which block the tag being read opens: `<script>`, `<logic>` or `<style>`,
   * in any case, as the lexer reads them. The lexer has always taken
   * `<Logic>` and `<Style>` for blocks and read their content as one; this
   * took only the lower-case spelling, so the content of the others was
   * dropped and the page drew "Unknown component" in its place.
   */
  private blockAhead(): 'script' | 'logic' | 'style' | null {
    if (this.curTokenIs(TokenType.SCRIPT)) return 'script';
    if (this.curTokenIs(TokenType.LOGIC)) return 'logic';
    if (this.curTokenIs(TokenType.STYLE)) return 'style';
    if (this.curTokenIs(TokenType.IDENTIFIER)) {
      const word = this.curToken.literal.toLowerCase();
      if (word === 'script' || word === 'logic' || word === 'style') return word;
    }
    return null;
  }

  private parseBlock(block: 'script' | 'logic' | 'style'): ScriptBlock | LogicBlock | StyleBlock | null {
    if (block === 'script') return this.parseScriptBlock();
    if (block === 'logic') return this.parseLogicBlock();
    return this.parseStyleBlock();
  }

  /**
   * `<html>`, `<head>` or `<body>`, opening a page written as a whole HTML
   * document. What is inside is read as the page itself, so its `<style>`
   * and `<script>` are the page's and its elements are drawn. A `<body>`
   * with attributes keeps them, on a `<div>` around the page; one without is
   * passed over like the others. Their closing tags are passed over in
   * `parse()`.
   */
  private parseDocumentWrapper(wrapper: DocumentWrapper): ElementNode | null {
    if (wrapper === 'body' && this.peekToken.type !== TokenType.TAG_CLOSE) {
      const element = this.parseElement() as ElementNode;
      element.tag = 'div';
      return element;
    }
    while (
      !this.curTokenIs(TokenType.TAG_CLOSE) &&
      !this.curTokenIs(TokenType.TAG_SELF_CLOSE) &&
      !this.curTokenIs(TokenType.EOF)
    ) {
      this.nextToken();
    }
    this.nextToken(); // consume > or />
    this.inHead = wrapper === 'head';
    return null;
  }

  /**
   * An element of a document's `<head>`. The `<title>` names the page, and
   * a host may show it; the rest (`<meta>`, `<link>`, `<base>`) describe the
   * page to a browser that is not the one drawing it here, so none is drawn.
   * A stylesheet a `<link>` names is the bundle composer's to place.
   */
  private readHeadElement(): void {
    const element = this.parseElement();
    if (element.type !== 'Element') return;
    if (element.tag === 'title') {
      this.title = element.children
        .map((child) => (child.type === 'Text' ? child.content : ''))
        .join('')
        .trim();
    } else if (element.tag === 'link') {
      const rel = (this.staticPropValue(element, 'rel') ?? '').toLowerCase().split(/\s+/);
      const href = this.staticPropValue(element, 'href') ?? '';
      if (rel.includes('stylesheet') && isRemoteReference(href)) {
        this.diagnostics.push({
          message:
            `<link rel="stylesheet" href="${href}"> is not loaded: an app's styles come from the app's own files. ` +
            'Put the rules the page needs in a .css file of the app, or in a <style> block',
          severity: 'warning',
          loc: element.loc,
        });
      }
    }
  }

  /**
   * Parse an import declaration
   */
  private parseImport(): ImportDeclaration {
    const loc = this.currentLoc();
    this.nextToken(); // consume 'import'

    let defaultImport: string | undefined;
    let namedImports: string[] | undefined;

    // Check for named imports: { A, B }
    if (this.curTokenIs(TokenType.EXPR_START)) {
      this.nextToken();
      namedImports = [];
      while (!this.curTokenIs(TokenType.EXPR_END) && !this.curTokenIs(TokenType.EOF)) {
        const memberStart = this.curToken.start;
        if (this.curTokenIs(TokenType.IDENTIFIER)) {
          const imported = this.curToken.literal;
          this.nextToken();
          // `{ Card as C }` names one import, not three. Without this the list
          // came back as ["Card", "as", "C"] — with an import literally called
          // "as" — and nothing said so.
          if (this.curTokenIs(TokenType.IDENTIFIER) && this.curToken.literal.toLowerCase() === 'as') {
            this.nextToken();
            if (this.curTokenIs(TokenType.IDENTIFIER)) {
              namedImports.push(this.curToken.literal);
              this.nextToken();
            } else {
              throw new UnexpectedTokenError(this.curToken, TokenType.IDENTIFIER, this.source);
            }
          } else {
            namedImports.push(imported);
          }
        }
        if (this.curTokenIs(TokenType.COMMA)) {
          this.nextToken();
        }
        // A typo in a braced import list would otherwise wedge the parser.
        this.expectProgress(memberStart, TokenType.EXPR_END);
      }
      this.expectToken(TokenType.EXPR_END);
    } else if (this.curTokenIs(TokenType.IDENTIFIER)) {
      defaultImport = this.curToken.literal;
      this.nextToken();
    }

    // Expect 'from', in any case (`<IMPORT Header FROM="…">`).
    if (this.curTokenIs(TokenType.IDENTIFIER) && this.curToken.literal.toLowerCase() === 'from') this.nextToken();
    else this.expectToken(TokenType.FROM);

    // `from="./Header.ui"` is how an import is written; the `=` was not
    // stepped over, so the path that follows it was never read and every
    // import's source was the empty string.
    if (this.curTokenIs(TokenType.EQUALS)) this.nextToken();

    // Get source path
    let source = '';
    if (this.curTokenIs(TokenType.STRING)) {
      source = this.curToken.literal;
      this.nextToken();
    }

    // Skip to end of tag
    while (
      !this.curTokenIs(TokenType.TAG_SELF_CLOSE) &&
      !this.curTokenIs(TokenType.TAG_CLOSE) &&
      !this.curTokenIs(TokenType.EOF)
    ) {
      this.nextToken();
    }
    this.nextToken(); // consume /> or >

    return {
      type: 'ImportDeclaration',
      defaultImport,
      namedImports,
      source,
      loc,
    };
  }

  /**
   * Parse a component declaration block
   */
  private parseComponentDeclaration(): ComponentDeclaration {
    const loc = this.currentLoc();
    this.nextToken(); // consume 'component'

    let name = '';
    const props: PropDeclaration[] = [];

    // Parse attributes
    while (
      !this.curTokenIs(TokenType.TAG_CLOSE) &&
      !this.curTokenIs(TokenType.TAG_SELF_CLOSE) &&
      !this.curTokenIs(TokenType.EOF)
    ) {
      if (this.curTokenIs(TokenType.IDENTIFIER) && this.curToken.literal.toLowerCase() === 'name') {
        this.nextToken(); // consume 'name'
        this.expectToken(TokenType.EQUALS);
        if (this.curTokenIs(TokenType.STRING)) {
          name = this.curToken.literal;
          this.nextToken();
        }
      } else {
        this.nextToken();
      }
    }

    const selfClosing = this.curTokenIs(TokenType.TAG_SELF_CLOSE);
    this.nextToken(); // consume > or />

    // If not self-closing, parse children (prop declarations)
    if (!selfClosing) {
      while (!this.curTokenIs(TokenType.TAG_END_OPEN) && !this.curTokenIs(TokenType.EOF)) {
        this.skipComments();

        if (this.curTokenIs(TokenType.TAG_OPEN)) {
          this.nextToken(); // consume <

          if (this.curTokenIs(TokenType.PROP)) {
            props.push(this.parsePropDeclaration());
          } else {
            // Skip other elements
            while (
              !this.curTokenIs(TokenType.TAG_CLOSE) &&
              !this.curTokenIs(TokenType.TAG_SELF_CLOSE) &&
              !this.curTokenIs(TokenType.EOF)
            ) {
              this.nextToken();
            }
            this.nextToken();
          }
        } else {
          this.nextToken();
        }
      }

      // Consume closing tag
      if (this.curTokenIs(TokenType.TAG_END_OPEN)) {
        while (!this.curTokenIs(TokenType.TAG_CLOSE) && !this.curTokenIs(TokenType.EOF)) {
          this.nextToken();
        }
        this.nextToken();
      }
    }

    return {
      type: 'ComponentDeclaration',
      name,
      props,
      slots: [],
      loc,
    };
  }

  /**
   * Parse a prop declaration
   */
  private parsePropDeclaration(): PropDeclaration {
    const loc = this.currentLoc();
    this.nextToken(); // consume 'prop'

    let name = '';
    let propType: string | undefined;
    let required = false;

    // Parse attributes
    while (
      !this.curTokenIs(TokenType.TAG_CLOSE) &&
      !this.curTokenIs(TokenType.TAG_SELF_CLOSE) &&
      !this.curTokenIs(TokenType.EOF)
    ) {
      if (this.curTokenIs(TokenType.IDENTIFIER)) {
        const attrName = this.curToken.literal.toLowerCase();
        this.nextToken();

        if (attrName === 'required') {
          required = true;
        } else if (this.curTokenIs(TokenType.EQUALS)) {
          this.nextToken();
          if (this.curTokenIs(TokenType.STRING)) {
            if (attrName === 'name') {
              name = this.curToken.literal;
            } else if (attrName === 'type') {
              propType = this.curToken.literal;
            }
            this.nextToken();
          }
        }
      } else {
        this.nextToken();
      }
    }

    this.nextToken(); // consume /> or >

    return {
      type: 'PropDeclaration',
      name,
      propType,
      required,
      loc,
    };
  }

  /**
   * Parse a script block: the page's code, written in it.
   *
   * Its attributes are read for what they say about that code. A `src`
   * names a file, which the bundle composer places as it places
   * `<logic src>`; read on its own, a page has no files to read it from, so
   * the tag is no block here (an empty one would have taken the place of the
   * page's `<logic>`). A `type` that is not JavaScript is data or a template,
   * such as `application/ld+json`, and is not run.
   */
  private parseScriptBlock(): ScriptBlock | null {
    const loc = this.currentLoc();

    // Consume 'script' keyword
    this.nextToken();

    const attributes: Record<string, string> = {};
    while (
      !this.curTokenIs(TokenType.TAG_CLOSE) &&
      !this.curTokenIs(TokenType.TAG_SELF_CLOSE) &&
      !this.curTokenIs(TokenType.SCRIPT_CONTENT) &&
      !this.curTokenIs(TokenType.EOF)
    ) {
      if (this.isPropertyName() && this.peekToken.type === TokenType.EQUALS) {
        const name = this.curToken.literal.toLowerCase();
        this.nextToken(); // name
        this.nextToken(); // =
        if (this.curTokenIs(TokenType.STRING) || this.curTokenIs(TokenType.IDENTIFIER)) {
          attributes[name] = decodeHtmlEntities(this.curToken.literal, true);
        } else {
          continue;
        }
      }
      this.nextToken();
    }

    let code = '';
    if (this.curTokenIs(TokenType.TAG_SELF_CLOSE)) {
      // `<script src="main.js" />`, as XHTML writes it.
      this.nextToken();
    } else {
      // Consume TAG_CLOSE if present
      if (this.curTokenIs(TokenType.TAG_CLOSE)) {
        this.nextToken();
      }

      // Now we should be at SCRIPT_CONTENT
      if (this.curTokenIs(TokenType.SCRIPT_CONTENT)) {
        code = this.curToken.literal;
        this.nextToken();
      } else {
        // Fallback: skip to end
        while (!this.curTokenIs(TokenType.TAG_END_OPEN) && !this.curTokenIs(TokenType.EOF)) {
          this.nextToken();
        }
      }

      // Consume closing tag </script>
      if (this.curTokenIs(TokenType.TAG_END_OPEN)) {
        while (!this.curTokenIs(TokenType.TAG_CLOSE) && !this.curTokenIs(TokenType.EOF)) {
          this.nextToken();
        }
        if (this.curTokenIs(TokenType.TAG_CLOSE)) {
          this.nextToken();
        }
      }
    }

    const src = attributes.src?.trim();
    if (src) {
      if (isRemoteReference(src)) {
        this.diagnostics.push({
          message:
            `<script src="${src}"> is not loaded: an app's code runs in its own sandbox, from the app's own files, ` +
            'so a script from another site cannot run beside it. Put the code the page needs in a file of the app',
          severity: 'warning',
          loc,
        });
      }
      return null;
    }
    const language = scriptLanguage(attributes.type);
    if (language === 'other') return null;
    if (language === 'python') {
      this.diagnostics.push({
        message:
          'Python is not written inside a page, where its indentation is not safe: put it in a .py file and refer to it with <script src="main.py">',
        severity: 'error',
        loc,
      });
      return null;
    }
    return { type: 'ScriptBlock', code, loc };
  }

  /**
   * Parse a logic block
   */
  private parseLogicBlock(): LogicBlock {
    const loc = this.currentLoc();

    // Consume 'logic' keyword
    this.nextToken();

    // Skip any attributes until TAG_CLOSE, TAG_SELF_CLOSE, or LOGIC_CONTENT
    while (
      !this.curTokenIs(TokenType.TAG_CLOSE) &&
      !this.curTokenIs(TokenType.TAG_SELF_CLOSE) &&
      !this.curTokenIs(TokenType.LOGIC_CONTENT) &&
      !this.curTokenIs(TokenType.EOF)
    ) {
      this.nextToken();
    }

    // Handle self-closing <logic src="..." /> tags (external logic file reference)
    if (this.curTokenIs(TokenType.TAG_SELF_CLOSE)) {
      this.nextToken();
      // Return empty LogicBlock - the src attribute should be handled elsewhere
      return { type: 'LogicBlock', code: '', loc };
    }

    // Consume TAG_CLOSE if present
    if (this.curTokenIs(TokenType.TAG_CLOSE)) {
      this.nextToken();
    }

    // Now we should be at LOGIC_CONTENT
    if (this.curTokenIs(TokenType.LOGIC_CONTENT)) {
      const content = this.curToken.literal;
      this.nextToken();

      // Consume closing tag </logic>
      if (this.curTokenIs(TokenType.TAG_END_OPEN)) {
        while (!this.curTokenIs(TokenType.TAG_CLOSE) && !this.curTokenIs(TokenType.EOF)) {
          this.nextToken();
        }
        if (this.curTokenIs(TokenType.TAG_CLOSE)) {
          this.nextToken();
        }
      }

      return { type: 'LogicBlock', code: content, loc };
    }

    // Fallback: skip to end
    while (!this.curTokenIs(TokenType.TAG_END_OPEN) && !this.curTokenIs(TokenType.EOF)) {
      this.nextToken();
    }

    return { type: 'LogicBlock', code: '', loc };
  }

  /**
   * Parse a data block
   */
  private parseDataBlock(): DataBlock {
    const loc = this.currentLoc();
    this.nextToken(); // consume 'data'

    const collections: CollectionDeclaration[] = [];

    // Skip to >
    while (!this.curTokenIs(TokenType.TAG_CLOSE) && !this.curTokenIs(TokenType.EOF)) {
      this.nextToken();
    }
    this.nextToken();

    // Parse collection declarations
    while (!this.curTokenIs(TokenType.TAG_END_OPEN) && !this.curTokenIs(TokenType.EOF)) {
      this.skipComments();

      if (this.curTokenIs(TokenType.TAG_OPEN)) {
        this.nextToken();

        if (this.curTokenIs(TokenType.COLLECTION)) {
          collections.push(this.parseCollectionDeclaration());
        } else {
          while (
            !this.curTokenIs(TokenType.TAG_CLOSE) &&
            !this.curTokenIs(TokenType.TAG_SELF_CLOSE) &&
            !this.curTokenIs(TokenType.EOF)
          ) {
            this.nextToken();
          }
          this.nextToken();
        }
      } else {
        this.nextToken();
      }
    }

    // Consume closing tag
    if (this.curTokenIs(TokenType.TAG_END_OPEN)) {
      while (!this.curTokenIs(TokenType.TAG_CLOSE) && !this.curTokenIs(TokenType.EOF)) {
        this.nextToken();
      }
      this.nextToken();
    }

    return { type: 'DataBlock', collections, loc };
  }

  /**
   * The declarations of a page's `<data>` blocks as one set, in the order
   * written.
   *
   * A name is read as one collection, so the first block to give a name a
   * collection keeps it: a later block that declares the same collection by
   * the same name adds nothing, and one that gives the name to another
   * collection is left out and said. (The composer does the same for the
   * blocks of imported pages.) Inside one block nothing is taken out.
   */
  private joinDataBlocks(first: DataBlock, next: DataBlock): DataBlock {
    const holders = new Map<string, string>();
    for (const declared of first.collections) holders.set(declared.as, declared.name);

    const collections = [...first.collections];
    for (const declaration of next.collections) {
      const holder = holders.get(declaration.as);
      if (holder === undefined) {
        holders.set(declaration.as, declaration.name);
        collections.push(declaration);
      } else if (holder !== declaration.name) {
        this.diagnostics.push({
          message:
            `<collection name="${declaration.name}" as="${declaration.as}"> is not declared, ` +
            `because this page already reads "${holder}" as ${declaration.as}.`,
          severity: 'warning',
          loc: declaration.loc,
        });
      }
    }
    return { type: 'DataBlock', collections, loc: first.loc };
  }

  /**
   * Parse a collection declaration
   * Supports: name, as, filter, sort, limit attributes
   */
  private parseCollectionDeclaration(): CollectionDeclaration {
    const loc = this.currentLoc();
    this.nextToken(); // consume 'collection'

    let name = '';
    let as = '';
    let filter: Expression | undefined;
    let sort: string | undefined;
    let limit: number | undefined;

    while (
      !this.curTokenIs(TokenType.TAG_CLOSE) &&
      !this.curTokenIs(TokenType.TAG_SELF_CLOSE) &&
      !this.curTokenIs(TokenType.EOF)
    ) {
      if (this.curTokenIs(TokenType.IDENTIFIER)) {
        const attrName = this.curToken.literal.toLowerCase();
        this.nextToken();

        if (this.curTokenIs(TokenType.EQUALS)) {
          this.nextToken();

          if (attrName === 'name' && this.curTokenIs(TokenType.STRING)) {
            name = this.curToken.literal;
            this.nextToken();
          } else if (attrName === 'as' && this.curTokenIs(TokenType.STRING)) {
            as = this.curToken.literal;
            this.nextToken();
          } else if (attrName === 'sort' && this.curTokenIs(TokenType.STRING)) {
            // sort="createdAt:desc"
            sort = this.curToken.literal;
            this.nextToken();
          } else if (attrName === 'filter' && this.curTokenIs(TokenType.EXPR_START)) {
            // filter={{ completed: false }}
            this.nextToken();
            filter = this.parseExpression();
            this.closeExpression();
          } else if (attrName === 'limit') {
            // limit={10} or limit=10
            if (this.curTokenIs(TokenType.EXPR_START)) {
              this.nextToken();
              if (this.curTokenIs(TokenType.NUMBER)) {
                limit = parseInt(this.curToken.literal, 10);
                this.nextToken();
              }
              if (this.curTokenIs(TokenType.EXPR_END)) {
                this.nextToken();
              }
            } else if (this.curTokenIs(TokenType.NUMBER)) {
              limit = parseInt(this.curToken.literal, 10);
              this.nextToken();
            }
          } else if (this.curTokenIs(TokenType.STRING)) {
            // Skip unknown string attributes
            this.nextToken();
          }
        }
      } else {
        this.nextToken();
      }
    }

    this.nextToken(); // consume />

    // Validate collection name is required
    if (!name) {
      throw new InvalidCollectionError(
        'Collection declaration requires a "name" attribute',
        loc,
        this.source
      );
    }

    // Validate collection name format (alphanumeric, underscore, hyphen, starting with letter)
    const validNamePattern = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
    if (!validNamePattern.test(name)) {
      throw new InvalidCollectionError(
        `Invalid collection name "${name}". Names must start with a letter and contain only letters, numbers, underscores, or hyphens.`,
        loc,
        this.source
      );
    }

    // Default 'as' to 'name' if not provided
    if (!as) {
      as = name;
    }

    // Validate 'as' is a valid JavaScript identifier
    const validIdentifierPattern = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
    if (!validIdentifierPattern.test(as)) {
      throw new InvalidCollectionError(
        `Invalid "as" binding "${as}". It must be a valid JavaScript identifier.`,
        loc,
        this.source
      );
    }

    return { type: 'CollectionDeclaration', name, as, filter, sort, limit, loc };
  }

  /**
   * Parse a style block
   */
  private parseStyleBlock(): StyleBlock {
    const loc = this.currentLoc();

    // Consume 'style' keyword
    this.nextToken();

    // Skip any attributes until TAG_CLOSE or STYLE_CONTENT
    while (
      !this.curTokenIs(TokenType.TAG_CLOSE) &&
      !this.curTokenIs(TokenType.TAG_SELF_CLOSE) &&
      !this.curTokenIs(TokenType.STYLE_CONTENT) &&
      !this.curTokenIs(TokenType.EOF)
    ) {
      this.nextToken();
    }

    // `<style />` has no rules, and nothing after it is its content.
    if (this.curTokenIs(TokenType.TAG_SELF_CLOSE)) {
      this.nextToken();
      return { type: 'StyleBlock', content: '', loc };
    }

    // Consume TAG_CLOSE if present
    if (this.curTokenIs(TokenType.TAG_CLOSE)) {
      this.nextToken();
    }

    // Now we should be at STYLE_CONTENT
    if (this.curTokenIs(TokenType.STYLE_CONTENT)) {
      const content = this.curToken.literal;
      this.nextToken();

      // Consume closing tag </style>
      if (this.curTokenIs(TokenType.TAG_END_OPEN)) {
        while (!this.curTokenIs(TokenType.TAG_CLOSE) && !this.curTokenIs(TokenType.EOF)) {
          this.nextToken();
        }
        if (this.curTokenIs(TokenType.TAG_CLOSE)) {
          this.nextToken();
        }
      }

      return { type: 'StyleBlock', content, loc };
    }

    return { type: 'StyleBlock', content: '', loc };
  }

  /**
   * Parse an element
   * Supports inline conditionals (if=) and loops (each=/as=)
   */
  private parseElement(): ElementNode | SlotNode | TemplateSlotNode {
    const loc = this.currentLoc();

    // Get tag name.
    //
    // Keywords included: the lexer types `slot`, `template`, `data`,
    // `component` as keyword tokens, and matching IDENTIFIER alone left such
    // an element with an empty tag and its name still unconsumed as the first
    // "attribute". Its close tag then never matched the empty name, so the
    // element swallowed every sibling after it — `<Card><slot/></Card><Text>`
    // lost the Text — with only a "expected </>" diagnostic to go on.
    // `<DIV>` and `<BR>` are HTML's, in lower case (see normalizeTagName).
    // `<image>` is HTML's old name for `<img>`, and HTML reads it so outside
    // an `<svg>`, where it is SVG's own element.
    const written = normalizeTagName(this.readTagName());
    const tagName = written === 'image' && !this.openTags.includes('svg') ? 'img' : written;

    const element = createElementNode(tagName, loc);

    // Track inline loop attributes for later processing
    let eachIterable: Expression | undefined;
    let asName: string | undefined;
    let indexName: string | undefined;

    // Parse attributes
    while (
      !this.curTokenIs(TokenType.TAG_CLOSE) &&
      !this.curTokenIs(TokenType.TAG_SELF_CLOSE) &&
      !this.curTokenIs(TokenType.EOF)
    ) {
      if (this.curTokenIs(TokenType.AT)) {
        // Event handler
        element.events.push(this.parseEventHandler());
      } else if (this.curTokenIs(TokenType.COLON)) {
        // Binding
        element.bindings.push(this.parseBinding());
      } else if (this.curTokenIs(TokenType.IDENTIFIER) || this.isAttributeKeyword()) {
        // `if=` and `each=` are SoftN's, in any case.
        const attrName = this.curToken.literal.toLowerCase() === 'if' || this.curToken.literal.toLowerCase() === 'each'
          ? this.curToken.literal.toLowerCase()
          : this.curToken.literal;

        // Check for special inline control flow attributes
        if (attrName === 'if') {
          // Inline conditional: if={condition}
          this.nextToken(); // consume 'if'
          if (this.curTokenIs(TokenType.EQUALS)) {
            this.nextToken();
            if (this.curTokenIs(TokenType.EXPR_START)) {
              this.nextToken();
              element.conditionalIf = this.parseExpression();
              this.closeExpression();
            }
          }
        } else if (attrName === 'each') {
          // Inline loop: each={items}
          this.nextToken(); // consume 'each'
          if (this.curTokenIs(TokenType.EQUALS)) {
            this.nextToken();
            if (this.curTokenIs(TokenType.EXPR_START)) {
              this.nextToken();
              eachIterable = this.parseExpression();
              this.closeExpression();
            }
          }
        } else {
          // Regular prop (including keywords like 'data' that can be used as attribute names)
          element.props.push(this.parseProp(element.tag));
        }
      } else if (
        (this.curTokenIs(TokenType.ELSE) || this.curTokenIs(TokenType.ELSEIF)) &&
        this.peekToken.type !== TokenType.EQUALS
      ) {
        // `<p if={a}>…</p><p else>…</p>`: `if=` on a tag is real, so `else`
        // beside it is the natural guess, and it was skipped without a word:
        // the second element was simply always drawn.
        this.diagnostics.push({
          message:
            `"${this.curToken.literal}" is not an attribute: a tag has if={…} and nothing that follows it. ` +
            'Write the two branches as #if (…) … #else … #end',
          severity: 'error',
          loc: this.currentLoc(),
        });
        this.nextToken();
      } else if (this.curTokenIs(TokenType.EXPR_START)) {
        // `<Button {...rest}>`. A brace that is not the value of an attribute
        // was skipped a token at a time, so the name inside it became a
        // boolean attribute: this rendered `<Button rest>` and said nothing.
        this.diagnostics.push({
          message:
            'A "{…}" among the attributes is not the value of one and was not read: ' +
            'spreading with {...name} is not supported on a tag, so write each attribute out',
          severity: 'error',
          loc: this.currentLoc(),
        });
        this.skipBracedRegion();
      } else {
        this.nextToken();
      }
    }

    // Set up inline loop if configured. `as="item"` (or `"item, index"`)
    // names its variable, and only beside `each=`: on any other element it is
    // a prop like the rest, so `<Text as="h2">` keeps Text's own `as`. It was
    // taken for a loop's variable on every element, and that prop never
    // reached the component.
    if (eachIterable) {
      const at = element.props.findIndex((prop) => prop.name === 'as' && prop.value.type === 'static');
      if (at >= 0) {
        const parts = String((element.props[at].value as { value: string }).value).split(',').map((s) => s.trim());
        asName = parts[0];
        if (parts.length > 1) indexName = parts[1];
        element.props.splice(at, 1);
      }
      element.inlineEach = {
        iterable: eachIterable,
        itemName: asName || 'item',
        indexName,
      };
    }

    this.normalizeAttributeNames(element);
    this.takeHandlerAttributes(element);

    // `<br>`, `<img …>` and `<input …>` end where their tag ends, as in HTML.
    element.selfClosing =
      this.curTokenIs(TokenType.TAG_SELF_CLOSE) ||
      (this.curTokenIs(TokenType.TAG_CLOSE) && VOID_ELEMENTS.has(tagName) && !this.inDrawing());
    this.nextToken(); // consume > or />

    // Past MAX_TREE_DEPTH open elements an element holds nothing, and what it
    // would hold is placed beside it, as a browser places it (Chromium's
    // parser stops nesting at 512). Deeper, reading the page ran out of
    // stack, and each level reported it.
    const tooDeep = !element.selfClosing && this.openTags.length >= MAX_TREE_DEPTH - 1;
    if (tooDeep && !this.reportedTooDeep) {
      this.reportedTooDeep = true;
      this.diagnostics.push({
        message: `This page nests more than ${MAX_TREE_DEPTH} elements deep, so what is deeper is placed beside the ${MAX_TREE_DEPTH}th, as a browser places it`,
        severity: 'warning',
        loc,
      });
    }

    // Parse children if not self-closing
    if (!element.selfClosing && !tooDeep) {
      if (FORMATTING_ELEMENTS.has(tagName) && !this.inDrawing()) this.activate(element);
      element.children = this.parseChildren(tagName, loc, element);
      if (tagName === 'table') {
        // What has no place in a table goes before it (see TABLE_CONTENT),
        // where the reader of this element places it.
        const placed = wrapTableRows(element.children);
        element.children = placed.filter((child) => !this.fostersOut(child));
        this.fostered.push(...placed.filter((child) => this.fostersOut(child)));
      }
    }

    // `<slot>` and `<template slot="…">` are the Slot / TemplateSlot nodes the
    // renderer already resolves (renderSlot, extractSlotContent); nothing
    // produced them before because the tags did not parse at all (see the tag
    // name above). Only the plain forms: a slot carrying `if=` / `each=` is
    // left as an element rather than have its condition dropped on the floor.
    if (!element.conditionalIf && !element.inlineEach) {
      if (tagName === 'slot') {
        return {
          type: 'Slot',
          name: this.staticPropValue(element, 'name') ?? 'default',
          fallback: element.children,
          loc,
        };
      }
      if (tagName === 'template') {
        const slotName = this.staticPropValue(element, 'slot');
        if (slotName !== undefined) {
          return { type: 'TemplateSlot', name: slotName, children: element.children, loc };
        }
      }
    }

    return element;
  }

  /**
   * Read a tag name: a word, or words joined by hyphens, as a custom element
   * is named (`<my-card>`). The lexer reads a hyphen as a minus, so the
   * pieces are joined here, where they touch, as an attribute's name is.
   * Read as one word, `<my-card>` was the tag `my` with an attribute `card`,
   * and its closing tag a mismatch.
   */
  private readTagName(): string {
    if (!this.isPropertyName()) return '';
    let name = this.curToken.literal;
    let end = this.curToken.end;
    this.nextToken();
    while (
      this.curTokenIs(TokenType.MINUS) &&
      this.curToken.start === end &&
      this.peekToken.start === this.curToken.end &&
      /^[A-Za-z0-9_$]+$/.test(this.peekToken.literal)
    ) {
      this.nextToken(); // -
      name += `-${this.curToken.literal}`;
      end = this.curToken.end;
      this.nextToken();
    }
    return name;
  }

  /**
   * A child element, or none: a `<script>`, `<logic>` or `<style>` written
   * inside an element is the page's, and is placed on the document (see
   * `nestedBlocks`).
   */
  private parseChildElement(): TemplateNode[] {
    const block = this.blockAhead();
    if (block) {
      const parsed = this.parseBlock(block);
      if (parsed) this.nestedBlocks.push(parsed);
      return [];
    }
    const element = this.parseElement();
    // What a table moved out of itself stands before it; a block a formatting
    // element's end tag was read in stands after it (adoptBlock).
    return [...this.fostered.splice(0), element, ...this.adoptedAfter.splice(0)];
  }

  /**
   * The names an element's attributes, events and bindings are read by, in
   * the case HTML reads them (see htmlAttributeName and callbackName): an HTML
   * element's `CLASS`, `TabIndex` and `ONCLICK` are `class`, `tabindex` and
   * `onclick`, and its `@KeyDown` is `keydown`. An attribute written twice on
   * an HTML element is its first, as in HTML.
   */
  private normalizeAttributeNames(element: ElementNode): void {
    const html = this.htmlElement(element.tag);
    if (html) {
      const seen = new Set<string>();
      element.props = element.props.filter((prop) => {
        prop.name = htmlAttributeName(prop.name);
        if (seen.has(prop.name)) return false;
        seen.add(prop.name);
        return true;
      });
    }
    for (const event of element.events) event.name = callbackName(event.name, html);
    for (const binding of element.bindings) binding.name = callbackName(binding.name, html);
  }

  /**
   * `<button onclick="save()">`: a handler written as HTML writes one, as the
   * attribute named for its event, holding code. It is read as the quoted
   * `@click="save()"` is (see `quotedHandler`). Left as an attribute, it was
   * dropped from the element with nothing said, and the button did nothing.
   * One holding an expression, `onclick={save}` or React's `onClick={save}`,
   * is `@click={save}`: in lower case it reached React as a name React does not
   * know, and the button did nothing either.
   */
  private takeHandlerAttributes(element: ElementNode): void {
    const html = this.htmlElement(element.tag);
    if (!element.props.some((prop) => htmlHandlerEvent(html, prop.name))) return;
    element.props = element.props.filter((prop) => {
      const event = htmlHandlerEvent(html, prop.name);
      if (!event) return true;
      if (prop.value.type === 'expression') {
        element.events.push({ type: 'Event', name: event, handler: prop.value.value, loc: prop.loc });
        return false;
      }
      if (prop.value.type !== 'static') return true;
      const handler = this.quotedHandler(event, [], prop.value.value, prop.loc, prop.name);
      if (handler) element.events.push(handler);
      // Code SoftN does not read (`this.classList.toggle('on')`) stays the
      // attribute it was written as: never on the page (the renderer draws
      // no handler from text), and run as a browser runs it where the page
      // is given its document (document-shell/).
      return !handler;
    });
  }

  /**
   * A handler written as code in quotes, `onclick="count++"` or
   * `@click="save(); close()"`, read as the arrow `(event) => { … }` it means:
   * the code runs when the event fires, with the event as `event`, as in an
   * HTML page. A `return false` at its end is HTML's way to cancel what the
   * event would do, so it is the `.prevent` modifier. Code the page cannot
   * read is a warning, and no handler.
   */
  private quotedHandler(
    name: string,
    modifiers: string[],
    code: string,
    loc: SourceLocation,
    written: string
  ): EventNode | null {
    let body = code.trim();
    const all = [...modifiers];
    const cancels = /(?:^|;)\s*return\s+false\s*;?\s*$/;
    if (cancels.test(body)) {
      body = body.replace(cancels, '').trim();
      if (!all.includes('prevent')) all.push('prevent');
    }
    // A name alone, `@click="save"`, is the function to call, as Vue reads
    // it and as `@click={save}` is; as a statement it would do nothing.
    const reference = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(body);
    const parsed = new Parser(reference ? `{${body}}` : `{(event) => { ${body} }}`).parse();
    const node = parsed.template.length === 1 ? parsed.template[0] : undefined;
    const handler = node?.type === 'Expression' ? node.expression : undefined;
    const readable = reference
      ? handler?.type === 'Identifier' || handler?.type === 'MemberExpression'
      : handler?.type === 'ArrowFunctionExpression' && handler.statements !== undefined;
    if (parsed.diagnostics?.length || !handler || !readable) {
      // An HTML attribute is kept (see takeHandlerAttributes), and runs on a
      // page whose code is written for a browser; `@click="…"` is not.
      const html = !written.startsWith('@');
      this.diagnostics.push({
        message:
          `${written}="${code}" could not be read as a handler, so ` +
          (html
            ? 'SoftN runs no handler for it (on a page given its document, it runs as a browser runs it). '
            : 'it does nothing. ') +
          `Call a function of the app's logic, as in ${written}="save()", or write @${name}={() => …}`,
        severity: 'warning',
        loc,
      });
      return null;
    }
    // Its parts were read from the wrapper above, so their places are in
    // that text; they are the attribute's place in the page.
    relocate(handler, loc);
    const event: EventNode = { type: 'Event', name, handler, loc };
    if (all.length > 0) event.modifiers = all;
    if (!reference) event.quoted = true;
    return event;
  }

  /** The value of a quoted attribute — `name="x"` — or undefined if not written that way. */
  private staticPropValue(element: ElementNode, name: string): string | undefined {
    const prop = element.props.find((p) => p.name === name);
    return prop && prop.value.type === 'static' ? prop.value.value : undefined;
  }

  /**
   * Whether a tag is an HTML element's, or a drawing's inside an `<svg>` or
   * `<math>` being read (see isHtmlElementTag): what decides that its
   * attribute, event and binding names are HTML's, its `on…` attributes
   * handlers, and its mistakes warnings. A component written in lower case
   * (`<datatable onRowClick>`) keeps its names and its errors.
   */
  private htmlElement(tag: string): boolean {
    return isHtmlElementTag(tag, this.openTags.includes('svg') || this.openTags.includes('math'));
  }

  /**
   * The formatting elements to open again before the current token, opened,
   * with what follows read into the innermost; none when there are none or
   * the token is not one HTML opens them for. Those are the active ones after
   * the last that is still open (or the last marker), in the order they were
   * opened; the token is text, an expression or an inline HTML element (not a
   * block, `<b><i>x</b><h2>`, a ruby's annotation, nor a component, which
   * keeps its own content).
   * Unlike HTML, space alone (a page's layout between tags) opens none.
   */
  private reconstructFormatting(): TemplateNode[] {
    if (this.activeFormatting.length === 0 || this.inDrawing()) return [];
    if (this.curTokenIs(TokenType.TAG_END_OPEN)) {
      // A `</br>` is a `<br>` (see parseChildren).
      if (this.tagNameAhead() !== 'br') return [];
    } else if (this.curTokenIs(TokenType.TAG_OPEN)) {
      const next = this.tagNameAhead();
      if (!isHtmlElementTag(next) || RUBY_ANNOTATIONS.has(next) || (SPECIAL_ELEMENTS.has(next) && !REOPENS_FORMATTING.has(next))) return [];
    } else if (!this.curTokenIs(TokenType.EXPR_START) && !(this.curTokenIs(TokenType.TEXT) && this.curToken.literal.trim() !== '')) {
      return [];
    }
    let first = this.activeFormatting.length;
    while (first > 0) {
      const entry = this.activeFormatting[first - 1];
      if (entry === 'marker' || this.openSet.has(entry)) break;
      first--;
    }
    // As many as fit under MAX_TREE_DEPTH, each copy holding what follows.
    const room = MAX_TREE_DEPTH - 1 - this.openTags.length;
    if (first === this.activeFormatting.length || room <= 0) return [];
    return this.reopenElements(this.activeFormatting.slice(first, first + room) as ElementNode[], this.currentLoc());
  }

  /** Where the innermost open element the end tag `closer` ends is, in openTags; -1 for none. */
  private openTagIndex(closer: string): number {
    for (let at = this.openTags.length - 1; at >= 0; at--) {
      if (closesElement(closer, this.openTags[at])) return at;
    }
    return -1;
  }

  /**
   * Whether HTML passes over the end tag `closer` of the element open at
   * `match`, for what is open inside it: an end tag of an element it gives no
   * structure (a `</span>`, a `</ruby>`) does not reach past one it does (a
   * div, a list item), so `<span><div>x</span>y` keeps y in the div; and no
   * end tag reaches past a table, a cell or a caption (HTML's scopes), but a
   * table's own. A component's end tag closes all that is open inside it.
   */
  private endTagStopped(closer: string, match: number): boolean {
    if (!isHtmlElementTag(closer)) return false;
    const between = this.openTags.slice(match + 1);
    if (!SPECIAL_ELEMENTS.has(closer) && !FORMATTING_ELEMENTS.has(closer)) return between.some((open) => SPECIAL_ELEMENTS.has(open));
    const boundaries = TABLE_PARTS.has(closer)
      ? TABLE_SCOPE_BOUNDARIES
      : closer === 'p'
        ? BUTTON_SCOPE_BOUNDARIES
        : closer === 'li'
          ? LIST_ITEM_SCOPE_BOUNDARIES
          : DEFAULT_SCOPE_BOUNDARIES;
    return between.some((open) => boundaries.has(open));
  }

  /**
   * A formatting element's end tag read inside a block it holds
   * (`<b><div>a</b>c</div>`), read as HTML's adoption agency reads it: the
   * block leaves the formatting element to stand after it, what the block
   * holds so far is wrapped in a copy of the formatting element, and what
   * follows the end tag is read on into the block, unformatted:
   * `<b></b><div><b>a</b>c</div>`. Through blocks in blocks, each is split
   * so. Whether it was read so; the end tag is then read (`endTag`; an
   * `<a>` or `<nobr>` start tag is left to be read, see endsLikeFormatting),
   * and the elements the blocks are in move them when they return (adoptions).
   */
  private adoptBlock(closer: string, match: number, blockTag: string, children: TemplateNode[], endTag = true): boolean {
    const formatting = this.openElements[match];
    if (!formatting || !FORMATTING_ELEMENTS.has(closer) || !SPECIAL_ELEMENTS.has(blockTag) || this.inDrawing()) return false;
    // What is open from the formatting element in: blocks, each an HTML
    // element HTML gives structure but no scope of its own (a cell's, a
    // caption's); formatting elements still active, which are copied around
    // the block; and inline elements, which a block inside them leaves. One
    // whose formatting element's end tag was read already is passed over; a
    // component is not read through.
    const open: Array<{ element: ElementNode; kind: 'block' | 'formatting' | 'inline' }> = [];
    for (let at = match + 1; at < this.openTags.length; at++) {
      const tag = this.openTags[at];
      if (tag === ADOPTED) continue;
      const element = this.openElements[at];
      if (!element || this.adoptions.has(element) || !isHtmlElementTag(tag) || DEFAULT_SCOPE_BOUNDARIES.has(tag)) return false;
      const active = FORMATTING_ELEMENTS.has(tag) && this.activeFormatting.includes(element);
      open.push({ element, kind: SPECIAL_ELEMENTS.has(tag) ? 'block' : active ? 'formatting' : 'inline' });
    }
    if (!open.some((entry) => entry.kind === 'block') || this.adoptions.has(formatting)) return false;
    // Only one the formatting elements' list still holds, in this cell or branch.
    const listed = this.activeFormatting.lastIndexOf(formatting);
    if (listed < 0 || listed < this.activeFormatting.lastIndexOf('marker')) return false;
    // As in HTML, three formatting elements above a block are copied; one
    // further out is ended as an inline element is, and is no longer active.
    let above = 0;
    for (let at = open.length - 1; at >= 0; at--) {
      const entry = open[at];
      above = entry.kind === 'block' ? 0 : above + 1;
      if (above > 3 && entry.kind === 'formatting') {
        this.deactivate(entry.element);
        entry.kind = 'inline';
      }
    }
    const loc = this.currentLoc();
    if (endTag) {
      this.nextToken(); // </
      this.readTagName();
      if (this.curTokenIs(TokenType.TAG_CLOSE)) this.nextToken();
    }
    const copy = copyElement(formatting, loc);
    copy.children = children.splice(0);
    children.push(copy);
    this.deactivate(formatting);
    // Its end tag has been read: no later end tag ends it.
    this.openTags[match] = ADOPTED;
    // Each moves on what the element inside it on the way gives it (adoptions).
    this.adoptions.set(formatting, { next: open[0].element, kind: 'hoist', formatting });
    for (let at = 0; at < open.length - 1; at++) {
      const { element, kind } = open[at];
      this.adoptions.set(element, { next: open[at + 1].element, kind: kind === 'block' ? 'split' : kind === 'formatting' ? 'wrap' : 'hoist', formatting });
    }
    this.diagnostics.push({
      message: endTag
        ? `</${closer}> is inside the <${blockTag}> it holds, so the <${blockTag}> is moved after it and what follows stays in the <${blockTag}>, as HTML reads it`
        : `<${closer}> is inside a <${blockTag}> another <${closer}> holds, which ends there, so the <${blockTag}> is moved after it, as HTML reads it`,
      severity: 'warning',
      loc,
    });
    return true;
  }

  /**
   * HTML's rule for an `<a>` or `<nobr>` start tag: one still active (in
   * this cell, component or branch) is ended first, as its end tag would end
   * it, so a link never holds a link: `<a href=1><span><a href=2>` ends the
   * span and the first link. One something else ended is only no longer
   * active, so it is not opened again around what follows the new one.
   * Inside a block in it, the block is moved out of it (adoptBlock) and the
   * new one is read in the block. Whether the current element ends here.
   */
  private endsLikeFormatting(next: string, parent: ElementNode | undefined, parentTag: string, children: TemplateNode[]): boolean {
    if (next !== 'a' && next !== 'nobr') return false;
    let active: ElementNode | undefined;
    for (let at = this.activeFormatting.length - 1; at >= 0 && !active; at--) {
      const entry = this.activeFormatting[at];
      if (entry === 'marker') return false;
      if (entry.tag === next) active = entry;
    }
    if (!active) return false;
    const match = this.openElements.lastIndexOf(active);
    if (match < 0 || parent === active) {
      this.deactivate(active);
      return match >= 0;
    }
    // Past a table, a cell or the like it is out of reach: only no longer active.
    if (this.openTags.slice(match + 1).some((open) => DEFAULT_SCOPE_BOUNDARIES.has(open))) {
      this.deactivate(active);
      return false;
    }
    // An inline element inside it ends with it; a formatting one is opened again after.
    if (!SPECIAL_ELEMENTS.has(parentTag)) return true;
    if (!this.adoptBlock(next, match, parentTag, children, false)) this.deactivate(active);
    return false;
  }

  /**
   * Whether what is being read is inside an element a table will move
   * before itself (fostersOut): one written straight in a table, its body
   * or a row, and not in a cell or caption since.
   */
  private inFosteredElement(): boolean {
    for (let at = this.openTags.length - 1; at > 0; at--) {
      const tag = this.openTags[at];
      if (tag === 'td' || tag === 'th' || tag === 'caption' || !isHtmlElementTag(tag)) return false;
      if (ROW_PARENTS.has(this.openTags[at - 1]) && !TABLE_CONTENT.has(tag) && tag !== ADOPTED) return true;
    }
    return false;
  }

  /**
   * What an element on the way to a block a formatting element's end tag was
   * read in does when the next one on the way returns (adoptions): `added`
   * is what was just read into `children`. Whether the element ends here.
   */
  private takeAdoption(parent: ElementNode | undefined, added: TemplateNode[], children: TemplateNode[], loc: SourceLocation): boolean {
    const adoption = parent && this.adoptions.get(parent);
    if (!parent || !adoption) return false;
    const at = added.indexOf(adoption.next);
    if (at < 0) return false;
    this.adoptions.delete(parent);
    const after = added.slice(at + 1);
    const moved = children.splice(children.length - (after.length > 0 ? after.length : added.length - at));
    if (adoption.kind === 'split') {
      const copy = copyElement(adoption.formatting, loc);
      copy.children = children.splice(0);
      children.push(copy, ...moved);
      return false;
    }
    if (adoption.kind === 'wrap') {
      // A copy of this element, active in its place, holds what moved, and
      // what follows is read on into it; this element's own end tag ends the copy.
      const copy = copyElement(parent, loc);
      this.attributeKeys.set(copy, this.attributesKey(parent));
      const listed = this.activeFormatting.indexOf(parent);
      if (listed >= 0) this.activeFormatting[listed] = copy;
      this.openTags[this.openTags.length - 1] = ADOPTED;
      copy.children = [...moved, ...this.parseChildren(copy.tag, loc, copy)];
      this.adoptedAfter.unshift(copy);
      return true;
    }
    this.adoptedAfter.push(...moved);
    return true;
  }

  /** A formatting element is no longer active: it was ended by its own end tag. */
  private deactivate(element: ElementNode): void {
    const at = this.activeFormatting.lastIndexOf(element);
    if (at >= 0) this.activeFormatting.splice(at, 1);
  }

  /** The last active formatting element of this name that is no longer open, after the last marker, is no longer active. */
  private deactivateClosed(tag: string): void {
    for (let at = this.activeFormatting.length - 1; at >= 0; at--) {
      const entry = this.activeFormatting[at];
      if (entry === 'marker') return;
      if (entry.tag === tag && !this.openSet.has(entry)) {
        this.activeFormatting.splice(at, 1);
        return;
      }
    }
  }

  /**
   * A formatting element opened (parseElement): active until its own end tag.
   * As in HTML, no more than three of one name and attributes are active
   * after the last marker; the oldest goes (Noah's Ark). Without the bound,
   * page after page of unclosed `<b><i>` opened copies of copies. Unlike
   * HTML, no more than MAX_ACTIVE_FORMATTING of any kind either: a thousand
   * paragraphs each leaving open a `<b>` with attributes of its own opened
   * every earlier one again in each, a million elements in all.
   */
  private activate(element: ElementNode): void {
    const key = this.attributesKey(element);
    const marker = this.activeFormatting.lastIndexOf('marker');
    const matching: number[] = [];
    for (let at = marker + 1; at < this.activeFormatting.length; at++) {
      const entry = this.activeFormatting[at];
      if (entry !== 'marker' && entry.tag === element.tag && this.attributesKey(entry) === key) matching.push(at);
    }
    if (matching.length >= 3) this.activeFormatting.splice(matching[0], 1);
    else if (this.activeFormatting.length - marker - 1 >= MAX_ACTIVE_FORMATTING) this.activeFormatting.splice(marker + 1, 1);
    this.activeFormatting.push(element);
  }

  /** attributesKey, worked out once for each element: a copy shares its original's. */
  private attributesKey(element: ElementNode): string {
    let key = this.attributeKeys.get(element);
    if (key === undefined) {
      key = attributesKey(element);
      this.attributeKeys.set(element, key);
    }
    return key;
  }

  /** Whether a child written straight in a table goes before it (TABLE_CONTENT; an input only when hidden). */
  private fostersOut(child: TemplateNode): boolean {
    if (child.type === 'Text') return child.content.trim() !== '';
    if (child.type !== 'Element' || !this.htmlElement(child.tag)) return false;
    if (child.tag === 'input') return (this.staticPropValue(child, 'type') ?? '').toLowerCase() !== 'hidden';
    return !TABLE_CONTENT.has(child.tag);
  }

  /**
   * Whether the start tag `next` ends an element open around the current one,
   * which then ends too, as HTML ends it. A tag that ends a paragraph ends
   * one open through inline elements (HTML's "button scope": not past a
   * button, a table or a cell); an `<li>`, `<dt>` or `<dd>` ends its like
   * through any element but HTML's own structural ones (an address, a div
   * or a paragraph excepted). Only through HTML elements: a component is
   * never ended by what is written in it.
   */
  private endsAnAncestor(next: string): boolean {
    const target = next === 'li' ? ['li'] : next === 'dt' || next === 'dd' ? ['dt', 'dd'] : null;
    if (target && this.findsOpen((open) => target.includes(open), (open) => SPECIAL_ELEMENTS.has(open) && open !== 'address' && open !== 'div' && open !== 'p')) {
      return true;
    }
    // A paragraph open through inline elements (HTML's button scope).
    if (ENDS_A_PARAGRAPH.has(next) && this.findsOpen((open) => open === 'p', (open) => BUTTON_SCOPE_BOUNDARIES.has(open))) return true;
    // A button cannot hold a button, through any element (HTML's default scope).
    return next === 'button' && this.findsOpen((open) => open === 'button', (open) => DEFAULT_SCOPE_BOUNDARIES.has(open));
  }

  /**
   * Whether an element `matches` is open around the current one, walking
   * from the current element outwards, as HTML walks its stack of open
   * elements, and stopping at one that `stops` or at a component.
   */
  private findsOpen(matches: (open: string) => boolean, stops: (open: string) => boolean): boolean {
    for (let at = this.openTags.length - 1; at >= 0; at--) {
      const open = this.openTags[at];
      if (open === ADOPTED) continue;
      if (!isHtmlElementTag(open)) return false;
      if (at < this.openTags.length - 1 && matches(open)) return true;
      if (stops(open)) return false;
    }
    return false;
  }

  /**
   * Whether what is being read is inside a drawing (an `<svg>` or `<math>`)
   * and not in one of the places in it that hold HTML again
   * (`<foreignObject>`, `<desc>`, a MathML token's text…).
   */
  private inDrawing(): boolean {
    for (let at = this.openTags.length - 1; at >= 0; at--) {
      const tag = this.openTags[at].toLowerCase();
      if (HOLDS_HTML_IN_DRAWING.has(tag)) return false;
      if (tag === 'svg' || tag === 'math') return true;
    }
    return false;
  }

  /**
   * The name of the tag whose `<` or `</` is the current token, as the parser
   * keeps tag names (see normalizeTagName), hyphens included (`my-card`);
   * '' when no name follows.
   */
  private tagNameAhead(): string {
    const written = /^[A-Za-z_$][\w$]*(?:-[\w$]+)*/.exec(this.source.slice(this.peekToken.start, this.peekToken.start + 64));
    return written ? normalizeTagName(written[0]) : '';
  }

  /**
   * Parse children until closing tag. `parent` is the element they belong
   * to, when there is one (see activeFormatting and adoptions).
   */
  private parseChildren(parentTag: string, openLoc: SourceLocation, parent?: ElementNode): TemplateNode[] {
    const children: TemplateNode[] = [];
    let closed = false;
    const diagnosticsBefore = this.diagnostics.length;
    this.openTags.push(parentTag);
    this.openElements.push(parent);
    if (parent) this.openSet.add(parent);
    const marks = FORMATTING_MARKERS.has(parentTag) || !this.htmlElement(parentTag);
    if (marks) this.activeFormatting.push('marker');
    try {
    // Formatting elements opened again inside this one (reopenElements).
    if (this.reopenInside.length > 0) {
      const inner = this.reopenInside;
      this.reopenInside = [];
      const added = this.reopenElements(inner, openLoc);
      children.push(...added);
      closed = this.takeAdoption(parent, added, children, openLoc);
    }

    while (!closed && !this.curTokenIs(TokenType.EOF)) {
      this.skipComments();
      const passStart = this.curToken.start;

      // An HTML element that has no place in a drawing ends the `<svg>` or
      // `<math>` it is written in, and everything open inside it, as HTML ends
      // them: `<svg><p>x` is `<svg></svg><p>x`. So does a `</p>` or a `</br>`.
      if (this.inDrawing()) {
        const next = this.tagNameAhead();
        if (
          (this.curTokenIs(TokenType.TAG_OPEN) && BREAKS_OUT_OF_DRAWING.has(next)) ||
          (this.curTokenIs(TokenType.TAG_END_OPEN) && (next === 'p' || next === 'br'))
        ) {
          closed = true;
          break;
        }
      }

      // HTML's rules for a start tag, where HTML is read (in a drawing, every
      // tag but those above is the drawing's).
      if (this.curTokenIs(TokenType.TAG_OPEN) && !this.inDrawing()) {
        const next = this.tagNameAhead();
        if (
          // An `<a>` or `<nobr>` ends one still open around it (endsLikeFormatting).
          this.endsLikeFormatting(next, parent, parentTag, children) ||
          // A start tag HTML ends this element before: an `<li>` at the next
          // `<li>`, a `<p>` at a `<div>`, a cell at the next cell or row, a
          // heading at another heading, a caption at the table's rows. Read as
          // needing its end tag, an unclosed `<li>` held everything after it,
          // and the rest of the page was inside the list item.
          endsBefore(parentTag, next, this.openTags) ||
          // Or an element this one is inside: `<p><b><div>` ends the b and the
          // paragraph, `<li><span>a<li>` the span and the item (see endsAnAncestor).
          this.endsAnAncestor(next) ||
          // In what a table moves before itself, the table's own tags are still
          // the table's: `<table><nav><tr>` is an empty nav and a row.
          (TABLE_PARTS.has(next) && this.inFosteredElement()) ||
          // In a ruby, an annotation ends the paragraph, item or annotation
          // left open before it (HTML's implied end tags): `<ruby><p>漢<rt>`.
          (RUBY_ANNOTATIONS.has(next) &&
            IMPLIED_END_TAGS.has(parentTag) &&
            !(parentTag === 'rtc' && (next === 'rt' || next === 'rp')) &&
            this.findsOpen((open) => open === 'ruby', (open) => DEFAULT_SCOPE_BOUNDARIES.has(open)))
        ) {
          closed = true;
          break;
        }
      }

      // The end tag of an element this one is inside ends this one too, as
      // HTML ends it: `<div><span>text</div>` closes the span and the div. It
      // used to be a mismatch that left the span open, so the rest of the
      // page was inside it. An HTML element left open is a warning, as a
      // browser takes it in its stride; a component's is still an error.
      if (this.curTokenIs(TokenType.TAG_END_OPEN)) {
        const next = this.tagNameAhead();
        const match = closesElement(next, parentTag) ? -1 : this.openTagIndex(next);
        if (match >= 0 && parent && this.adoptBlock(next, match, parentTag, children)) continue;
        if (match >= 0 && !this.endTagStopped(next, match)) {
          if (!OPTIONAL_END_TAGS.has(parentTag)) this.reportImpliedEnd(parentTag, next, openLoc);
          // A formatting element ended this way stays active (activeFormatting).
          closed = true;
          break;
        }
      }

      // Check for closing tag
      if (this.curTokenIs(TokenType.TAG_END_OPEN)) {
        this.nextToken(); // consume </
        // Keyword tags (`</slot>`) close like any other — see parseElement.
        if (this.isPropertyName()) {
          const nameLoc = this.currentLoc();
          const closeTagName = normalizeTagName(this.readTagName());
          // In any case: `<div>…</DIV>`, `<Button>…</button>`; and any heading's
          // end tag ends a heading, as HTML reads `<h1>…</h2>`.
          if (closesElement(closeTagName, parentTag)) {
            if (this.curTokenIs(TokenType.TAG_CLOSE)) {
              this.nextToken(); // consume >
            }
            if (parent) this.deactivate(parent);
            closed = true;
            break;
          }
          // The end tag of a formatting element that is active but no longer
          // open (one a `</ul>` ended) ends it there, as HTML's adoption agency does.
          if (FORMATTING_ELEMENTS.has(closeTagName)) this.deactivateClosed(closeTagName);
          // `</input>` and `</img>` close nothing: their elements ended with
          // their tags, and HTML passes over them, so they are passed over
          // here too; as are the `</body>` and `</html>` a document's page
          // ends with. HTML reads two end tags as elements: a `</p>` with no
          // paragraph open is an empty one, and a `</br>` is a `<br>`.
          const passedOver = VOID_ELEMENTS.has(closeTagName) || documentWrapper(closeTagName) !== null;
          if (closeTagName === 'p' || closeTagName === 'br') {
            children.push(createElementNode(closeTagName, nameLoc, { selfClosing: closeTagName === 'br' }));
          } else if (!passedOver) {
            this.reportStrayEnd(parentTag, closeTagName, nameLoc);
          }
          // Consume the rest of the closing tag
          if (this.curTokenIs(TokenType.TAG_CLOSE)) {
            this.nextToken(); // consume >
          }
          continue;
        }
        continue;
      }

      try {
        // Formatting elements something else ended, opened again around what follows.
        const reopened = this.reconstructFormatting();
        children.push(...reopened);
        if (this.takeAdoption(parent, reopened, children, this.currentLoc())) {
          closed = true;
          break;
        }
        if (this.curToken.start !== passStart) {
          // What followed was read into them: read on from there.
        } else if (this.curTokenIs(TokenType.TAG_OPEN)) {
          // Child element
          this.nextToken();
          const added = this.parseChildElement();
          children.push(...added);
          // On the way to a block a formatting element's end tag was read in (takeAdoption).
          if (this.takeAdoption(parent, added, children, this.currentLoc())) {
            closed = true;
            break;
          }
        } else if (this.curTokenIs(TokenType.HASH)) {
          // Control flow
          const controlFlow = this.parseControlFlow();
          if (controlFlow) {
            children.push(controlFlow);
          }
        } else if (this.curTokenIs(TokenType.EXPR_START)) {
          // Expression interpolation
          children.push(this.parseExpressionNode());
        } else if (this.curTokenIs(TokenType.TEXT)) {
          children.push(createTextNode(this.curToken.literal, this.currentLoc()));
          this.nextToken();
        } else {
          this.nextToken();
        }
      } catch (error) {
        // Record the error and skip to the next child or closing tag
        this.addDiagnostic(error);
        this.skipToChildRecoveryPoint(parentTag);
        // The recovery point may be the token that has just failed: text and
        // `{` are both places to resume and places a child can fail. Reading
        // it again fails the same way, for ever, so a pass that threw where
        // it began steps over that token.
        if (this.curToken.start === passStart && !this.curTokenIs(TokenType.EOF)) {
          this.nextToken();
        }
      }
    }

    // Reaching EOF without the close tag used to be silent: a missing `</Card>`,
    // an unterminated `{` or `"` inside it, all simply ended the document there
    // with fewer nodes and no diagnostic, so the author had nothing to search
    // for. Only when nothing else was reported inside this element, though —
    // a mismatched tag or an unterminated template literal already explains
    // the truncation, and every ancestor would otherwise repeat it.
    if (!closed && this.diagnostics.length === diagnosticsBefore && !OPTIONAL_END_TAGS.has(parentTag)) {
      // An HTML element still open at the end of the page ends there, as in
      // a browser: a warning. A component's missing end tag is an error.
      if (this.htmlElement(parentTag)) {
        this.diagnostics.push({ message: `<${parentTag}> is not closed, so it ends at the end of the page`, severity: 'warning', loc: openLoc });
      } else {
        this.addDiagnostic(new UnclosedTagError(parentTag, openLoc, this.source));
      }
    }

    return children;
    } finally {
      this.openTags.pop();
      this.openElements.pop();
      if (parent) this.openSet.delete(parent);
      // What was opened inside a cell, a caption and the like stays in it.
      if (marks) this.activeFormatting.splice(this.activeFormatting.lastIndexOf('marker'));
    }
  }

  /** An element ended by the end tag of one it is inside (see parseChildren). */
  private reportImpliedEnd(open: string, closer: string, loc: SourceLocation): void {
    if (this.htmlElement(open)) {
      this.diagnostics.push({ message: `<${open}> is not closed, so it ends at </${closer}>`, severity: 'warning', loc });
    } else {
      this.addDiagnostic(new MismatchedTagError(open, closer, loc, this.source));
    }
  }

  /** An end tag that closes nothing open: passed over. */
  private reportStrayEnd(open: string, closer: string, loc: SourceLocation): void {
    if (this.htmlElement(open) && this.htmlElement(closer)) {
      this.diagnostics.push({ message: `</${closer}> closes nothing that is open here, so it was passed over`, severity: 'warning', loc });
    } else {
      this.addDiagnostic(new MismatchedTagError(open, closer, loc, this.source));
    }
  }

  /**
   * Formatting elements (`<b>`, `<i>`, `<a>`…) opened again after something
   * other than their own end tag ended them (reconstructFormatting), each
   * inside the one before, with the attributes they were written with; what
   * follows is read into the innermost, up to its own end tag or its parent's.
   * Each copy takes its element's place in activeFormatting.
   */
  private reopenElements(templates: ElementNode[], loc: SourceLocation): TemplateNode[] {
    const [first, ...rest] = templates;
    const clone = copyElement(first, loc);
    this.attributeKeys.set(clone, this.attributesKey(first));
    const at = this.activeFormatting.indexOf(first);
    if (at >= 0) this.activeFormatting[at] = clone;
    this.reopenInside = rest;
    clone.children = this.parseChildren(clone.tag, loc, clone);
    // Opened again for what follows; with nothing following, there is none
    // (as in HTML), unless it is on the way to a block that moves (adoptions).
    // What it moved out of itself follows it.
    const onTheWay = [...this.adoptions.values()].some((adoption) => adoption.next === clone);
    return [...(clone.children.length > 0 || onTheWay ? [clone] : []), ...this.adoptedAfter.splice(0)];
  }

  /**
   * A quoted attribute of an HTML element (a lower-case tag), as written: in
   * HTML a backslash is a backslash, and `pattern="\d{3}"` means a digit.
   * Read as a SoftN string, `\d` was an escape for `d`, and the pattern
   * checked for a letter d. Undefined where the value has no backslash, or
   * the element is a component, whose strings are SoftN's.
   */
  private htmlAttributeText(tag: string | undefined): string | undefined {
    if (!tag || !this.htmlElement(tag)) return undefined;
    const text = this.source.slice(this.curToken.start, this.curToken.end);
    const quote = text[0];
    if ((quote !== '"' && quote !== "'") || !text.includes('\\')) return undefined;
    return text.slice(1, text.length > 1 && text[text.length - 1] === quote ? -1 : undefined);
  }

  /**
   * Parse a prop
   * Supports:
   * - Boolean shorthand: prop
   * - Quoted value: prop="value"
   * - Expression: prop={expression}
   * - Bare identifier/value shorthand: prop=value (for simple values like primary, lg, etc.)
   */
  private parseProp(tag?: string): PropNode {
    const loc = this.currentLoc();
    let name = this.curToken.literal;
    let nameEnd = this.curToken.end;
    this.nextToken();

    // Hyphens are part of attribute names, but remain subtraction inside
    // expressions. Join only adjacent name segments here, not in the lexer.
    while (
      this.curTokenIs(TokenType.MINUS) && this.curToken.start === nameEnd &&
      this.peekToken.start === this.curToken.end &&
      /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(this.peekToken.literal)
    ) {
      this.nextToken();
      name += `-${this.curToken.literal}`;
      nameEnd = this.curToken.end;
      this.nextToken();
    }

    // A namespaced attribute — `class:active={cond}` — is ONE name.
    //
    // Read as two things it was destructive rather than merely unsupported: the
    // element loop took `class` as an attribute and `:active` as a binding, so
    // the element ended up with a SECOND `class` prop whose value was boolean
    // true. That overwrote the real one, and
    //
    //     <div class="card" class:active={on}>x</div>
    //
    // rendered as <div>x</div> — the class the author wrote was gone. The
    // syntax is in softn-studio's language reference, so its generator emits it.
    //
    // Adjacency is required: the colon must touch the name. `<div class :bind={x}>`
    // with a space is still an attribute followed by a binding, which is what it
    // has always meant.
    //
    // The part after the colon is a class name or a CSS property, so it is
    // read to the end of the run of touching name pieces: `class:is-active`,
    // `class:mt-2`, `style:font-size`, `style:--accent`. It used to stop at
    // the first hyphen, which made `class:is-active={on}` the class "is" and
    // a separate attribute `active`.
    if (
      this.curTokenIs(TokenType.COLON) &&
      this.curToken.start === nameEnd &&
      this.peekToken.start === this.curToken.end &&
      this.isNamePiece(this.peekToken)
    ) {
      this.nextToken(); // consume ':'
      let suffix = '';
      let suffixEnd = this.curToken.start;
      while (this.curToken.start === suffixEnd && this.isNamePiece(this.curToken)) {
        suffix += this.curToken.literal;
        suffixEnd = this.curToken.end;
        this.nextToken();
      }
      name = `${name}:${suffix}`;
    }

    let value: PropValue = { type: 'boolean', value: true };

    if (this.curTokenIs(TokenType.EQUALS)) {
      this.nextToken();

      if (this.curTokenIs(TokenType.STRING)) {
        // Quoted string: prop="value". Its entities are read as text's are:
        // `&quot;` is the only way to write the quote the value is closed
        // by, and it used to arrive as six characters.
        value = { type: 'static', value: decodeHtmlEntities(this.htmlAttributeText(tag) ?? this.curToken.literal, true) };
        this.nextToken();
      } else if (this.curTokenIs(TokenType.EXPR_START)) {
        // Expression: prop={expression}
        this.nextToken();
        const expr = this.parseExpression();
        value = { type: 'expression', value: expr };
        this.closeExpression();
      } else if (this.curTokenIs(TokenType.IDENTIFIER)) {
        // Bare identifier shorthand: prop=value (treated as static string)
        value = { type: 'static', value: this.curToken.literal };
        this.nextToken();
      } else if (this.curTokenIs(TokenType.NUMBER)) {
        // Bare number: prop=123
        value = { type: 'number', value: Number(this.curToken.literal) };
        this.nextToken();
      } else if (this.curTokenIs(TokenType.TRUE)) {
        // Bare boolean: prop=true
        value = { type: 'boolean', value: true };
        this.nextToken();
      } else if (this.curTokenIs(TokenType.FALSE)) {
        // Bare boolean: prop=false
        value = { type: 'boolean', value: false };
        this.nextToken();
      }
    }

    return { type: 'Prop', name, value, loc };
  }

  /**
   * Parse an event handler
   * Supports both @click={handler} and @click=handler (shorthand)
   */
  private parseEventHandler(): EventNode {
    const loc = this.currentLoc();
    this.nextToken(); // consume @

    // An event name is a name, not an expression, so a word that happens to be
    // a keyword is still just a word — `@delete`, `@new`, `@in`. Matching only
    // IDENTIFIER left the keyword unconsumed and the error surfaced one token
    // later as `expected EQUALS`, pointing at the name and saying nothing about
    // it. The bundled demo-bundle/main.ui, which the CLI's own help offers as
    // the worked example, wrote `@delete` on a to-do row then, and failed to
    // parse there. (It no longer does: the row is an imported page, which
    // takes no events, and calls deleteTodo() itself.)
    let name = '';
    if (this.isPropertyName()) {
      name = this.curToken.literal;
      this.nextToken();
    }

    // `@submit.prevent`, `@keydown.enter`, `@click.stop.once`: the words after
    // the name. A dot here used to end the attribute with "expected EQUALS".
    // An unknown word is kept on the node and reported, so a typo reads as a
    // typo rather than as a handler that silently never filters.
    const modifiers: string[] = [];
    while (this.curTokenIs(TokenType.DOT)) {
      this.nextToken(); // consume .
      if (!this.isPropertyName()) {
        throw new UnexpectedTokenError(this.curToken, TokenType.IDENTIFIER, this.source);
      }
      // In any case: every modifier is a lower-case word (`.PREVENT` is `.prevent`).
      const modifier = this.curToken.literal.toLowerCase();
      if (!isEventModifier(modifier)) {
        this.diagnostics.push({
          message:
            `Unknown event modifier ".${modifier}" on @${name}. The modifiers are ` +
            'prevent, stop and self, the keys enter, escape, space, tab, up, down, left, ' +
            'right, backspace and delete, and the held keys ctrl, shift, alt and meta',
          severity: 'error',
          loc: this.currentLoc(),
        });
      }
      modifiers.push(modifier);
      this.nextToken();
    }

    this.expectToken(TokenType.EQUALS);

    let handler: Expression;

    // Check if this is a braced expression or a bare identifier
    if (this.curTokenIs(TokenType.EXPR_START)) {
      // Standard syntax: @click={handler}
      this.nextToken();
      handler = this.parseExpression();
      this.closeExpression();
    } else if (this.curTokenIs(TokenType.IDENTIFIER)) {
      // Shorthand syntax: @click=handleClick (bare identifier)
      handler = createIdentifier(this.curToken.literal, this.currentLoc());
      this.nextToken();
    } else {
      // Fallback to undefined handler
      handler = createIdentifier('undefined', this.currentLoc());
      // `@click="save()"` is how other frameworks write a handler, and how
      // HTML writes `onclick="save()"`: code in quotes, run when the event
      // fires. It is read that way (see quotedHandler). The quotes used to
      // make it words, and the button had no handler. Code that cannot be
      // read is still a warning, not an error: the page runs, and the
      // Builder, which takes an error for a page it cannot write back as
      // written, could write it and still can.
      if (this.curTokenIs(TokenType.STRING)) {
        const written = decodeHtmlEntities(this.curToken.literal, true);
        const event = `@${name}${modifiers.map((modifier) => `.${modifier}`).join('')}`;
        this.nextToken();
        const quoted = written.trim() === '' ? null : this.quotedHandler(name, modifiers, written, loc, event);
        if (quoted) return quoted;
        if (written.trim() === '') {
          this.diagnostics.push({
            message: `${event}="" has no handler: write the code to run in the quotes, or ${event}={…}`,
            severity: 'warning',
            loc,
          });
        }
      }
    }

    return modifiers.length > 0
      ? { type: 'Event', name, handler, modifiers, loc }
      : { type: 'Event', name, handler, loc };
  }

  /**
   * Parse a binding
   */
  private parseBinding(): BindingNode {
    const loc = this.currentLoc();
    this.nextToken(); // consume :

    // Same as the event name above: `:delete`, `:new` and friends are names.
    let name = '';
    if (this.isPropertyName()) {
      name = this.curToken.literal;
      this.nextToken();
    }

    this.expectToken(TokenType.EQUALS);
    this.expectToken(TokenType.EXPR_START);

    const expression = this.parseExpression();
    this.closeExpression();

    return { type: 'Binding', name, expression, loc };
  }

  /**
   * Parse control flow (#if, #each, etc.)
   */
  private parseControlFlow(): IfBlock | EachBlock | null {
    this.nextToken(); // consume #

    if (this.curTokenIs(TokenType.IF)) {
      return this.parseIfBlock();
    } else if (this.curTokenIs(TokenType.EACH)) {
      return this.parseEachBlock();
    }

    return null;
  }

  /**
   * Parse an if block
   */
  private parseIfBlock(head?: SourceLocation): IfBlock {
    const loc = this.currentLoc();
    this.nextToken(); // consume 'if'

    this.expectToken(TokenType.LPAREN);
    const condition = this.parseExpression();
    this.expectToken(TokenType.RPAREN);
    this.reportPendingOperand();

    const consequent = this.parseBranch([TokenType.ELSE, TokenType.ELSEIF, TokenType.END]);

    let alternate: TemplateNode[] | IfBlock | undefined;

    // Check for #else or #elseif
    if (this.curTokenIs(TokenType.HASH)) {
      this.nextToken();

      if (this.curTokenIs(TokenType.ELSEIF)) {
        alternate = this.parseIfBlock(head ?? loc);
        return { type: 'IfBlock', condition, consequent, alternate, loc };
      } else if (this.curTokenIs(TokenType.ELSE) && this.peekToken.type === TokenType.IF) {
        // `#else if (…)`: the lexer keeps the header open for exactly this
        // spelling, and it is the same chain link `#elseif (…)` makes.
        this.nextToken(); // consume 'else'; parseIfBlock consumes the 'if'
        alternate = this.parseIfBlock(head ?? loc);
        return { type: 'IfBlock', condition, consequent, alternate, loc };
      } else if (this.curTokenIs(TokenType.ELSE)) {
        this.nextToken();
        alternate = this.parseBranch([TokenType.END]);
      } else if (this.curTokenIs(TokenType.END)) {
        this.nextToken();
        // A following #end belongs to the parent block, not this one.
        return { type: 'IfBlock', condition, consequent, alternate, loc };
      }
    }

    // Consume #end if present
    if (this.curTokenIs(TokenType.HASH) && this.peekToken.type === TokenType.END) {
      this.nextToken();
      this.nextToken();
    } else {
      this.reportMissingEnd('#if', head ?? loc);
    }

    return { type: 'IfBlock', condition, consequent, alternate, loc };
  }

  /**
   * The content of a branch of a block (`#if`, `#else`, `#each`, `#empty`):
   * elements, text, expressions and blocks inside it, up to a `#` whose word
   * is one of `stops` (left for the caller), the end tag of the element the
   * block is in (left for that element), or the end of the page.
   */
  private parseBranch(stops: readonly TokenType[]): TemplateNode[] {
    const nodes: TemplateNode[] = [];
    // Formatting opened in a branch stays in it (activeFormatting).
    this.activeFormatting.push('marker');
    try {
    while (!this.curTokenIs(TokenType.EOF)) {
      // Comments first, so the `#` of a stop after one is seen.
      this.skipComments();
      if (this.curTokenIs(TokenType.HASH) && stops.includes(this.peekToken.type)) break;
      if (this.curTokenIs(TokenType.TAG_OPEN)) {
        this.nextToken();
        nodes.push(...this.parseChildElement());
      } else if (this.curTokenIs(TokenType.HASH)) {
        const block = this.parseControlFlow();
        if (block) nodes.push(block);
      } else if (this.curTokenIs(TokenType.EXPR_START)) {
        nodes.push(this.parseExpressionNode());
      } else if (this.curTokenIs(TokenType.TEXT)) {
        nodes.push(createTextNode(this.curToken.literal, this.currentLoc()));
        this.nextToken();
      } else if (this.curTokenIs(TokenType.TAG_END_OPEN)) {
        break;
      } else {
        this.nextToken();
      }
    }
    return nodes;
    } finally {
      this.activeFormatting.splice(this.activeFormatting.lastIndexOf('marker'));
    }
  }

  /**
   * A block that reached the end of its element, or of the page, with no
   * `#end`. It still ends there, as it always has; what changes is that the
   * page says so. Silently, everything after a forgotten `#end` was shown
   * only when the condition held, or once per item, and `#endif` — how other
   * template languages close a block — is words here and did the same.
   *
   * A warning and not an error: the page still runs, and an editor that can
   * write it back still can (the Builder treats an error as a page it cannot
   * write without loss).
   */
  private reportMissingEnd(block: '#if' | '#each', loc: SourceLocation): void {
    const where = this.curTokenIs(TokenType.EOF) ? 'the page' : 'the element it is in';
    let message = `This ${block} has no #end, so it runs to the end of ${where}. Write #end where it should stop`;
    const between = this.source.slice(loc.start, this.curToken.start);
    const other = /#(?:endif|endeach|endfor|end-if|end_if|\/if|\/each)\b/i.exec(between);
    if (other) {
      const line = loc.line + (between.slice(0, other.index).match(/\n/g)?.length ?? 0);
      message += ` ("${other[0]}" on line ${line} is not one: SoftN closes every block with #end)`;
    }
    this.diagnostics.push({ message, severity: 'warning', loc });
  }

  /**
   * Parse an each block
   */
  private parseEachBlock(): EachBlock {
    const loc = this.currentLoc();
    this.nextToken(); // consume 'each'

    this.expectToken(TokenType.LPAREN);

    // Parse item name (and optional index)
    let itemName = '';
    let itemPattern: BindingPattern | undefined;
    let indexName: string | undefined;

    if (this.curTokenIs(TokenType.LBRACKET) || this.curTokenIs(TokenType.EXPR_START)) {
      // `#each ([key, value] in Object.entries(totals))`, `#each ({ id, title }
      // in tasks)`: the item taken apart as it is bound. Read as the list or
      // record literal it looks like, then turned into a pattern; read as an
      // expression it would take the `in` for the operator.
      const patternLoc = this.currentLoc();
      const firstDiagnostic = this.diagnostics.length;
      const written = this.curTokenIs(TokenType.LBRACKET)
        ? this.parseArrayExpression()
        : this.parseObjectExpression();
      const pattern = this.toPattern(written);
      // Reported below in #each's own words.
      if (pattern) this.dropCoverDefaults(firstDiagnostic);
      if (!pattern) {
        this.diagnostics.push({
          message:
            'This is not something #each can take an item apart into. Write names in a list or a record, ' +
            'as in #each ([key, value] in entries) or #each ({ id, title } in tasks)',
          severity: 'error',
          loc: patternLoc,
        });
      } else if (patternHasDefault(pattern)) {
        this.diagnostics.push({
          message:
            'A default (name = value) is not read in the variable of an #each. ' +
            'Use ?? where the name is used: {title ?? "Untitled"}',
          severity: 'error',
          loc: patternLoc,
        });
      } else {
        itemPattern = pattern;
        itemName = patternText(pattern);
      }
    } else if (this.isIdentifierToken()) {
      itemName = this.curToken.literal;
      this.nextToken();
    }

    if (itemName !== '' && this.curTokenIs(TokenType.COMMA)) {
      this.nextToken();
      if (this.isIdentifierToken()) {
        indexName = this.curToken.literal;
        this.nextToken();
      }
    }

    // `in` in any case, as the rest of the header's words are (`#EACH (x IN xs)`).
    if (this.curTokenIs(TokenType.IDENTIFIER) && this.curToken.literal.toLowerCase() === 'in') this.nextToken();
    else this.expectToken(TokenType.IN);

    const iterable = this.parseExpression();

    this.expectToken(TokenType.RPAREN);
    this.reportPendingOperand();

    // Optional `key={expr}` after the header.
    //
    // The renderer has always had a branch for this and the development warning
    // recommends writing exactly it, but nothing ever parsed it — so the text
    // fell into the block body and rendered on the page.
    // Past the header the lexer is back in text mode, so `key=` arrives as a
    // TEXT token rather than an identifier and an equals.
    let keyExpression: Expression | undefined;
    if (
      this.curTokenIs(TokenType.TEXT) &&
      this.curToken.literal.trim().toLowerCase() === 'key=' &&
      this.peekToken.type === TokenType.EXPR_START
    ) {
      this.nextToken(); // consume `key=`
      this.expectToken(TokenType.EXPR_START);
      keyExpression = this.parseExpression();
      this.expectToken(TokenType.EXPR_END);
    }

    const body = this.parseBranch([TokenType.EMPTY, TokenType.END]);
    let emptyFallback: TemplateNode[] | undefined;

    // Check for #empty
    const peekType = this.peekToken.type;
    if (this.curTokenIs(TokenType.HASH) && peekType === TokenType.EMPTY) {
      this.nextToken();
      this.nextToken();

      // An #if or an #each inside #empty is read as one (parseBranch): this
      // branch once had a loop of its own with no rule for one, and
      // `#if (loading) … #else … #end` drew both of its branches.
      emptyFallback = this.parseBranch([TokenType.END]);
    }

    // Consume #end
    if (this.curTokenIs(TokenType.HASH) && this.peekToken.type === TokenType.END) {
      this.nextToken();
      this.nextToken();
    } else {
      this.reportMissingEnd('#each', loc);
    }

    return {
      type: 'EachBlock',
      iterable,
      itemName,
      // Absent for a plain name, so such a loop has the shape it always had.
      ...(itemPattern ? { itemPattern } : {}),
      indexName,
      keyExpression,
      body,
      emptyFallback,
      loc,
    };
  }

  /**
   * Parse an expression node (interpolation)
   */
  private parseExpressionNode(): ExpressionNode {
    const loc = this.currentLoc();
    this.expectToken(TokenType.EXPR_START);

    const expression = this.parseExpression();
    this.closeExpression();

    return { type: 'Expression', expression, loc };
  }

  /**
   * Parse an expression (simplified expression parser)
   */
  private parseExpression(): Expression {
    return this.parseAssignment();
  }

  /**
   * Assignment sits above the conditional, as in JavaScript: `x = a ? 1 : 2`
   * assigns the whole conditional, and `a = b = 1` groups to the right.
   *
   * There was no such rule. The documented one-line handler
   * `@click={() => count = count + 1}` therefore parsed as the arrow
   * `() => count`; the element's attribute loop then skipped the `=`, took
   * `count` as a boolean attribute and dropped `+ 1 }` token by token, and
   * the document said nothing about it — the button rendered and did
   * nothing when pressed. Every `{…}` now either reads to its `}` or is
   * reported (see closeExpression), and the assignment forms are read.
   *
   * Only an identifier or a member path can be assigned to. Anything else is
   * reported as a diagnostic rather than thrown, so the element it sits on
   * survives and the author is pointed at the target, not at the tag.
   */
  private parseAssignment(): Expression {
    const left = this.parseTernary();
    const operator = ASSIGNMENT_OPERATORS.get(this.curToken.type);
    if (operator === undefined) {
      return left;
    }

    const loc = left.loc;
    if (left.type !== 'Identifier' && left.type !== 'MemberExpression') {
      this.diagnostics.push({
        message: `Invalid assignment target: cannot assign to ${describeExpression(left)}`,
        severity: 'error',
        loc,
      });
    }
    this.nextToken(); // consume the operator
    const right = this.parseAssignment();
    return { type: 'AssignmentExpression', operator, left, right, loc };
  }

  private parseTernary(): Expression {
    const expr = this.parseNullishCoalescing();

    if (this.curTokenIs(TokenType.QUESTION)) {
      const loc = this.currentLoc();
      this.nextToken();
      const consequent = this.parseExpression();
      this.expectToken(TokenType.COLON);
      const alternate = this.parseExpression();

      return {
        type: 'ConditionalExpression',
        test: expr,
        consequent,
        alternate,
        loc,
      };
    }

    return expr;
  }

  /**
   * `a ?? b`, below `||` and `&&`. JavaScript refuses `??` beside an
   * unparenthesised `||` or `&&` (`a ?? b || c`), since readers take it either
   * way; it is read here as `a ?? (b || c)`, and the author is asked to say
   * which with parentheses.
   */
  private parseNullishCoalescing(): Expression {
    const first = this.curToken;
    let left = this.parseOr();

    while (this.curTokenIs(TokenType.NULLISH_COALESCE)) {
      const loc = this.currentLoc();
      this.nextToken();
      const rightFirst = this.curToken;
      const right = this.parseOr();
      if (isBareLogical(left, first) || isBareLogical(right, rightFirst)) {
        this.diagnostics.push({
          message: '"??" beside "||" or "&&" reads either way: write (a ?? b) || c or a ?? (b || c)',
          severity: 'warning',
          loc,
        });
      }
      left = { type: 'BinaryExpression', operator: '??', left, right, loc };
    }

    return left;
  }

  private parseOr(): Expression {
    let left = this.parseAnd();

    while (this.curTokenIs(TokenType.OR)) {
      const loc = this.currentLoc();
      this.nextToken();
      const right = this.parseAnd();
      left = { type: 'BinaryExpression', operator: '||', left, right, loc };
    }

    return left;
  }

  private parseAnd(): Expression {
    let left = this.parseEquality();

    while (this.curTokenIs(TokenType.AND)) {
      const loc = this.currentLoc();
      this.nextToken();
      const right = this.parseEquality();
      left = { type: 'BinaryExpression', operator: '&&', left, right, loc };
    }

    return left;
  }

  private parseEquality(): Expression {
    let left = this.parseComparison();

    while (
      this.curTokenIs(TokenType.EQ) ||
      this.curTokenIs(TokenType.NOT_EQ) ||
      this.curTokenIs(TokenType.EQ_STRICT) ||
      this.curTokenIs(TokenType.NOT_EQ_STRICT)
    ) {
      const loc = this.currentLoc();
      const operator = this.curToken.literal;
      this.nextToken();
      const right = this.parseComparison();
      left = { type: 'BinaryExpression', operator, left, right, loc };
    }

    return left;
  }

  private parseComparison(): Expression {
    let left = this.parseAdditive();

    // `in` and `instanceof` sit with the comparisons, as in JavaScript. The
    // renderer has always evaluated `instanceof`; nothing ever parsed it.
    while (
      this.curTokenIs(TokenType.LT) ||
      this.curTokenIs(TokenType.GT) ||
      this.curTokenIs(TokenType.LTE) ||
      this.curTokenIs(TokenType.GTE) ||
      this.curTokenIs(TokenType.IN) ||
      this.curTokenIs(TokenType.INSTANCEOF)
    ) {
      const loc = this.currentLoc();
      const operator = this.curToken.literal;
      this.nextToken();
      const right = this.parseAdditive();
      left = { type: 'BinaryExpression', operator, left, right, loc };
    }

    return left;
  }

  private parseAdditive(): Expression {
    let left = this.parseMultiplicative();

    while (this.curTokenIs(TokenType.PLUS) || this.curTokenIs(TokenType.MINUS)) {
      const loc = this.currentLoc();
      const operator = this.curToken.literal;
      this.nextToken();
      const right = this.parseMultiplicative();
      left = { type: 'BinaryExpression', operator, left, right, loc };
    }

    return left;
  }

  private parseMultiplicative(): Expression {
    let left = this.parseExponent();

    while (
      this.curTokenIs(TokenType.ASTERISK) ||
      this.curTokenIs(TokenType.SLASH) ||
      this.curTokenIs(TokenType.PERCENT)
    ) {
      const loc = this.currentLoc();
      const operator = this.curToken.literal;
      this.nextToken();
      const right = this.parseExponent();
      left = { type: 'BinaryExpression', operator, left, right, loc };
    }

    return left;
  }

  /**
   * `a ** b`, tighter than the multiplicative operators and grouping to the
   * right: `2 ** 3 ** 2` is `2 ** 9`.
   *
   * JavaScript refuses `-x ** 2` because the two readings give different
   * numbers. The same line is drawn here, as a diagnostic: the parse keeps
   * `(-x) ** 2` so there is something to render, and the author is told to
   * choose.
   */
  private parseExponent(): Expression {
    const base = this.curToken;
    const left = this.parseUnary();
    if (!this.curTokenIs(TokenType.EXPONENT)) {
      return left;
    }

    const loc = this.currentLoc();
    if (
      left.type === 'UnaryExpression' &&
      base.start === left.loc.start &&
      base.type !== TokenType.LPAREN
    ) {
      this.diagnostics.push({
        message:
          `Ambiguous "${left.operator}" before "**": write (${left.operator}x) ** y or ` +
          `${left.operator}(x ** y)`,
        severity: 'error',
        loc: left.loc,
      });
    }
    this.nextToken(); // consume **
    const right = this.parseExponent();
    return { type: 'BinaryExpression', operator: '**', left, right, loc };
  }

  private parseUnary(): Expression {
    if (
      this.curTokenIs(TokenType.BANG) ||
      this.curTokenIs(TokenType.MINUS) ||
      this.curTokenIs(TokenType.PLUS) ||
      this.curTokenIs(TokenType.TYPEOF) ||
      this.curTokenIs(TokenType.VOID)
    ) {
      const loc = this.currentLoc();
      const operator = this.curToken.literal;
      this.nextToken();
      const argument = this.parseUnary();
      return { type: 'UnaryExpression', operator, argument, prefix: true, loc };
    }

    // `++count`, `--count`
    if (this.curTokenIs(TokenType.INCREMENT) || this.curTokenIs(TokenType.DECREMENT)) {
      const loc = this.currentLoc();
      const operator = this.curToken.literal as '++' | '--';
      this.nextToken();
      const argument = this.parseUnary();
      this.checkUpdateTarget(argument, operator);
      return { type: 'UpdateExpression', operator, prefix: true, argument, loc };
    }

    return this.parseCallMember();
  }

  /** `count++` changes state, so its operand has to be somewhere state lives. */
  private checkUpdateTarget(target: Expression, operator: string): void {
    if (target.type === 'Identifier' || target.type === 'MemberExpression') return;
    this.diagnostics.push({
      message: `Invalid "${operator}" target: cannot change ${describeExpression(target)}`,
      severity: 'error',
      loc: target.loc,
    });
  }

  /**
   * `new Date()`, `new Date(task.due).getFullYear()`.
   *
   * The class is a name and any `.member` path after it; the first `(` is
   * the construction's own argument list, and what follows that is read by
   * the caller as a member chain on the new object.
   */
  private parseNew(): Expression {
    const loc = this.currentLoc();
    this.nextToken(); // consume 'new'

    if (!this.curTokenIs(TokenType.IDENTIFIER)) {
      throw new UnexpectedTokenError(this.curToken, TokenType.IDENTIFIER, this.source);
    }
    let callee: Expression = createIdentifier(this.curToken.literal, this.currentLoc());
    this.nextToken();
    while (this.curTokenIs(TokenType.DOT)) {
      const memberLoc = this.currentLoc();
      this.nextToken();
      if (!this.isPropertyName()) {
        throw new UnexpectedTokenError(this.curToken, TokenType.IDENTIFIER, this.source);
      }
      const property = createIdentifier(this.curToken.literal, this.currentLoc());
      this.nextToken();
      callee = { type: 'MemberExpression', object: callee, property, computed: false, loc: memberLoc };
    }

    const args = this.curTokenIs(TokenType.LPAREN) ? this.parseArguments() : [];
    return { type: 'NewExpression', callee, arguments: args, loc };
  }

  /**
   * The arguments of a call, from `(` to `)`. `...list` among them is a
   * SpreadElement, which the renderer lays out in place.
   */
  private parseArguments(): Expression[] {
    this.nextToken(); // consume (
    const args: Expression[] = [];

    while (!this.curTokenIs(TokenType.RPAREN) && !this.curTokenIs(TokenType.EOF)) {
      const argStart = this.curToken.start;
      args.push(this.curTokenIs(TokenType.SPREAD) ? this.parseSpread() : this.parseExpression());
      this.expectSeparator(TokenType.RPAREN, 'arguments');
      // `parsePrimary` falls back to a synthetic `undefined` without
      // consuming anything, so an argument it cannot start on otherwise
      // loops here forever, and the args array grows until the heap gives out.
      this.expectProgress(argStart, TokenType.RPAREN);
    }

    this.expectToken(TokenType.RPAREN);
    return args;
  }

  /** `...value`, in an array, an argument list or an object literal. */
  private parseSpread(): SpreadElement {
    const loc = this.currentLoc();
    this.nextToken(); // consume ...
    const argument = this.parseExpression();
    return { type: 'SpreadElement', argument, loc };
  }

  private parseCallMember(): Expression {
    let expr = this.curTokenIs(TokenType.NEW) ? this.parseNew() : this.parsePrimary();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this.curTokenIs(TokenType.DOT)) {
        const loc = this.currentLoc();
        this.nextToken();

        // Accept identifiers and keywords as property names (e.g., obj.data, obj.status)
        if (this.isPropertyName()) {
          const property = createIdentifier(this.curToken.literal, this.currentLoc());
          this.nextToken();
          expr = { type: 'MemberExpression', object: expr, property, computed: false, loc };
        } else {
          // Invalid token after dot — stop parsing member chain. `{user.}`
          // then read as `{user}` with nothing said; a closer here means the
          // name is missing (anything else is reported when the expression
          // is closed).
          this.holdMissingOperand('.');
          break;
        }
      } else if (this.curTokenIs(TokenType.OPTIONAL_CHAIN)) {
        // Optional chaining: obj?.prop or obj?.[expr] or obj?.()
        const loc = this.currentLoc();
        this.nextToken();

        if (this.isPropertyName()) {
          // obj?.prop (including keywords like obj?.data)
          const property = createIdentifier(this.curToken.literal, this.currentLoc());
          this.nextToken();
          expr = {
            type: 'MemberExpression',
            object: expr,
            property,
            computed: false,
            optional: true,
            loc,
          };
        } else if (this.curTokenIs(TokenType.LBRACKET)) {
          // obj?.[expr]
          this.nextToken();
          const property = this.parseExpression();
          this.expectToken(TokenType.RBRACKET);
          expr = {
            type: 'MemberExpression',
            object: expr,
            property,
            computed: true,
            optional: true,
            loc,
          };
        } else if (this.curTokenIs(TokenType.LPAREN)) {
          // obj?.()
          const args = this.parseArguments();
          expr = { type: 'CallExpression', callee: expr, arguments: args, optional: true, loc };
        } else {
          // Invalid token after ?. — stop parsing member chain
          this.holdMissingOperand('?.');
          break;
        }
      } else if (this.curTokenIs(TokenType.LBRACKET)) {
        const loc = this.currentLoc();
        this.nextToken();
        const property = this.parseExpression();
        this.expectToken(TokenType.RBRACKET);
        expr = { type: 'MemberExpression', object: expr, property, computed: true, loc };
      } else if (this.curTokenIs(TokenType.LPAREN)) {
        const loc = this.currentLoc();
        const args = this.parseArguments();
        expr = { type: 'CallExpression', callee: expr, arguments: args, loc };
      } else {
        break;
      }
    }

    // `count++`, `item.qty--`
    if (this.curTokenIs(TokenType.INCREMENT) || this.curTokenIs(TokenType.DECREMENT)) {
      const loc = expr.loc;
      const operator = this.curToken.literal as '++' | '--';
      this.checkUpdateTarget(expr, operator);
      this.nextToken();
      expr = { type: 'UpdateExpression', operator, prefix: false, argument: expr, loc };
    }

    return expr;
  }

  /**
   * The body of an arrow, after its `=>`.
   *
   * `() => { count++; save() }` is a block of statements. Its braces used to
   * be read as a record being made, so `{ save() }` called the record
   * `{ save }` and the button did nothing, and `{ a = 1; b = 2 }` ran half of
   * itself under a diagnostic about a record. A block is read as the
   * statements it holds, each an expression of the kind markup reads, ended
   * by a ";" or a new line, and an optional last `return`. What markup does
   * not read in one (`if`, `let`, a loop) leaves the block not run, and says
   * so with why. Braces that hold a record, `() => { label: v }`, are read as
   * the record they always were.
   */
  private parseArrowBody(): Pick<ArrowFunctionExpression, 'body' | 'statements' | 'returns'> {
    if (!this.curTokenIs(TokenType.EXPR_START) || this.bracesHoldARecord(this.curToken.start)) {
      return { body: this.parseExpression() };
    }
    const open = this.curToken;
    const loc = this.currentLoc();
    const firstDiagnostic = this.diagnostics.length;
    this.nextToken(); // consume {
    const statements: Expression[] = [];
    let returns: Expression | undefined;
    let cannot: string | null = null;
    while (!this.curTokenIs(TokenType.EXPR_END) && !this.curTokenIs(TokenType.EOF)) {
      if (this.curTokenIs(TokenType.SEMICOLON)) {
        this.nextToken();
        continue;
      }
      if (returns !== undefined) {
        cannot = 'nothing after a "return" would run';
        break;
      }
      const word = this.curToken.literal;
      if (NOT_READ_STATEMENTS.has(word) && !this.curTokenIs(TokenType.STRING)) {
        cannot = `"${word}" is a statement markup does not read`;
        break;
      }
      const statementStart = this.curToken.start;
      if (this.curTokenIs(TokenType.RETURN)) {
        this.nextToken();
        returns =
          this.curTokenIs(TokenType.SEMICOLON) || this.curTokenIs(TokenType.EXPR_END)
            ? createIdentifier('undefined', this.currentLoc())
            : this.parseExpression();
      } else {
        statements.push(this.parseExpression());
      }
      this.reportPendingOperand();
      // A statement markup could not read as an expression has said so in
      // its own words already.
      if (this.diagnostics.length > firstDiagnostic) break;
      if (this.curToken.start === statementStart) {
        cannot = `"${this.curToken.literal}" is not something markup reads`;
        break;
      }
      if (this.curTokenIs(TokenType.SEMICOLON) || this.curTokenIs(TokenType.EXPR_END)) continue;
      // A new line ends a statement, as JavaScript's own reading does.
      if (this.curToken.line > this.prevToken.line) continue;
      cannot = 'two statements on one line need a ";" between them';
      break;
    }
    const failed = cannot !== null || this.diagnostics.length > firstDiagnostic;
    // Past the block's own "}", wherever reading it stopped.
    let depth = 0;
    let end = this.curToken.end;
    while (!this.curTokenIs(TokenType.EOF)) {
      if (this.curTokenIs(TokenType.EXPR_START)) depth++;
      else if (this.curTokenIs(TokenType.EXPR_END) && depth-- === 0) {
        end = this.curToken.end;
        this.nextToken();
        break;
      }
      this.nextToken();
    }
    const body = this.source.slice(open.start, end);
    if (cannot !== null) {
      this.diagnostics.push({
        message:
          `This handler's { } body cannot run: ${cannot}. Markup runs a body's expressions one after another, ` +
          'as in @click={() => { count++; save() }}; anything more belongs in a logic function the handler calls',
        severity: 'warning',
        loc,
      });
    }
    if (failed) return { body };
    return returns === undefined ? { body, statements } : { body, statements, returns };
  }

  /**
   * Whether the braces at `at` hold a record rather than a block: nothing,
   * a spread, a computed key, or a key followed by ":", "," or the closing
   * brace. `() => { label: v }` has always been read as making a record, and
   * still is; JavaScript would read it as a label, and a page that wrote it
   * meant the record.
   */
  private bracesHoldARecord(at: number): boolean {
    const rest = this.source.slice(at + 1);
    const lead = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/.exec(rest)?.[0].length ?? 0;
    const after = rest.slice(lead);
    if (after.startsWith('}') || after.startsWith('...') || after.startsWith('[')) return true;
    const key = /^(?:[\p{ID_Start}$_][\p{ID_Continue}$_]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\d+(?:\.\d+)?)\s*([:,}])/u.exec(after);
    return key !== null;
  }

  private parsePrimary(): Expression {
    const loc = this.currentLoc();

    // Parenthesized expression or arrow function
    if (this.curTokenIs(TokenType.LPAREN)) {
      this.nextToken(); // consume (

      // Empty parens: () or () =>
      if (this.curTokenIs(TokenType.RPAREN)) {
        this.nextToken(); // consume )
        if (this.curTokenIs(TokenType.ARROW)) {
          this.nextToken();
          const body = this.parseArrowBody();
          return { type: 'ArrowFunctionExpression', params: [], ...body, async: false, loc };
        }
        return createIdentifier('undefined', loc);
      }

      // What is in the parentheses is read as a list of expressions, and
      // what follows the `)` says what it was. Before `=>` it is the
      // parameters of an arrow, each of which reads as an expression of the
      // same shape: a name, a default (`limit = 10`), a list or record to
      // take the argument apart (`[key, value]`, `{ id, title }`), a rest
      // (`...others`). Anything else is one expression in parentheses.
      //
      // Only names were read as parameters before, so the callback everyone
      // writes for `Object.entries(…)`, `([key, value]) => …`, was refused
      // with "expected RPAREN".
      const firstDiagnostic = this.diagnostics.length;
      const items: Expression[] = [];
      while (!this.curTokenIs(TokenType.RPAREN) && !this.curTokenIs(TokenType.EOF)) {
        const itemStart = this.curToken.start;
        items.push(this.curTokenIs(TokenType.SPREAD) ? this.parseSpread() : this.parseExpression());
        if (!this.curTokenIs(TokenType.COMMA)) break;
        this.nextToken();
        this.expectProgress(itemStart, TokenType.RPAREN);
      }
      this.expectToken(TokenType.RPAREN);

      if (this.curTokenIs(TokenType.ARROW)) {
        const patterns = this.toParams(items);
        if (patterns) {
          // A parameter such as `[a, b] = pair` was read as an assignment to
          // a list and reported as one; as a parameter it is a default.
          this.dropInvalidTargets(firstDiagnostic);
          this.dropCoverDefaults(firstDiagnostic);
          this.nextToken(); // consume =>
          const body = this.parseArrowBody();
          const params: string[] = [];
          for (const param of patterns) patternNames(param.pattern, params);
          const plain = patterns.every(
            (param) => param.pattern.type === 'NamePattern' && !param.default && !param.rest
          );
          return plain
            ? { type: 'ArrowFunctionExpression', params, ...body, async: false, loc }
            : { type: 'ArrowFunctionExpression', params, patterns, ...body, async: false, loc };
        }
        this.diagnostics.push({
          message:
            'This is not a parameter list an arrow can have. A parameter is a name, a name with a default ' +
            '(limit = 10), a list or record that takes the argument apart ([key, value], { id, title }), ' +
            'or a last ...rest',
          severity: 'error',
          loc,
        });
        this.nextToken(); // consume =>
        const body = this.parseArrowBody();
        return { type: 'ArrowFunctionExpression', params: [], ...body, async: false, loc };
      }

      if (items.length === 1 && items[0].type !== 'SpreadElement') {
        return items[0];
      }
      // `(a, b)` with no arrow after it: JavaScript's comma operator, which
      // a template has no use for. It used to be worth `undefined` with
      // nothing said.
      this.diagnostics.push({
        message:
          'Unexpected "," in parentheses: a comma here would make this a list of expressions, which is ' +
          'not read. For the parameters of an arrow, write => and its body after the ")"',
        severity: 'error',
        loc,
      });
      return createIdentifier('undefined', loc);
    }

    // Object literal
    if (this.curTokenIs(TokenType.EXPR_START)) {
      return this.parseObjectExpression();
    }

    // Array literal
    if (this.curTokenIs(TokenType.LBRACKET)) {
      return this.parseArrayExpression();
    }

    // Literals
    if (this.curTokenIs(TokenType.NUMBER)) {
      // Number, not parseFloat: `0xff` is 255, where parseFloat stops at the x.
      const value = Number(this.curToken.literal);
      const raw = this.curToken.literal;
      this.nextToken();
      return createLiteral(value, raw, loc);
    }

    if (this.curTokenIs(TokenType.STRING)) {
      const value = this.curToken.literal;
      this.nextToken();
      return createLiteral(value, `"${value}"`, loc);
    }

    if (this.curTokenIs(TokenType.TRUE)) {
      this.nextToken();
      return createLiteral(true, 'true', loc);
    }

    if (this.curTokenIs(TokenType.FALSE)) {
      this.nextToken();
      return createLiteral(false, 'false', loc);
    }

    if (this.curTokenIs(TokenType.NULL)) {
      this.nextToken();
      return createLiteral(null, 'null', loc);
    }

    // `undefined` is lexed as a keyword, and no rule here took one: written
    // out, `{value === undefined}` was a diagnostic about its own name.
    if (this.curTokenIs(TokenType.UNDEFINED)) {
      this.nextToken();
      return createIdentifier('undefined', loc);
    }

    if (this.curTokenIs(TokenType.BACKTICK)) {
      return this.parseTemplateLiteral();
    }

    // Identifier, or the parameter of an arrow written without parentheses:
    // `items.filter(t => t.done)`. That form was refused ("expected RPAREN"),
    // which is the first thing anyone coming from JavaScript writes.
    if (this.isIdentifierToken()) {
      const name = this.curToken.literal;
      this.nextToken();
      if (this.curTokenIs(TokenType.ARROW)) {
        this.nextToken();
        const body = this.parseArrowBody();
        return { type: 'ArrowFunctionExpression', params: [name], ...body, async: false, loc };
      }
      return createIdentifier(name, loc);
    }

    // Nothing here begins a value, and the synthetic `undefined` stands in.
    // For an empty expression (`{}`, `fn()`) that is the answer, and a stray
    // word is reported by whoever closes the expression. An operator is
    // neither: the rules above go on to apply it to the stand-in, so
    // `{/a+/.test(s)}` parsed as divisions of `undefined` and rendered NaN
    // with nothing said.
    //
    // One per expression, so one mistake is one diagnostic, and held until
    // the expression closes: `{count</Text>` has no closing brace, reads the
    // rest of the file as a comparison, and is the unclosed tag's diagnostic
    // to make, not a complaint about the `/` in `</Text>`.
    if (NEEDS_LEFT_OPERAND.has(this.curToken.type) && !this.pendingOperand) {
      const at = this.curToken;
      this.pendingOperand = {
        message:
          at.type === TokenType.SLASH
            ? 'Unexpected "/" where a value was expected: a regular expression literal is not ' +
              'supported in a template, so test the text in a logic function'
            : `Unexpected "${at.literal}" where a value was expected: nothing is on its left`,
        severity: 'error',
        loc,
      };
    } else if (NEEDS_RIGHT_OPERAND.has(this.prevToken.type)) {
      // The mirror case: the operator is there and what it applies to is not.
      this.holdMissingOperand(this.prevToken.literal);
    }
    return createIdentifier('undefined', loc);
  }

  /**
   * Hold a diagnostic for a value that should follow `after` and does not,
   * when what stands in its place closes the expression. Held like the one
   * above: once per expression, and dropped if the expression never closes.
   */
  private holdMissingOperand(after: string): void {
    if (this.pendingOperand || !CLOSES_EXPRESSION.has(this.curToken.type)) return;
    this.pendingOperand = {
      message: `Nothing follows "${after}": a value was expected before "${this.curToken.literal}"`,
      severity: 'error',
      loc: this.currentLoc(),
    };
  }

  private parseTemplateLiteral(): Expression {
    const loc = this.currentLoc();
    this.expectToken(TokenType.BACKTICK);

    const quasis: Array<{
      type: 'TemplateElement';
      value: { raw: string; cooked: string };
      tail: boolean;
      loc: SourceLocation;
    }> = [];
    const expressions: Expression[] = [];

    while (!this.curTokenIs(TokenType.EOF) && !this.curTokenIs(TokenType.BACKTICK)) {
      if (this.curTokenIs(TokenType.TEMPLATE_STRING)) {
        const value = this.curToken.literal;
        quasis.push({
          type: 'TemplateElement',
          value: { raw: value, cooked: value },
          tail: false,
          loc: this.currentLoc(),
        });
        this.nextToken();
        continue;
      }

      if (this.curTokenIs(TokenType.TEMPLATE_EXPR_START)) {
        if (quasis.length === expressions.length) {
          quasis.push({
            type: 'TemplateElement',
            value: { raw: '', cooked: '' },
            tail: false,
            loc: this.currentLoc(),
          });
        }
        this.nextToken();
        expressions.push(this.parseExpression());
        this.expectToken(TokenType.EXPR_END);
        continue;
      }

      // Unexpected token inside template literal
      break;
    }

    if (this.curTokenIs(TokenType.BACKTICK)) {
      this.nextToken();
    } else {
      this.addDiagnostic(new SoftNParseError('Unterminated template literal', loc, this.source));
    }

    if (quasis.length <= expressions.length) {
      quasis.push({
        type: 'TemplateElement',
        value: { raw: '', cooked: '' },
        tail: true,
        loc,
      });
    } else if (quasis.length > 0) {
      quasis[quasis.length - 1].tail = true;
    }

    return { type: 'TemplateLiteral', quasis, expressions, loc };
  }

  private parseObjectExpression(): Expression {
    const loc = this.currentLoc();
    this.nextToken(); // consume {

    const properties: ObjectExpression['properties'] = [];

    while (!this.curTokenIs(TokenType.EXPR_END) && !this.curTokenIs(TokenType.EOF)) {
      if (this.curTokenIs(TokenType.SPREAD)) {
        // `{ ...base, color: "red" }`
        properties.push(this.parseSpread());
      } else if (this.curTokenIs(TokenType.LBRACKET)) {
        // `{ [field]: value }`: the key is worked out when the object is
        // made, which is how one field of a record is replaced by name:
        // `filters = { ...filters, [name]: value }`.
        const keyLoc = this.currentLoc();
        this.nextToken(); // consume [
        const computedKey = this.parseExpression();
        this.expectToken(TokenType.RBRACKET);
        this.expectToken(TokenType.COLON);
        const value = this.parseExpression();
        properties.push({ type: 'ObjectProperty', key: '', computedKey, value, shorthand: false, loc: keyLoc });
      } else if (
        this.curTokenIs(TokenType.IDENTIFIER) ||
        this.curTokenIs(TokenType.STRING) ||
        this.curTokenIs(TokenType.NUMBER) ||
        this.isPropertyName()
      ) {
        const keyLoc = this.currentLoc();
        // A numeric key is the string JavaScript would make of it: `{ 1: "a" }`.
        const key = this.curTokenIs(TokenType.NUMBER)
          ? String(Number(this.curToken.literal))
          : this.curToken.literal;
        this.nextToken();

        if (this.curTokenIs(TokenType.COLON)) {
          this.nextToken();
          const value = this.parseExpression();
          properties.push({ type: 'ObjectProperty', key, value, shorthand: false, loc: keyLoc });
        } else if (this.curTokenIs(TokenType.EQUALS)) {
          // `{ minutes = 0 }`: a name with a default, which only a pattern
          // has (`({ minutes = 0 }) => …`); in a record that is being made
          // it means nothing. Which this is cannot be known until what
          // follows the record has been read, so it is read as the pattern
          // would read it and reported, and whoever turns the record into a
          // pattern takes the report back (see dropCoverDefaults).
          this.nextToken(); // consume =
          const fallback = this.parseExpression();
          this.diagnostics.push({ message: COVER_DEFAULT_MESSAGE, severity: 'error', loc: keyLoc });
          properties.push({
            type: 'ObjectProperty',
            key,
            value: {
              type: 'AssignmentExpression',
              operator: '=',
              left: createIdentifier(key, keyLoc),
              right: fallback,
              loc: keyLoc,
            },
            shorthand: true,
            loc: keyLoc,
          });
        } else {
          // Shorthand
          properties.push({
            type: 'ObjectProperty',
            key,
            value: createIdentifier(key, keyLoc),
            shorthand: true,
            loc: keyLoc,
          });
        }
      } else if (!this.curTokenIs(TokenType.COMMA)) {
        // Unexpected token - break to avoid infinite loop
        break;
      }

      this.expectSeparator(TokenType.EXPR_END, 'record fields');
    }

    // Consume closing }
    if (this.curTokenIs(TokenType.EXPR_END)) {
      this.nextToken();
    }
    return { type: 'ObjectExpression', properties, loc };
  }

  private parseArrayExpression(): Expression {
    const loc = this.currentLoc();
    this.nextToken(); // consume [

    const elements: Expression[] = [];

    while (!this.curTokenIs(TokenType.RBRACKET) && !this.curTokenIs(TokenType.EOF)) {
      const before = this.curToken;
      // `[...done, item]`: the renderer has always laid a SpreadElement out in
      // place here; no rule produced one.
      elements.push(this.curTokenIs(TokenType.SPREAD) ? this.parseSpread() : this.parseExpression());
      if (this.curToken !== before) {
        this.expectSeparator(TokenType.RBRACKET, 'list items');
      } else if (!this.curTokenIs(TokenType.RBRACKET)) {
        // Token didn't advance - break to avoid infinite loop
        break;
      }
    }

    this.expectToken(TokenType.RBRACKET);

    return { type: 'ArrayExpression', elements, loc };
  }

  // =========================================================================
  // Patterns
  // =========================================================================

  /**
   * The parameters an arrow has, from the expressions its parentheses were
   * read as, or null when one of them is not something a parameter can be.
   */
  private toParams(items: Expression[]): ParamPattern[] | null {
    const params: ParamPattern[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type === 'SpreadElement') {
        // `...rest` gathers what is left, so nothing can follow it.
        const pattern = i === items.length - 1 ? this.toPattern(item.argument) : null;
        if (!pattern) return null;
        params.push({ pattern, rest: true });
        continue;
      }
      const target = this.toTarget(item);
      if (!target) return null;
      params.push(target);
    }
    // One name bound twice would make the later one unreachable by position.
    const names: string[] = [];
    for (const param of params) patternNames(param.pattern, names);
    return new Set(names).size === names.length ? params : null;
  }

  /** A pattern with its default, from `name`, `name = value`, `[a, b]` or `{ a, b }`. */
  private toTarget(expr: Expression): BindingTarget | null {
    if (expr.type === 'AssignmentExpression') {
      if (expr.operator !== '=') return null;
      const pattern = this.toPattern(expr.left);
      return pattern ? { pattern, default: expr.right } : null;
    }
    const pattern = this.toPattern(expr);
    return pattern ? { pattern } : null;
  }

  /** The pattern an expression spells, or null when it spells none. */
  private toPattern(expr: Expression): BindingPattern | null {
    if (expr.type === 'Identifier') {
      // `undefined` is what the parser puts where it found nothing to read.
      return expr.name === 'undefined' ? null : { type: 'NamePattern', name: expr.name };
    }
    if (expr.type === 'ArrayExpression') {
      const elements: BindingTarget[] = [];
      let rest: BindingPattern | undefined;
      for (let i = 0; i < expr.elements.length; i++) {
        const element = expr.elements[i];
        if (element.type === 'SpreadElement') {
          const pattern = i === expr.elements.length - 1 ? this.toPattern(element.argument) : null;
          if (!pattern) return null;
          rest = pattern;
          continue;
        }
        const target = this.toTarget(element);
        if (!target) return null;
        elements.push(target);
      }
      return rest ? { type: 'ArrayPattern', elements, rest } : { type: 'ArrayPattern', elements };
    }
    if (expr.type === 'ObjectExpression') {
      const properties: Array<{ key: string; value: BindingTarget }> = [];
      let rest: string | undefined;
      for (let i = 0; i < expr.properties.length; i++) {
        const property = expr.properties[i];
        if (property.type === 'SpreadElement') {
          if (i !== expr.properties.length - 1 || property.argument.type !== 'Identifier') return null;
          rest = property.argument.name;
          continue;
        }
        if (property.computedKey) return null;
        const value = this.toTarget(property.value);
        if (!value) return null;
        properties.push({ key: property.key, value });
      }
      return rest !== undefined
        ? { type: 'ObjectPattern', properties, rest }
        : { type: 'ObjectPattern', properties };
    }
    return null;
  }

  /** Take back the reports of `{ name = value }` made since `from`: the record turned out to be a pattern. */
  private dropCoverDefaults(from: number): void {
    for (let i = this.diagnostics.length - 1; i >= from; i--) {
      if (this.diagnostics[i].message === COVER_DEFAULT_MESSAGE) this.diagnostics.splice(i, 1);
    }
  }

  /** Take back the "Invalid assignment target" diagnostics made since `from`. */
  private dropInvalidTargets(from: number): void {
    for (let i = this.diagnostics.length - 1; i >= from; i--) {
      if (this.diagnostics[i].message.startsWith('Invalid assignment target')) {
        this.diagnostics.splice(i, 1);
      }
    }
  }

  // =========================================================================
  // Helper methods
  // =========================================================================

  private nextToken(): void {
    this.prevToken = this.curToken;
    this.curToken = this.peekToken;
    this.peekToken = this.pullToken();
  }

  /**
   * The next token, reading past a comment that sits inside `{…}` or a
   * control-flow header. Between nodes a comment is a token the node loops
   * skip; inside an expression no rule expects one, so a block comment as
   * the whole of an interpolation, or `{total // of the visible rows}`,
   * ended the expression where the comment began. The lexer still emits it,
   * so a tool that lists comments sees it.
   */
  private pullToken(): Token {
    let token = this.lexer.nextToken();
    while (token.type === TokenType.COMMENT && this.lexer.inExpressionContext()) {
      token = this.lexer.nextToken();
    }
    this.noteMistakesIn(token);
    return token;
  }

  /**
   * Two things written in a page's words that do not do what was meant, said
   * where they are written. Every token passes here once, as it is read.
   *
   * - `// note</p>`: in markup `//` begins a comment wherever a new piece of
   *   the page begins (after an expression or an element too), and the
   *   comment runs to the end of the line, closing tag and all. What was said
   *   was a mismatched tag at the parent's closing tag, lines away. A line of
   *   markup commented out, `// <Button>Save</Button>`, opens what it closes
   *   and is not this.
   * - `#elif` and `#elsif` at the start of a line: other template languages'
   *   `#elseif`. Not a block here, so they were words, drawn inside the
   *   branch before them along with the branch they meant to start.
   */
  private noteMistakesIn(token: Token): void {
    if (token.type === TokenType.COMMENT && this.source.startsWith('//', token.start)) {
      const closing = /<\/([A-Za-z][\w.:-]*)\s*>/.exec(token.literal);
      if (closing && !token.literal.slice(0, closing.index).includes(`<${closing[1]}`)) {
        const words = token.literal.slice(0, closing.index).trim();
        this.diagnostics.push({
          message:
            `This // comment runs to the end of its line and takes the "${closing[0]}" after it with it. ` +
            `Put the comment on a line of its own, or write the words in braces, as in {"// ${words}"}`,
          severity: 'error',
          loc: { line: token.line, column: token.column, start: token.start, end: token.end },
        });
      }
      return;
    }
    if (token.type !== TokenType.TEXT) return;
    const written = this.source.slice(token.start, token.end);
    for (const match of written.matchAll(/#(elif|elsif)\b/g)) {
      const at = token.start + match.index;
      const lineStart = this.source.lastIndexOf('\n', at - 1) + 1;
      if (this.source.slice(lineStart, at).trim() !== '') continue;
      const line = token.line + (this.source.slice(token.start, at).match(/\n/g)?.length ?? 0);
      this.diagnostics.push({
        message: `"${match[0]}" is not a SoftN block, so it is shown as words: write #elseif (or #else if)`,
        severity: 'warning',
        loc: { line, column: at - lineStart + 1, start: at, end: at + match[0].length },
      });
    }
  }

  private curTokenIs(type: TokenType): boolean {
    return this.curToken.type === type;
  }

  /**
   * The `,` between two of a list's `what` (arguments, list items, record
   * fields), consumed; or the list's `closer`, left for the list. Anything
   * else is a missing comma, reported and read past as if it were there: `f(a b)`
   * and `[0 b101]` were two arguments and two items with nothing said, which
   * is how `0b101`, before the lexer read it, became `0` and a name.
   */
  private expectSeparator(closer: TokenType, what: string): void {
    if (this.curTokenIs(TokenType.COMMA)) {
      this.nextToken();
      return;
    }
    if (this.curTokenIs(closer) || this.curTokenIs(TokenType.EOF)) return;
    this.diagnostics.push({
      message: `A "," is missing before "${this.curToken.literal}": ${what} are separated by commas`,
      severity: 'error',
      loc: this.currentLoc(),
    });
  }

  private expectToken(type: TokenType): void {
    if (!this.curTokenIs(type)) {
      throw new UnexpectedTokenError(this.curToken, type, this.source);
    }
    this.nextToken();
  }

  /**
   * Consume the `}` that ends an attribute value, a handler, a binding, an
   * inline `if=` / `each=` or an interpolation — or say why it cannot.
   *
   * Every one of those sites used to read `if (EXPR_END) nextToken()` and
   * otherwise carry on. So when the expression rules stopped before the
   * brace, whatever remained was handed back to the surrounding loop: on an
   * element, the tokens turned into boolean attributes or were skipped one
   * by one; between children, they were skipped. `<Text v={a b}>` gave
   * `v={a}` plus an attribute `b`, and the document said nothing — the
   * Builder detected the loss by re-parsing every `{…}` on its own.
   *
   * Now the unread tail is a diagnostic at the first token the parser could
   * not place, and it is skipped as a whole up to the brace that closes this
   * expression (nested braces — an object literal in the tail — are kept
   * balanced). What was read stays on the node, so a preview still has
   * something to show; what was not is named, not silently made into
   * attributes.
   */
  private closeExpression(): void {
    if (this.curTokenIs(TokenType.EOF)) {
      // A missing `}` is the unclosed tag's diagnostic, not this one's.
      this.pendingOperand = null;
      return;
    }
    this.reportPendingOperand();
    if (this.curTokenIs(TokenType.EXPR_END)) {
      this.nextToken();
      return;
    }
    const at = this.curToken;
    this.diagnostics.push({
      message:
        `Unexpected token "${at.literal}" (${at.type}) in expression: ` +
        'the rest of the expression up to its closing "}" is not supported here and was not read',
      severity: 'error',
      loc: this.currentLoc(),
    });
    let depth = 0;
    while (!this.curTokenIs(TokenType.EOF)) {
      if (this.curTokenIs(TokenType.EXPR_START)) {
        depth++;
      } else if (this.curTokenIs(TokenType.EXPR_END)) {
        if (depth === 0) {
          this.nextToken();
          return;
        }
        depth--;
      }
      this.nextToken();
    }
  }

  /** Record the held missing-value diagnostic, if the expression made one. */
  private reportPendingOperand(): void {
    if (this.pendingOperand) {
      this.diagnostics.push(this.pendingOperand);
      this.pendingOperand = null;
    }
  }

  /** Skip from the `{` under the cursor to past the `}` that closes it. */
  private skipBracedRegion(): void {
    let depth = 0;
    while (!this.curTokenIs(TokenType.EOF)) {
      if (this.curTokenIs(TokenType.EXPR_START)) {
        depth++;
      } else if (this.curTokenIs(TokenType.EXPR_END)) {
        depth--;
        if (depth <= 0) {
          this.nextToken();
          return;
        }
      }
      this.nextToken();
    }
  }

  /**
   * Fail a list loop that consumed nothing this pass.
   *
   * Loops that only advance on the tokens they expect spin forever on anything
   * else, and `parse()` runs on every render and every keystroke in the live
   * preview — so an unsupported construct or a half-typed one took the tab with
   * it rather than showing an error. `expected` names what would have been
   * valid here, which is what the reader needs to fix it.
   */
  private expectProgress(startPos: number, expected: TokenType): void {
    if (this.curToken.start === startPos) {
      throw new UnexpectedTokenError(this.curToken, expected, this.source);
    }
  }

  private currentLoc(): SourceLocation {
    return {
      line: this.curToken.line,
      column: this.curToken.column,
      start: this.curToken.start,
      end: this.curToken.end,
    };
  }

  private skipComments(): void {
    while (this.curTokenIs(TokenType.COMMENT)) {
      this.nextToken();
    }
  }

  /**
   * Check if current token is a keyword that can be used as an attribute name
   * This handles cases like `data={...}` where 'data' is a keyword but should be
   * parsed as an attribute when used inside element tags
   */
  private isAttributeKeyword(): boolean {
    const attributeKeywords = [
      TokenType.COLLECTION, // collection="records" - SmartForm persistence
      TokenType.DATA, // data={...}
      TokenType.STYLE, // style="..."
      TokenType.SLOT, // slot="..."
      TokenType.FROM, // from="..."
      TokenType.IN, // in (though rare as attribute)
      TokenType.ASYNC, // async (for async handlers)
      TokenType.IF, // if={condition} - inline conditional
      TokenType.EACH, // each={items} - inline loop
    ];
    return attributeKeywords.includes(this.curToken.type);
  }

  /**
   * Whether `token` names a variable: an identifier, or a word that is a
   * keyword only in markup (see CONTEXTUAL_KEYWORDS).
   */
  private isIdentifierToken(token: Token = this.curToken): boolean {
    return token.type === TokenType.IDENTIFIER || CONTEXTUAL_KEYWORDS.has(token.type);
  }

  /**
   * Whether `token` can be part of what follows the colon in `class:name` or
   * `style:property`: a word, a number or a hyphen.
   */
  private isNamePiece(token: Token): boolean {
    return (
      token.type === TokenType.MINUS ||
      token.type === TokenType.NUMBER ||
      /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(token.literal)
    );
  }

  /**
   * Check if the current token can be used as a property name
   * In JavaScript, keywords can be used as property names (obj.data, obj.if, etc.)
   */
  private isPropertyName(): boolean {
    if (this.curToken.type === TokenType.IDENTIFIER) return true;
    // All keyword tokens store their text in `literal` (e.g., "data", "if", "true"),
    // which are all valid JS identifier strings. This automatically supports all
    // current and future keywords as property names (obj.data, obj.if, etc.).
    const lit = this.curToken.literal;
    if (!lit) return false;
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(lit);
  }
}

/**
 * Parse a SoftN source string
 */
export function parse(source: string): SoftNDocument {
  const parser = new Parser(source);
  return parser.parse();
}

/**
 * The shape of what `parse` produces, as a number a cache can key on.
 *
 * `parseCached` (parse-cache.ts) hands the same document to every stage that
 * asks for the same source, and keeps it for the next asker. So a change in
 * what `parse` returns for a given source — a node gaining a field, a
 * construct read differently, a diagnostic added — must bump this, or a
 * document parsed under the old rules is served to a renderer written for
 * the new ones. Nothing in this file reads it; it is the parser's promise to
 * its callers about the output, not the input.
 */
// 2: AssignmentExpression nodes, and a diagnostic for any `{…}` the parser
//    could not read to its closing brace (which previously became attributes).
// 3: Preserve collection attributes on components (SmartForm persistence).
// 4: Preserve hyphenated attributes, including aria-* and data-*.
// 5: The expression forms a JavaScript author writes first: arrows without
//    parentheses, spread in arrays, calls and object literals, `++`/`--`,
//    `**`, `in`, `instanceof`, `new`, `undefined` and comments inside `{…}`;
//    `#else if`; event modifiers (`@submit.prevent`); and a diagnostic for a
//    `{…}` among attributes, which used to become a boolean attribute.
// 6: Arrow parameters that take their argument apart (`([key, value]) => …`,
//    `({ id }) => …`), have a default or gather the rest; the same patterns
//    as the variable of an `#each`; computed keys (`{ [name]: value }`);
//    `#if` and `#each` inside `#empty`, which used to be read as text; and
//    diagnostics for `(a, b)` without an arrow and for `else` as an attribute.
// 7: Entities in a quoted attribute are read (`title="&quot;x&quot;"`), and a
//    numeric reference that names no character is U+FFFD instead of a throw.
//    Whitespace after an element is read as whitespace after an expression
//    is: `<b>bold</b> and more` keeps its space, and on one line between two
//    elements, or an element and an expression, it is a text node of one space.
// 8: A page's `<style>` blocks are one stylesheet and its `<data>` blocks one
//    set of declarations, in the order written. The last block of either used
//    to replace the ones before it.
// 9: A page can be written as an HTML page is. `<!DOCTYPE>` is a comment;
//    `<html>`, `<head>` and `<body>` are read through (a `<body>` with
//    attributes is a `<div>`) and the head's `<title>` is the document's
//    `title`; `<br>`, `<img>`, `<input>` and the other void elements end with
//    their tags; `<my-card>` is one tag name; `<script>`, `<logic>` and
//    `<style>` inside an element, or spelled with a capital, are the page's
//    blocks; `<script src>` and a `<script type>` that is not code are no
//    block; `onclick="…"` and `@click="…"` are handlers; and text inside
//    `<pre>` and `<textarea>` keeps its whitespace.
// 10: An `onclick="…"` whose code SoftN does not read stays an attribute
//    (it was dropped), for the document a browser-style page is given; and
//    a backslash in a quoted attribute of an HTML element is a backslash
//    (`pattern="\d{3}"`), not the start of an escape; and an HTML element
//    whose end tag may be left out (`<li>`, `<p>`, `<td>`…) ends where HTML
//    ends it, where it held the rest of the page.
// 11: HTML5's reading, and SoftN's syntax in any case. `#IF`/`#Else If`/
//    `#END`, `IN` and `KEY=`, `<IMPORT … FROM>`, `<DATA>`/`<COLLECTION>`, event
//    and binding names and modifiers; end tags in any case; `<DIV>` and `<BR>`
//    lowered, and an HTML element's attribute names (`ONCLICK`, `TabIndex`),
//    its first of a name written twice kept, and `onClick={…}` an event.
//    Unquoted values read whole (`src=a.png`); `<textarea>`/`<title>` text
//    and CDATA read as text; a table's implied `<tbody>` and a row around
//    cells; a heading, link or button ending one still open; an end tag
//    closing what is open inside its element (formatting elements opened
//    again after it); `</p>` and `</br>` as elements; `<image>` as `<img>`;
//    references without `;` and HTML5's other names. `as=` is a prop unless
//    the element has `each=`.
// 12: Misnested HTML read as HTML5's tree builder reads it: its list of
//    active formatting elements (opened again before text and inline
//    elements, not space alone; three of a kind and 64 in all at most; not
//    out of a cell, a component or a block's branch) and its adoption agency
//    (`<b><div>a</b>c` moves the div out of the b, inside copies of the
//    formatting elements between); an `<a>` or `<nobr>` ending its like;
//    end tags that stop at a block or a table's scope; what ends an `<svg>`
//    or `<math>`, inside which HTML's start-tag rules do not hold; what a
//    table moves before itself, and its own tags inside that; a table at a
//    table; `<rt>` and `<optgroup>` ending their like only in a ruby or a
//    select, and a ruby's annotation ending a paragraph left open. Nesting
//    deeper than 512 elements is placed beside the 512th.
// 13: Numbers as JavaScript writes them (`.5`, `3.`, `0b101`, `0o17`,
//    `1_000`), where `0b101` was `0` and a name; a missing comma between
//    arguments, list items or record fields is an error, where it was read
//    as if there; `??` beside a bare `||` or `&&` is a warning. `<!-->`,
//    `<!--->` and `--!>` end a comment as HTML ends one, and `<xmp>`,
//    `<iframe>`, `<noembed>` and `<noframes>` hold text, as `<textarea>` does.
export const PARSER_VERSION = 13;

/**
 * An element's attributes as HTML compares them for Noah's Ark: names and
 * values, an expression's by what it is, not where it was written.
 */
function attributesKey(element: ElementNode): string {
  return JSON.stringify(element.props.map((prop) => [prop.name, prop.value]), (key, value: unknown) => (key === 'loc' ? undefined : value));
}

/** A formatting element's copy: its tag, attributes and events, holding nothing yet. */
function copyElement(element: ElementNode, loc: SourceLocation): ElementNode {
  const copy = createElementNode(element.tag, loc);
  copy.props = element.props.map((prop) => ({ ...prop }));
  copy.events = element.events.map((event) => ({ ...event }));
  return copy;
}

/** Whether the end tag `closer` ends the open element `open`: its own, in any case, and any heading's a heading. */
function closesElement(closer: string, open: string): boolean {
  return sameTagName(closer, open) || (HEADINGS.has(closer) && HEADINGS.has(open));
}

/** Whether `expr`, read from the token `first`, is an `||` or `&&` not written in parentheses. */
function isBareLogical(expr: Expression, first: Token): boolean {
  return expr.type === 'BinaryExpression' && (expr.operator === '||' || expr.operator === '&&') && first.type !== TokenType.LPAREN;
}

/** How many elements deep a page is read before what is deeper is placed beside them, as browsers cap it. */
const MAX_TREE_DEPTH = 512;
/** How many formatting elements may be active at once after the last marker (see activate). */
const MAX_ACTIVE_FORMATTING = 64;
/** Where a marker goes in the list of active formatting elements: what is opened inside stays inside. */
const FORMATTING_MARKERS = new Set(['td', 'th', 'caption', 'applet', 'object', 'marquee', 'template']);
/** HTML's special elements before which the active formatting elements are opened again all the same. */
const REOPENS_FORMATTING = new Set(['area', 'br', 'embed', 'img', 'keygen', 'wbr', 'input', 'applet', 'marquee', 'object', 'math', 'svg', 'button', 'select', 'xmp']);
/** A ruby's annotations and their containers. */
const RUBY_ANNOTATIONS = new Set(['rb', 'rp', 'rt', 'rtc']);
/** What HTML ends without its end tag before an annotation in a ruby ("generate implied end tags"). */
const IMPLIED_END_TAGS = new Set(['dd', 'dt', 'li', 'optgroup', 'option', 'p', 'rb', 'rp', 'rt', 'rtc']);

/** The HTML elements that end a drawing they are written in (HTML's "breakout" start tags in foreign content). */
const BREAKS_OUT_OF_DRAWING = new Set([
  'b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'embed', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'head', 'hr', 'i', 'img', 'li', 'listing', 'menu', 'meta', 'nobr', 'ol', 'p', 'pre', 'ruby', 's',
  'small', 'span', 'strong', 'strike', 'sub', 'sup', 'table', 'tt', 'u', 'ul', 'var',
]);
/**
 * HTML's "special" elements, the ones it gives structure: what an `<li>`,
 * `<dt>` or `<dd>` does not end its like through, what an inline element's
 * end tag does not reach past (endTagStopped), and the blocks a formatting
 * element's end tag moves out of it (adoptBlock).
 */
const SPECIAL_ELEMENTS = new Set([
  'address', 'applet', 'area', 'article', 'aside', 'base', 'basefont', 'bgsound', 'blockquote', 'body', 'br', 'button',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dir', 'div', 'dl', 'dt', 'embed', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr',
  'html', 'iframe', 'img', 'input', 'keygen', 'li', 'link', 'listing', 'main', 'marquee', 'menu', 'meta', 'nav',
  'noembed', 'noframes', 'noscript', 'object', 'ol', 'p', 'param', 'plaintext', 'pre', 'script', 'search', 'section',
  'select', 'source', 'style', 'summary', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul', 'wbr', 'xmp', 'svg', 'math',
]);
/** What an element is not found open through (HTML's default scope), and the drawings' places that hold HTML. */
const DEFAULT_SCOPE_BOUNDARIES = new Set([
  'applet', 'caption', 'html', 'marquee', 'object', 'table', 'td', 'th', 'template',
  'mi', 'mo', 'mn', 'ms', 'mtext', 'annotation-xml', 'foreignObject', 'desc', 'title',
]);
/** What a paragraph is not ended through (HTML's "button scope"). */
const BUTTON_SCOPE_BOUNDARIES = new Set([...DEFAULT_SCOPE_BOUNDARIES, 'button']);
/** What a list item is not ended through (HTML's "list item scope"). */
const LIST_ITEM_SCOPE_BOUNDARIES = new Set([...DEFAULT_SCOPE_BOUNDARIES, 'ol', 'ul']);
/** What a table's own end tags are not read through (HTML's "table scope"). */
const TABLE_SCOPE_BOUNDARIES = new Set(['html', 'table', 'template']);
/** What holds a table's rows: an element written straight in one is moved before the table (fostersOut). */
const ROW_PARENTS = new Set(['table', 'tbody', 'thead', 'tfoot', 'tr']);
/** A table and its parts, whose end tags reach through its cells. */
const TABLE_PARTS = new Set(['table', 'caption', 'colgroup', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th']);
/** In openTags, a formatting element whose end tag has been read inside a block it holds (adoptBlock). */
const ADOPTED = '#adopted';
/** The places in a drawing that hold HTML (HTML's integration points), in lower case. */
const HOLDS_HTML_IN_DRAWING = new Set(['foreignobject', 'desc', 'title', 'mi', 'mo', 'mn', 'ms', 'mtext', 'annotation-xml']);
/**
 * What may stand straight in a `<table>`. Anything else HTML gives an
 * element, and text, goes before the table (HTML's "foster parenting"); a
 * component, a block and an expression stay, as each may draw rows.
 */
const TABLE_CONTENT = new Set(['caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'script', 'style', 'template', 'form', 'input']);

/**
 * HTML elements whose end tag may be left out (the HTML standard's "optional
 * end tags"), and what ends one when it is.
 */
const OPTIONAL_END_TAGS = new Set([
  'li', 'dt', 'dd', 'p', 'option', 'optgroup', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'colgroup', 'rb', 'rt',
  'rtc', 'rp',
]);
/** The start tags that close an open `<p>`, as HTML's parser closes one. */
const ENDS_A_PARAGRAPH = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir', 'div', 'dl', 'dd', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr',
  'li', 'listing', 'main', 'menu', 'nav', 'ol', 'p', 'plaintext', 'pre', 'search', 'section', 'summary', 'table',
  'ul', 'xmp',
]);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
/** What a table's caption ends at, unclosed: the table's structure. */
const ENDS_A_CAPTION = new Set(['caption', 'col', 'colgroup', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr']);
/** HTML's formatting elements: an end tag out of order opens them again (see parseChildren). */
const FORMATTING_ELEMENTS = new Set([
  'a', 'b', 'big', 'code', 'em', 'font', 'i', 'nobr', 's', 'small', 'strike', 'strong', 'tt', 'u',
]);

/**
 * A run of `children` that `belongs` says is one group's, each in a new
 * element named `tag` (whitespace between them kept inside it).
 */
function wrapRuns(children: TemplateNode[], tag: string, belongs: (node: TemplateNode) => boolean): TemplateNode[] {
  if (!children.some(belongs)) return children;
  const out: TemplateNode[] = [];
  let group: ElementNode | null = null;
  let space: TemplateNode[] = [];
  for (const child of children) {
    if (belongs(child)) {
      if (!group) {
        out.push(...space);
        space = [];
        group = createElementNode(tag, child.loc);
        out.push(group);
      }
      group.children.push(...space, child);
      space = [];
    } else if (child.type === 'Text' && child.content.trim() === '') {
      space.push(child);
    } else {
      out.push(...space, child);
      space = [];
      group = null;
    }
  }
  out.push(...space);
  return out;
}

/**
 * A table's rows, written straight into it, inside the `<tbody>` HTML gives
 * them: `<table><tr>…` is `<table><tbody><tr>…`, as every browser reads it,
 * and React warns of a row straight in a table. Cells written straight in
 * are in a row of their own first. A `#each` or `#if` that draws nothing but
 * rows counts as rows.
 */
function wrapTableRows(children: TemplateNode[]): TemplateNode[] {
  const isCell = (node: TemplateNode): boolean => node.type === 'Element' && (node.tag === 'td' || node.tag === 'th');
  return wrapRuns(wrapRuns(children, 'tr', isCell), 'tbody', isTableRow);
}

/** Whether a node draws table rows and nothing else: a `<tr>`, or a `#each` or `#if` of them. */
function isTableRow(node: TemplateNode): boolean {
  const onlyRows = (nodes: TemplateNode[]): boolean => {
    const drawn = nodes.filter((child) => !(child.type === 'Text' && child.content.trim() === ''));
    return drawn.length > 0 && drawn.every(isTableRow);
  };
  if (node.type === 'Element') return node.tag === 'tr';
  if (node.type === 'EachBlock') {
    return onlyRows(node.body) && (!node.emptyFallback || node.emptyFallback.length === 0 || onlyRows(node.emptyFallback));
  }
  if (node.type === 'IfBlock') {
    const otherwise = node.alternate === undefined ? [] : Array.isArray(node.alternate) ? node.alternate : [node.alternate];
    return onlyRows(node.consequent) && (otherwise.length === 0 || onlyRows(otherwise));
  }
  return false;
}

function endsBefore(open: string, next: string, within: readonly string[]): boolean {
  if (HEADINGS.has(open)) return HEADINGS.has(next);
  switch (open) {
    // A link, a button or a no-break run cannot hold another of itself: the
    // second ends the first, as HTML reads `<a>one<a>two`.
    case 'a':
    case 'button':
    case 'nobr':
      return next === open;
    case 'caption':
      return ENDS_A_CAPTION.has(next);
    case 'colgroup':
      return next !== 'col' && next !== 'template' && isHtmlElementTag(next);
    case 'li':
      return next === 'li';
    case 'dt':
    case 'dd':
      return next === 'dt' || next === 'dd';
    case 'p':
      return ENDS_A_PARAGRAPH.has(next);
    case 'option':
      return next === 'option' || next === 'optgroup';
    case 'optgroup':
      return next === 'optgroup' && within.includes('select');
    case 'table':
      return next === 'table';
    case 'tr':
      return next === 'tr' || next === 'tbody' || next === 'thead' || next === 'tfoot' || next === 'table';
    case 'td':
    case 'th':
      return next === 'td' || next === 'th' || next === 'tr' || next === 'tbody' || next === 'thead' || next === 'tfoot';
    case 'thead':
    case 'tbody':
      return next === 'tbody' || next === 'tfoot' || next === 'table';
    case 'tfoot':
      return next === 'table';
    case 'rt':
    case 'rp':
      return (next === 'rt' || next === 'rp') && within.includes('ruby');
    default:
      return false;
  }
}
