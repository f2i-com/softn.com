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

    while (!this.curTokenIs(TokenType.EOF)) {
      this.skipComments();

      if (this.curTokenIs(TokenType.EOF)) break;

      try {
        // Parse top-level elements
        if (this.curTokenIs(TokenType.TAG_OPEN)) {
          const element = this.parseTopLevelElement();
          if (element) {
            if (isImportDeclaration(element)) {
              doc.imports.push(element);
            } else if (isComponentDeclaration(element)) {
              doc.component = element;
            } else if (isScriptBlock(element)) {
              doc.script = element;
            } else if (isLogicBlock(element)) {
              doc.logic = element;
            } else if (isDataBlock(element)) {
              doc.data = element;
            } else if (isStyleBlock(element)) {
              doc.style = element;
            } else if (isTemplateNode(element)) {
              doc.template.push(element);
            }
          }
        } else if (this.curTokenIs(TokenType.HASH)) {
          // Control flow at top level
          const controlFlow = this.parseControlFlow();
          if (controlFlow) {
            doc.template.push(controlFlow);
          }
        } else if (this.curTokenIs(TokenType.TEXT)) {
          const text = createTextNode(this.curToken.literal, this.currentLoc());
          doc.template.push(text);
          this.nextToken();
        } else if (this.curTokenIs(TokenType.EXPR_START)) {
          const expr = this.parseExpressionNode();
          doc.template.push(expr);
        } else {
          this.nextToken();
        }
      } catch (error) {
        // Record the error and skip to the next recoverable point
        this.addDiagnostic(error);
        this.skipToRecoveryPoint();
      }
    }

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

    // Check for special elements
    if (this.curTokenIs(TokenType.IMPORT)) {
      return this.parseImport();
    }
    if (this.curTokenIs(TokenType.COMPONENT)) {
      return this.parseComponentDeclaration();
    }
    if (this.curTokenIs(TokenType.SCRIPT)) {
      return this.parseScriptBlock();
    }
    if (this.curTokenIs(TokenType.LOGIC)) {
      return this.parseLogicBlock();
    }
    if (this.curTokenIs(TokenType.DATA)) {
      return this.parseDataBlock();
    }
    if (this.curTokenIs(TokenType.STYLE)) {
      return this.parseStyleBlock();
    }

    // Regular element
    return this.parseElement();
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
          if (this.curTokenIs(TokenType.IDENTIFIER) && this.curToken.literal === 'as') {
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

    // Expect 'from'
    this.expectToken(TokenType.FROM);

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
      if (this.curTokenIs(TokenType.IDENTIFIER) && this.curToken.literal === 'name') {
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
        const attrName = this.curToken.literal;
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
   * Parse a script block
   */
  private parseScriptBlock(): ScriptBlock {
    const loc = this.currentLoc();

    // Consume 'script' keyword
    this.nextToken();

    // Skip any attributes until TAG_CLOSE or SCRIPT_CONTENT
    while (
      !this.curTokenIs(TokenType.TAG_CLOSE) &&
      !this.curTokenIs(TokenType.SCRIPT_CONTENT) &&
      !this.curTokenIs(TokenType.EOF)
    ) {
      this.nextToken();
    }

    // Consume TAG_CLOSE if present
    if (this.curTokenIs(TokenType.TAG_CLOSE)) {
      this.nextToken();
    }

    // Now we should be at SCRIPT_CONTENT
    if (this.curTokenIs(TokenType.SCRIPT_CONTENT)) {
      const content = this.curToken.literal;
      this.nextToken();

      // Consume closing tag </script>
      if (this.curTokenIs(TokenType.TAG_END_OPEN)) {
        while (!this.curTokenIs(TokenType.TAG_CLOSE) && !this.curTokenIs(TokenType.EOF)) {
          this.nextToken();
        }
        if (this.curTokenIs(TokenType.TAG_CLOSE)) {
          this.nextToken();
        }
      }

      return { type: 'ScriptBlock', code: content, loc };
    }

    // Fallback: skip to end
    while (!this.curTokenIs(TokenType.TAG_END_OPEN) && !this.curTokenIs(TokenType.EOF)) {
      this.nextToken();
    }

    return { type: 'ScriptBlock', code: '', loc };
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
        const attrName = this.curToken.literal;
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
      !this.curTokenIs(TokenType.STYLE_CONTENT) &&
      !this.curTokenIs(TokenType.EOF)
    ) {
      this.nextToken();
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
    let tagName = '';
    if (this.isPropertyName()) {
      tagName = this.curToken.literal;
      this.nextToken();
    }

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
        const attrName = this.curToken.literal;

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
        } else if (attrName === 'as') {
          // Loop variable name: as="item" or as="item, index"
          this.nextToken(); // consume 'as'
          if (this.curTokenIs(TokenType.EQUALS)) {
            this.nextToken();
            if (this.curTokenIs(TokenType.STRING)) {
              const asValue = this.curToken.literal;
              // Support "item" or "item, index" format
              const parts = asValue.split(',').map((s) => s.trim());
              asName = parts[0];
              if (parts.length > 1) {
                indexName = parts[1];
              }
              this.nextToken();
            } else if (this.curTokenIs(TokenType.IDENTIFIER)) {
              // Shorthand: as=item
              asName = this.curToken.literal;
              this.nextToken();
            }
          }
        } else {
          // Regular prop (including keywords like 'data' that can be used as attribute names)
          element.props.push(this.parseProp());
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

    // Set up inline loop if configured
    if (eachIterable) {
      element.inlineEach = {
        iterable: eachIterable,
        itemName: asName || 'item',
        indexName,
      };
    }

    element.selfClosing = this.curTokenIs(TokenType.TAG_SELF_CLOSE);
    this.nextToken(); // consume > or />

    // Parse children if not self-closing
    if (!element.selfClosing) {
      element.children = this.parseChildren(tagName, loc);
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

  /** The value of a quoted attribute — `name="x"` — or undefined if not written that way. */
  private staticPropValue(element: ElementNode, name: string): string | undefined {
    const prop = element.props.find((p) => p.name === name);
    return prop && prop.value.type === 'static' ? prop.value.value : undefined;
  }

  /**
   * Parse children until closing tag
   */
  private parseChildren(parentTag: string, openLoc: SourceLocation): TemplateNode[] {
    const children: TemplateNode[] = [];
    let closed = false;
    const diagnosticsBefore = this.diagnostics.length;

    while (!this.curTokenIs(TokenType.EOF)) {
      this.skipComments();

      // Check for closing tag
      if (this.curTokenIs(TokenType.TAG_END_OPEN)) {
        this.nextToken(); // consume </
        // Keyword tags (`</slot>`) close like any other — see parseElement.
        if (this.isPropertyName()) {
          const closeTagName = this.curToken.literal;
          if (closeTagName === parentTag) {
            this.nextToken(); // consume tag name
            if (this.curTokenIs(TokenType.TAG_CLOSE)) {
              this.nextToken(); // consume >
            }
            closed = true;
            break;
          }
          // Mismatched tag - record diagnostic and skip it, then continue
          // parsing children so the parent's actual close tag is consumed
          this.addDiagnostic(
            new MismatchedTagError(parentTag, closeTagName, this.currentLoc(), this.source)
          );
          // Consume the mismatched closing tag
          this.nextToken(); // consume tag name
          if (this.curTokenIs(TokenType.TAG_CLOSE)) {
            this.nextToken(); // consume >
          }
          continue;
        }
        continue;
      }

      try {
        if (this.curTokenIs(TokenType.TAG_OPEN)) {
          // Child element
          this.nextToken();
          children.push(this.parseElement());
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
      }
    }

    // Reaching EOF without the close tag used to be silent: a missing `</Card>`,
    // an unterminated `{` or `"` inside it, all simply ended the document there
    // with fewer nodes and no diagnostic, so the author had nothing to search
    // for. Only when nothing else was reported inside this element, though —
    // a mismatched tag or an unterminated template literal already explains
    // the truncation, and every ancestor would otherwise repeat it.
    if (!closed && this.diagnostics.length === diagnosticsBefore) {
      this.addDiagnostic(new UnclosedTagError(parentTag, openLoc, this.source));
    }

    return children;
  }

  /**
   * Parse a prop
   * Supports:
   * - Boolean shorthand: prop
   * - Quoted value: prop="value"
   * - Expression: prop={expression}
   * - Bare identifier/value shorthand: prop=value (for simple values like primary, lg, etc.)
   */
  private parseProp(): PropNode {
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
        // Quoted string: prop="value"
        value = { type: 'static', value: this.curToken.literal };
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
    // the worked example, failed to parse on its `@delete` handler.
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
      const modifier = this.curToken.literal;
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
  private parseIfBlock(): IfBlock {
    const loc = this.currentLoc();
    this.nextToken(); // consume 'if'

    this.expectToken(TokenType.LPAREN);
    const condition = this.parseExpression();
    this.expectToken(TokenType.RPAREN);
    this.reportPendingOperand();

    const consequent: TemplateNode[] = [];

    // Parse consequent
    while (!this.curTokenIs(TokenType.EOF)) {
      // Skip comments FIRST so we can properly detect #elseif/#else/#end
      this.skipComments();

      if (this.curTokenIs(TokenType.HASH)) {
        const nextToken = this.peekToken;
        if (
          nextToken.type === TokenType.ELSE ||
          nextToken.type === TokenType.ELSEIF ||
          nextToken.type === TokenType.END
        ) {
          break;
        }
      }

      if (this.curTokenIs(TokenType.TAG_OPEN)) {
        this.nextToken();
        consequent.push(this.parseElement());
      } else if (this.curTokenIs(TokenType.HASH)) {
        const cf = this.parseControlFlow();
        if (cf) consequent.push(cf);
      } else if (this.curTokenIs(TokenType.EXPR_START)) {
        consequent.push(this.parseExpressionNode());
      } else if (this.curTokenIs(TokenType.TEXT)) {
        consequent.push(createTextNode(this.curToken.literal, this.currentLoc()));
        this.nextToken();
      } else if (this.curTokenIs(TokenType.TAG_END_OPEN)) {
        // We hit a closing tag - this is unexpected in #if consequent context
        // This means we're probably inside an element that's parsing its children
        // Break out to let the parent element handle the closing tag
        break;
      } else {
        // Skip unknown tokens (whitespace, etc.) and continue looking for #elseif/#else/#end
        this.nextToken();
      }
    }

    let alternate: TemplateNode[] | IfBlock | undefined;

    // Check for #else or #elseif
    if (this.curTokenIs(TokenType.HASH)) {
      this.nextToken();

      if (this.curTokenIs(TokenType.ELSEIF)) {
        alternate = this.parseIfBlock();
        return { type: 'IfBlock', condition, consequent, alternate, loc };
      } else if (this.curTokenIs(TokenType.ELSE) && this.peekToken.type === TokenType.IF) {
        // `#else if (…)`: the lexer keeps the header open for exactly this
        // spelling, and it is the same chain link `#elseif (…)` makes.
        this.nextToken(); // consume 'else'; parseIfBlock consumes the 'if'
        alternate = this.parseIfBlock();
        return { type: 'IfBlock', condition, consequent, alternate, loc };
      } else if (this.curTokenIs(TokenType.ELSE)) {
        this.nextToken();
        alternate = [];

        while (!this.curTokenIs(TokenType.EOF)) {
          // Skip comments FIRST so we can properly detect #end
          this.skipComments();

          if (this.curTokenIs(TokenType.HASH) && this.peekToken.type === TokenType.END) {
            break;
          }

          if (this.curTokenIs(TokenType.TAG_OPEN)) {
            this.nextToken();
            alternate.push(this.parseElement());
          } else if (this.curTokenIs(TokenType.HASH)) {
            const cf = this.parseControlFlow();
            if (cf) alternate.push(cf);
          } else if (this.curTokenIs(TokenType.EXPR_START)) {
            alternate.push(this.parseExpressionNode());
          } else if (this.curTokenIs(TokenType.TEXT)) {
            alternate.push(createTextNode(this.curToken.literal, this.currentLoc()));
            this.nextToken();
          } else if (this.curTokenIs(TokenType.TAG_END_OPEN)) {
            // Hit a closing tag - break to let parent handle it
            break;
          } else {
            // Skip unknown tokens and continue
            this.nextToken();
          }
        }
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
    }

    return { type: 'IfBlock', condition, consequent, alternate, loc };
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

    this.expectToken(TokenType.IN);

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
      this.curToken.literal.trim() === 'key=' &&
      this.peekToken.type === TokenType.EXPR_START
    ) {
      this.nextToken(); // consume `key=`
      this.expectToken(TokenType.EXPR_START);
      keyExpression = this.parseExpression();
      this.expectToken(TokenType.EXPR_END);
    }

    const body: TemplateNode[] = [];
    let emptyFallback: TemplateNode[] | undefined;

    // Parse body
    while (!this.curTokenIs(TokenType.EOF)) {
      // Skip comments FIRST so we can properly detect #empty/#end
      this.skipComments();

      if (this.curTokenIs(TokenType.HASH)) {
        const nextToken = this.peekToken;
        if (nextToken.type === TokenType.EMPTY || nextToken.type === TokenType.END) {
          break;
        }
      }

      if (this.curTokenIs(TokenType.TAG_OPEN)) {
        this.nextToken();
        body.push(this.parseElement());
      } else if (this.curTokenIs(TokenType.HASH)) {
        const cf = this.parseControlFlow();
        if (cf) body.push(cf);
      } else if (this.curTokenIs(TokenType.EXPR_START)) {
        body.push(this.parseExpressionNode());
      } else if (this.curTokenIs(TokenType.TEXT)) {
        body.push(createTextNode(this.curToken.literal, this.currentLoc()));
        this.nextToken();
      } else if (this.curTokenIs(TokenType.TAG_END_OPEN)) {
        // Hit a closing tag - break to let parent handle it
        break;
      } else {
        // Skip unknown tokens and continue
        this.nextToken();
      }
    }

    // Check for #empty
    const peekType = this.peekToken.type;
    if (this.curTokenIs(TokenType.HASH) && peekType === TokenType.EMPTY) {
      this.nextToken();
      this.nextToken();

      emptyFallback = [];

      while (!this.curTokenIs(TokenType.EOF)) {
        // Skip comments FIRST so we can properly detect #end
        this.skipComments();

        const nextPeekType = this.peekToken.type;
        if (this.curTokenIs(TokenType.HASH) && nextPeekType === TokenType.END) {
          break;
        }

        if (this.curTokenIs(TokenType.TAG_OPEN)) {
          this.nextToken();
          emptyFallback.push(this.parseElement());
        } else if (this.curTokenIs(TokenType.HASH)) {
          // An #if or an #each inside #empty. This branch had no rule for
          // one and stepped over the `#`, the keyword and the header a token
          // at a time: `#if (loading) … #else … #end` drew both of its
          // branches, and the block's own #end was taken for the loop's.
          const cf = this.parseControlFlow();
          if (cf) emptyFallback.push(cf);
        } else if (this.curTokenIs(TokenType.EXPR_START)) {
          emptyFallback.push(this.parseExpressionNode());
        } else if (this.curTokenIs(TokenType.TEXT)) {
          emptyFallback.push(createTextNode(this.curToken.literal, this.currentLoc()));
          this.nextToken();
        } else if (this.curTokenIs(TokenType.TAG_END_OPEN)) {
          // Hit a closing tag - break to let parent handle it
          break;
        } else {
          // Skip unknown tokens and continue
          this.nextToken();
        }
      }
    }

    // Consume #end
    if (this.curTokenIs(TokenType.HASH) && this.peekToken.type === TokenType.END) {
      this.nextToken();
      this.nextToken();
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

  private parseNullishCoalescing(): Expression {
    let left = this.parseOr();

    while (this.curTokenIs(TokenType.NULLISH_COALESCE)) {
      const loc = this.currentLoc();
      this.nextToken();
      const right = this.parseOr();
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
      if (this.curTokenIs(TokenType.COMMA)) {
        this.nextToken();
      }
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
          const body = this.parseExpression();
          return { type: 'ArrowFunctionExpression', params: [], body, async: false, loc };
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
          const body = this.parseExpression();
          const params: string[] = [];
          for (const param of patterns) patternNames(param.pattern, params);
          const plain = patterns.every(
            (param) => param.pattern.type === 'NamePattern' && !param.default && !param.rest
          );
          return plain
            ? { type: 'ArrowFunctionExpression', params, body, async: false, loc }
            : { type: 'ArrowFunctionExpression', params, patterns, body, async: false, loc };
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
        const body = this.parseExpression();
        return { type: 'ArrowFunctionExpression', params: [], body, async: false, loc };
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
        const body = this.parseExpression();
        return { type: 'ArrowFunctionExpression', params: [name], body, async: false, loc };
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

      if (this.curTokenIs(TokenType.COMMA)) {
        this.nextToken();
      }
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
      if (this.curTokenIs(TokenType.COMMA)) {
        this.nextToken();
      } else if (this.curToken === before && !this.curTokenIs(TokenType.RBRACKET)) {
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
    return token;
  }

  private curTokenIs(type: TokenType): boolean {
    return this.curToken.type === type;
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
export const PARSER_VERSION = 6;
