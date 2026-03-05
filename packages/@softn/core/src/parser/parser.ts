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
  ExpressionNode,
  IfBlock,
  EachBlock,
  PropNode,
  EventNode,
  BindingNode,
  Expression,
  PropValue,
  TopLevelElement,
  ParseDiagnostic,
  createDocument,
  createElementNode,
  createTextNode,
  createIdentifier,
  createLiteral,
  isImportDeclaration,
  isComponentDeclaration,
  isScriptBlock,
  isLogicBlock,
  isDataBlock,
  isStyleBlock,
  isTemplateNode,
} from './ast';
import { SoftNParseError, UnexpectedTokenError, MismatchedTagError, InvalidCollectionError } from './errors';

export class Parser {
  private lexer: Lexer;
  private source: string;
  private curToken: Token;
  private peekToken: Token;
  /** Accumulated diagnostics during fault-tolerant parsing */
  private diagnostics: ParseDiagnostic[] = [];

  constructor(source: string) {
    this.source = source;
    this.lexer = new Lexer(source);
    this.curToken = this.lexer.nextToken();
    this.peekToken = this.lexer.nextToken();
  }

  /**
   * Record a parse diagnostic and continue parsing
   */
  private addDiagnostic(error: unknown): void {
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
        if (this.curTokenIs(TokenType.IDENTIFIER)) {
          namedImports.push(this.curToken.literal);
          this.nextToken();
        }
        if (this.curTokenIs(TokenType.COMMA)) {
          this.nextToken();
        }
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
            if (this.curTokenIs(TokenType.EXPR_END)) {
              this.nextToken();
            }
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
  private parseElement(): ElementNode {
    const loc = this.currentLoc();

    // Get tag name
    let tagName = '';
    if (this.curTokenIs(TokenType.IDENTIFIER)) {
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
              if (this.curTokenIs(TokenType.EXPR_END)) {
                this.nextToken();
              }
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
              if (this.curTokenIs(TokenType.EXPR_END)) {
                this.nextToken();
              }
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
      element.children = this.parseChildren(tagName);
    }

    return element;
  }

  /**
   * Parse children until closing tag
   */
  private parseChildren(parentTag: string): TemplateNode[] {
    const children: TemplateNode[] = [];

    while (!this.curTokenIs(TokenType.EOF)) {
      this.skipComments();

      // Check for closing tag
      if (this.curTokenIs(TokenType.TAG_END_OPEN)) {
        this.nextToken(); // consume </
        if (this.curTokenIs(TokenType.IDENTIFIER)) {
          const closeTagName = this.curToken.literal;
          if (closeTagName === parentTag) {
            this.nextToken(); // consume tag name
            if (this.curTokenIs(TokenType.TAG_CLOSE)) {
              this.nextToken(); // consume >
            }
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
    const name = this.curToken.literal;
    this.nextToken();

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
        if (this.curTokenIs(TokenType.EXPR_END)) {
          this.nextToken();
        }
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

    let name = '';
    if (this.curTokenIs(TokenType.IDENTIFIER)) {
      name = this.curToken.literal;
      this.nextToken();
    }

    this.expectToken(TokenType.EQUALS);

    let handler: Expression;

    // Check if this is a braced expression or a bare identifier
    if (this.curTokenIs(TokenType.EXPR_START)) {
      // Standard syntax: @click={handler}
      this.nextToken();
      handler = this.parseExpression();
      if (this.curTokenIs(TokenType.EXPR_END)) {
        this.nextToken();
      }
    } else if (this.curTokenIs(TokenType.IDENTIFIER)) {
      // Shorthand syntax: @click=handleClick (bare identifier)
      handler = createIdentifier(this.curToken.literal, this.currentLoc());
      this.nextToken();
    } else {
      // Fallback to undefined handler
      handler = createIdentifier('undefined', this.currentLoc());
    }

    return { type: 'Event', name, handler, loc };
  }

  /**
   * Parse a binding
   */
  private parseBinding(): BindingNode {
    const loc = this.currentLoc();
    this.nextToken(); // consume :

    let name = '';
    if (this.curTokenIs(TokenType.IDENTIFIER)) {
      name = this.curToken.literal;
      this.nextToken();
    }

    this.expectToken(TokenType.EQUALS);
    this.expectToken(TokenType.EXPR_START);

    const expression = this.parseExpression();

    if (this.curTokenIs(TokenType.EXPR_END)) {
      this.nextToken();
    }

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
    let indexName: string | undefined;

    if (this.curTokenIs(TokenType.IDENTIFIER)) {
      itemName = this.curToken.literal;
      this.nextToken();

      if (this.curTokenIs(TokenType.COMMA)) {
        this.nextToken();
        if (this.curTokenIs(TokenType.IDENTIFIER)) {
          indexName = this.curToken.literal;
          this.nextToken();
        }
      }
    }

    this.expectToken(TokenType.IN);

    const iterable = this.parseExpression();

    this.expectToken(TokenType.RPAREN);

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
      indexName,
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

    if (this.curTokenIs(TokenType.EXPR_END)) {
      this.nextToken();
    }

    return { type: 'Expression', expression, loc };
  }

  /**
   * Parse an expression (simplified expression parser)
   */
  private parseExpression(): Expression {
    return this.parseTernary();
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

    while (
      this.curTokenIs(TokenType.LT) ||
      this.curTokenIs(TokenType.GT) ||
      this.curTokenIs(TokenType.LTE) ||
      this.curTokenIs(TokenType.GTE)
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
    let left = this.parseUnary();

    while (
      this.curTokenIs(TokenType.ASTERISK) ||
      this.curTokenIs(TokenType.SLASH) ||
      this.curTokenIs(TokenType.PERCENT)
    ) {
      const loc = this.currentLoc();
      const operator = this.curToken.literal;
      this.nextToken();
      const right = this.parseUnary();
      left = { type: 'BinaryExpression', operator, left, right, loc };
    }

    return left;
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

    return this.parseCallMember();
  }

  private parseCallMember(): Expression {
    let expr = this.parsePrimary();

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
          // Invalid token after dot — stop parsing member chain
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
          this.nextToken();
          const args: Expression[] = [];

          while (!this.curTokenIs(TokenType.RPAREN) && !this.curTokenIs(TokenType.EOF)) {
            args.push(this.parseExpression());
            if (this.curTokenIs(TokenType.COMMA)) {
              this.nextToken();
            }
          }

          this.expectToken(TokenType.RPAREN);
          expr = { type: 'CallExpression', callee: expr, arguments: args, optional: true, loc };
        } else {
          // Invalid token after ?. — stop parsing member chain
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
        this.nextToken();
        const args: Expression[] = [];

        while (!this.curTokenIs(TokenType.RPAREN) && !this.curTokenIs(TokenType.EOF)) {
          args.push(this.parseExpression());
          if (this.curTokenIs(TokenType.COMMA)) {
            this.nextToken();
          }
        }

        this.expectToken(TokenType.RPAREN);
        expr = { type: 'CallExpression', callee: expr, arguments: args, loc };
      } else {
        break;
      }
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

      // If first token is not an identifier, it's definitely a parenthesized expression
      // e.g. (!a), (1 + 2), ("hello")
      if (!this.curTokenIs(TokenType.IDENTIFIER)) {
        const expr = this.parseExpression();
        this.expectToken(TokenType.RPAREN);
        return expr;
      }

      // First token is an identifier. Check peek to determine if this could be arrow params.
      // Arrow params look like: (a) => or (a, b) => or (a, b, c) =>
      // Parenthesized expressions look like: (a ? b : c), (a + b), (a.x), (a())
      const peekType = this.peekToken.type;
      if (peekType === TokenType.RPAREN || peekType === TokenType.COMMA) {
        // Could be arrow function params - use original approach
        const params: string[] = [];
        while (!this.curTokenIs(TokenType.RPAREN) && !this.curTokenIs(TokenType.EOF)) {
          if (this.curTokenIs(TokenType.IDENTIFIER)) {
            params.push(this.curToken.literal);
            this.nextToken();
          }
          if (this.curTokenIs(TokenType.COMMA)) {
            this.nextToken();
          }
        }
        this.expectToken(TokenType.RPAREN);

        if (this.curTokenIs(TokenType.ARROW)) {
          this.nextToken();
          const body = this.parseExpression();
          return { type: 'ArrowFunctionExpression', params, body, async: false, loc };
        }

        // Not an arrow function - parenthesized identifier(s)
        if (params.length === 1) {
          return createIdentifier(params[0], loc);
        }
        return createIdentifier('undefined', loc);
      }

      // First token is an identifier but followed by an operator/other token
      // This is a parenthesized expression like (a ? b : c) or (a + b)
      const expr = this.parseExpression();
      this.expectToken(TokenType.RPAREN);
      return expr;
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
      const value = parseFloat(this.curToken.literal);
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

    if (this.curTokenIs(TokenType.BACKTICK)) {
      return this.parseTemplateLiteral();
    }

    // Identifier
    if (this.curTokenIs(TokenType.IDENTIFIER)) {
      const name = this.curToken.literal;
      this.nextToken();
      return createIdentifier(name, loc);
    }

    // Arrow function without parens: x => x + 1
    // This is handled in higher-level parsing

    // Fallback
    return createIdentifier('undefined', loc);
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

    const properties: {
      type: 'ObjectProperty';
      key: string;
      value: Expression;
      shorthand: boolean;
      loc: SourceLocation;
    }[] = [];

    while (!this.curTokenIs(TokenType.EXPR_END) && !this.curTokenIs(TokenType.EOF)) {
      if (this.curTokenIs(TokenType.IDENTIFIER) || this.curTokenIs(TokenType.STRING) || this.isPropertyName()) {
        const keyLoc = this.currentLoc();
        const key = this.curToken.literal;
        this.nextToken();

        if (this.curTokenIs(TokenType.COLON)) {
          this.nextToken();
          const value = this.parseExpression();
          properties.push({ type: 'ObjectProperty', key, value, shorthand: false, loc: keyLoc });
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
      elements.push(this.parseExpression());
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
  // Helper methods
  // =========================================================================

  private nextToken(): void {
    this.curToken = this.peekToken;
    this.peekToken = this.lexer.nextToken();
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
