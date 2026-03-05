/**
 * SoftN Lexer
 *
 * Tokenizes .softn source code into a stream of tokens.
 */

import { Token, TokenType, lookupKeyword, createToken } from './token';

export class Lexer {
  private source: string;
  private position: number = 0;
  private readPosition: number = 0;
  private line: number = 1;
  private column: number = 0;
  private ch: string = '';

  // Context tracking for different parsing modes
  private inTag: boolean = false;
  private inExpression: number = 0; // Nesting level of {}
  private inScriptBlock: boolean = false;
  private inLogicBlock: boolean = false;
  private inStyleBlock: boolean = false;
  private inControlFlow: number = 0; // Nesting level of () in control flow
  private controlFlowParenDepth: number = 0; // Counter for nested parentheses in control flow
  // Track when we see script/logic/style keyword in tag, to enable content mode after >
  private sawScriptKeyword: boolean = false;
  private sawLogicKeyword: boolean = false;
  private sawStyleKeyword: boolean = false;
  // Template literal state
  private inTemplateLiteral: boolean = false;
  private templateExprDepth: number = 0;

  constructor(source: string) {
    this.source = source;
    this.readChar();
  }

  /**
   * Get the current character (helper to avoid TypeScript narrowing issues)
   */
  private currentChar(): string {
    return this.ch;
  }

  /**
   * Get the next token from the source
   */
  public nextToken(): Token {
    // Handle special blocks (script/logic/style content)
    if (this.inScriptBlock) {
      return this.readScriptContent();
    }
    if (this.inLogicBlock) {
      return this.readLogicContent();
    }
    if (this.inStyleBlock) {
      return this.readStyleContent();
    }
    // Handle template literal content
    if (this.inTemplateLiteral) {
      return this.readTemplateContent();
    }

    this.skipWhitespace();

    const startLine = this.line;
    const startColumn = this.column;
    const startPos = this.position;

    // End of file
    if (this.ch === '') {
      return createToken(TokenType.EOF, '', startLine, startColumn, startPos, startPos);
    }

    // Comments: // ...
    if (this.ch === '/' && this.peekChar() === '/') {
      return this.readLineComment();
    }

    // HTML comments: <!-- ... -->
    if (
      this.ch === '<' &&
      this.peekCharAt(1) === '!' &&
      this.peekCharAt(2) === '-' &&
      this.peekCharAt(3) === '-'
    ) {
      return this.readHtmlComment();
    }

    // Control flow: #if, #each, #else, #end, #empty
    if (this.ch === '#') {
      this.inControlFlow = 1; // Start control flow mode (will track () nesting)
      this.controlFlowParenDepth = 0;
      const token = createToken(
        TokenType.HASH,
        '#',
        startLine,
        startColumn,
        startPos,
        this.position
      );
      this.readChar();
      return token;
    }

    // Tag start
    if (this.ch === '<') {
      return this.readTagStart();
    }

    // Inside a tag or expression
    if (this.inTag || this.inExpression > 0 || this.inControlFlow > 0) {
      return this.readTokenInTagOrExpr();
    }

    // Text content (between elements)
    return this.readTextContent();
  }

  /**
   * Read a token when inside a tag or expression
   */
  private readTokenInTagOrExpr(): Token {
    this.skipWhitespace();

    const startLine = this.line;
    const startColumn = this.column;
    const startPos = this.position;

    if (this.ch === '') {
      return createToken(TokenType.EOF, '', startLine, startColumn, startPos, startPos);
    }

    // Single character tokens
    switch (this.ch) {
      case '>':
        // Inside an expression or control flow, > is a comparison operator, not a tag close
        if (this.inExpression > 0 || this.inControlFlow > 0) {
          if (this.peekChar() === '=') {
            this.readChar();
            this.readChar();
            return createToken(TokenType.GTE, '>=', startLine, startColumn, startPos, this.position);
          }
          this.readChar();
          return createToken(TokenType.GT, '>', startLine, startColumn, startPos, this.position);
        }
        this.readChar();
        this.inTag = false;
        // If we just closed a script/logic/style tag, enable content mode for next token
        if (this.sawScriptKeyword) {
          this.inScriptBlock = true;
          this.sawScriptKeyword = false;
        } else if (this.sawLogicKeyword) {
          this.inLogicBlock = true;
          this.sawLogicKeyword = false;
        } else if (this.sawStyleKeyword) {
          this.inStyleBlock = true;
          this.sawStyleKeyword = false;
        }
        return createToken(
          TokenType.TAG_CLOSE,
          '>',
          startLine,
          startColumn,
          startPos,
          this.position
        );

      case '/':
        if (this.peekChar() === '>') {
          this.readChar();
          this.readChar();
          this.inTag = false;
          // Reset keyword flags for self-closing tags - they don't have content
          this.sawScriptKeyword = false;
          this.sawLogicKeyword = false;
          this.sawStyleKeyword = false;
          return createToken(
            TokenType.TAG_SELF_CLOSE,
            '/>',
            startLine,
            startColumn,
            startPos,
            this.position
          );
        }
        this.readChar();
        return createToken(TokenType.SLASH, '/', startLine, startColumn, startPos, this.position);

      case '=':
        if (this.peekChar() === '=') {
          this.readChar();
          if (this.peekChar() === '=') {
            this.readChar();
            this.readChar();
            return createToken(
              TokenType.EQ_STRICT,
              '===',
              startLine,
              startColumn,
              startPos,
              this.position
            );
          }
          this.readChar();
          return createToken(TokenType.EQ, '==', startLine, startColumn, startPos, this.position);
        }
        if (this.peekChar() === '>') {
          this.readChar();
          this.readChar();
          return createToken(
            TokenType.ARROW,
            '=>',
            startLine,
            startColumn,
            startPos,
            this.position
          );
        }
        this.readChar();
        return createToken(TokenType.EQUALS, '=', startLine, startColumn, startPos, this.position);

      case '{':
        this.readChar();
        this.inExpression++;
        return createToken(
          TokenType.EXPR_START,
          '{',
          startLine,
          startColumn,
          startPos,
          this.position
        );

      case '}':
        this.readChar();
        this.inExpression = Math.max(0, this.inExpression - 1);
        if (this.inExpression === 0 && this.templateExprDepth > 0) {
          this.templateExprDepth--;
          this.inTemplateLiteral = true;
        }
        return createToken(
          TokenType.EXPR_END,
          '}',
          startLine,
          startColumn,
          startPos,
          this.position
        );

      case '@':
        this.readChar();
        return createToken(TokenType.AT, '@', startLine, startColumn, startPos, this.position);

      case ':':
        this.readChar();
        return createToken(TokenType.COLON, ':', startLine, startColumn, startPos, this.position);

      case '(':
        this.readChar();
        if (this.inControlFlow > 0) {
          this.controlFlowParenDepth++;
        }
        return createToken(TokenType.LPAREN, '(', startLine, startColumn, startPos, this.position);

      case ')':
        this.readChar();
        if (this.inControlFlow > 0) {
          if (this.controlFlowParenDepth > 0) {
            this.controlFlowParenDepth--;
          }
          if (this.controlFlowParenDepth === 0) {
            // Exiting control flow mode when all parens are closed
            this.inControlFlow = 0;
          }
        }
        return createToken(TokenType.RPAREN, ')', startLine, startColumn, startPos, this.position);

      case '[':
        this.readChar();
        return createToken(
          TokenType.LBRACKET,
          '[',
          startLine,
          startColumn,
          startPos,
          this.position
        );

      case ']':
        this.readChar();
        return createToken(
          TokenType.RBRACKET,
          ']',
          startLine,
          startColumn,
          startPos,
          this.position
        );

      case ',':
        this.readChar();
        return createToken(TokenType.COMMA, ',', startLine, startColumn, startPos, this.position);

      case '.':
        // Check for spread operator ...
        if (this.peekChar() === '.' && this.peekCharAt(2) === '.') {
          this.readChar();
          this.readChar();
          this.readChar();
          return createToken(
            TokenType.SPREAD,
            '...',
            startLine,
            startColumn,
            startPos,
            this.position
          );
        }
        this.readChar();
        return createToken(TokenType.DOT, '.', startLine, startColumn, startPos, this.position);

      case ';':
        this.readChar();
        return createToken(
          TokenType.SEMICOLON,
          ';',
          startLine,
          startColumn,
          startPos,
          this.position
        );

      case '+':
        this.readChar();
        return createToken(TokenType.PLUS, '+', startLine, startColumn, startPos, this.position);

      case '-':
        this.readChar();
        return createToken(TokenType.MINUS, '-', startLine, startColumn, startPos, this.position);

      case '*':
        this.readChar();
        return createToken(
          TokenType.ASTERISK,
          '*',
          startLine,
          startColumn,
          startPos,
          this.position
        );

      case '%':
        this.readChar();
        return createToken(TokenType.PERCENT, '%', startLine, startColumn, startPos, this.position);

      case '!':
        if (this.peekChar() === '=') {
          this.readChar();
          if (this.peekChar() === '=') {
            this.readChar();
            this.readChar();
            return createToken(
              TokenType.NOT_EQ_STRICT,
              '!==',
              startLine,
              startColumn,
              startPos,
              this.position
            );
          }
          this.readChar();
          return createToken(
            TokenType.NOT_EQ,
            '!=',
            startLine,
            startColumn,
            startPos,
            this.position
          );
        }
        this.readChar();
        return createToken(TokenType.BANG, '!', startLine, startColumn, startPos, this.position);

      case '<':
        if (this.peekChar() === '=') {
          this.readChar();
          this.readChar();
          return createToken(TokenType.LTE, '<=', startLine, startColumn, startPos, this.position);
        }
        // Inside an expression or control flow, < is a comparison operator
        if (this.inExpression > 0 || this.inControlFlow > 0) {
          this.readChar();
          return createToken(TokenType.LT, '<', startLine, startColumn, startPos, this.position);
        }
        // Could be another tag - let readTagStart handle it
        return this.readTagStart();

      case '&':
        if (this.peekChar() === '&') {
          this.readChar();
          this.readChar();
          // Check for &&= (use currentChar() to get fresh value)
          if (this.currentChar() === '=') {
            this.readChar();
            return createToken(
              TokenType.AND_ASSIGN,
              '&&=',
              startLine,
              startColumn,
              startPos,
              this.position
            );
          }
          return createToken(TokenType.AND, '&&', startLine, startColumn, startPos, this.position);
        }
        break;

      case '|':
        if (this.peekChar() === '|') {
          this.readChar();
          this.readChar();
          // Check for ||= (use currentChar() to get fresh value)
          if (this.currentChar() === '=') {
            this.readChar();
            return createToken(
              TokenType.OR_ASSIGN,
              '||=',
              startLine,
              startColumn,
              startPos,
              this.position
            );
          }
          return createToken(TokenType.OR, '||', startLine, startColumn, startPos, this.position);
        }
        break;

      case '?':
        if (this.peekChar() === '.') {
          this.readChar();
          this.readChar();
          return createToken(
            TokenType.OPTIONAL_CHAIN,
            '?.',
            startLine,
            startColumn,
            startPos,
            this.position
          );
        }
        if (this.peekChar() === '?') {
          this.readChar();
          this.readChar();
          // Check for ??= (use currentChar() to get fresh value)
          if (this.currentChar() === '=') {
            this.readChar();
            return createToken(
              TokenType.NULLISH_ASSIGN,
              '??=',
              startLine,
              startColumn,
              startPos,
              this.position
            );
          }
          return createToken(
            TokenType.NULLISH_COALESCE,
            '??',
            startLine,
            startColumn,
            startPos,
            this.position
          );
        }
        this.readChar();
        return createToken(
          TokenType.QUESTION,
          '?',
          startLine,
          startColumn,
          startPos,
          this.position
        );

      case '$':
        this.readChar();
        return createToken(TokenType.DOLLAR, '$', startLine, startColumn, startPos, this.position);

      case '`':
        // Template literal start
        this.readChar();
        this.inTemplateLiteral = true;
        return createToken(
          TokenType.BACKTICK,
          '`',
          startLine,
          startColumn,
          startPos,
          this.position
        );

      case '"':
      case "'":
        return this.readString();
    }

    // Numbers
    if (this.isDigit(this.ch)) {
      return this.readNumber();
    }

    // Identifiers and keywords
    if (this.isIdentifierStart(this.ch)) {
      return this.readIdentifier();
    }

    // Unknown character - skip it
    const ch = this.ch;
    this.readChar();
    return createToken(TokenType.TEXT, ch, startLine, startColumn, startPos, this.position);
  }

  /**
   * Read template literal content
   */
  private readTemplateContent(): Token {
    const startLine = this.line;
    const startColumn = this.column;
    const startPos = this.position;

    let content = '';

    while (this.ch !== '') {
      // Check for end of template literal
      if (this.ch === '`') {
        if (content.length > 0) {
          // Return accumulated content first
          return createToken(
            TokenType.TEMPLATE_STRING,
            content,
            startLine,
            startColumn,
            startPos,
            this.position
          );
        }
        // Return backtick and exit template mode
        this.readChar();
        this.inTemplateLiteral = false;
        return createToken(
          TokenType.BACKTICK,
          '`',
          startLine,
          startColumn,
          startPos,
          this.position
        );
      }

      // Check for template expression ${
      if (this.ch === '$' && this.peekChar() === '{') {
        if (content.length > 0) {
          // Return accumulated content first
          return createToken(
            TokenType.TEMPLATE_STRING,
            content,
            startLine,
            startColumn,
            startPos,
            this.position
          );
        }
        // Return ${ and temporarily exit template mode
        this.readChar();
        this.readChar();
        this.inTemplateLiteral = false;
        this.inExpression++;
        this.templateExprDepth++;
        return createToken(
          TokenType.TEMPLATE_EXPR_START,
          '${',
          startLine,
          startColumn,
          startPos,
          this.position
        );
      }

      // Handle escape sequences
      if (this.ch === '\\') {
        this.readChar();
        const escaped = this.currentChar();
        if (escaped === 'n') content += '\n';
        else if (escaped === 't') content += '\t';
        else if (escaped === 'r') content += '\r';
        else if (escaped === '\\') content += '\\';
        else if (escaped === '`') content += '`';
        else if (escaped === '$') content += '$';
        else if (escaped === '0') content += '\0';
        else content += escaped;
        this.readChar();
        continue;
      }

      content += this.ch;
      this.readChar();
    }

    // Unterminated template literal
    return createToken(
      TokenType.TEMPLATE_STRING,
      content,
      startLine,
      startColumn,
      startPos,
      this.position
    );
  }

  /**
   * Read tag start: < or </
   */
  private readTagStart(): Token {
    const startLine = this.line;
    const startColumn = this.column;
    const startPos = this.position;

    this.readChar(); // consume <

    if (this.ch === '/') {
      this.readChar();
      this.inTag = true;
      return createToken(
        TokenType.TAG_END_OPEN,
        '</',
        startLine,
        startColumn,
        startPos,
        this.position
      );
    }

    this.inTag = true;

    // Check for special blocks - we'll set the content mode flag after TAG_CLOSE
    const nextWord = this.peekWord();
    if (nextWord === 'script') {
      this.sawScriptKeyword = true;
    } else if (nextWord === 'logic') {
      this.sawLogicKeyword = true;
    } else if (nextWord === 'style') {
      this.sawStyleKeyword = true;
    }

    return createToken(TokenType.TAG_OPEN, '<', startLine, startColumn, startPos, this.position);
  }

  /**
   * Read an identifier or keyword
   */
  private readIdentifier(): Token {
    const startLine = this.line;
    const startColumn = this.column;
    const startPos = this.position;

    const ident = this.readWhile((ch) => this.isIdentifierPart(ch));
    const type = lookupKeyword(ident);

    // Reset control flow mode after keywords that don't use parentheses
    // #end and #else terminate control flow mode immediately
    // #empty also terminates control flow mode (used in #each...#empty...#end)
    // Note: #elseif is NOT reset here because it's followed by (condition)
    if (
      this.inControlFlow > 0 &&
      (type === TokenType.END || type === TokenType.ELSE || type === TokenType.EMPTY)
    ) {
      this.inControlFlow = 0;
      this.controlFlowParenDepth = 0;
    }

    return createToken(type, ident, startLine, startColumn, startPos, this.position);
  }

  /**
   * Read a string literal
   */
  private readString(): Token {
    const startLine = this.line;
    const startColumn = this.column;
    const startPos = this.position;
    const quote = this.ch;

    this.readChar(); // consume opening quote

    let value = '';
    let unterminated = false;

    while (this.ch !== '' && this.ch !== quote) {
      // Check for newline in string (not allowed in regular strings)
      if (this.ch === '\n' || this.ch === '\r') {
        unterminated = true;
        break;
      }

      if (this.ch === '\\') {
        this.readChar();
        if (this.currentChar() === '') {
          unterminated = true;
          break;
        }
        const escaped: string = this.currentChar();
        switch (escaped) {
          case 'n':
            value += '\n';
            break;
          case 't':
            value += '\t';
            break;
          case 'r':
            value += '\r';
            break;
          case 'b':
            value += '\b';
            break;
          case 'f':
            value += '\f';
            break;
          case 'v':
            value += '\v';
            break;
          case '0':
            value += '\0';
            break;
          case '\\':
            value += '\\';
            break;
          case '"':
            value += '"';
            break;
          case "'":
            value += "'";
            break;
          case 'x':
            // Hex escape \xNN
            this.readChar();
            if (this.isHexDigit(this.currentChar()) && this.isHexDigit(this.peekChar())) {
              const hex = this.currentChar() + this.peekChar();
              this.readChar();
              value += String.fromCharCode(parseInt(hex, 16));
            } else {
              value += 'x';
              continue; // Don't consume another char
            }
            break;
          case 'u':
            // Unicode escape \uNNNN or \u{NNNN}
            this.readChar();
            if (this.currentChar() === '{') {
              // \u{NNNN} format
              this.readChar();
              let hex = '';
              while (
                this.currentChar() !== '' &&
                this.currentChar() !== '}' &&
                this.isHexDigit(this.currentChar())
              ) {
                hex += this.currentChar();
                this.readChar();
              }
              if (this.currentChar() === '}' && hex.length > 0) {
                const codePoint = parseInt(hex, 16);
                if (codePoint <= 0x10ffff) {
                  value += String.fromCodePoint(codePoint);
                } else {
                  value += '?'; // Invalid code point
                }
              } else {
                value += 'u{' + hex;
                continue;
              }
            } else if (this.isHexDigit(this.currentChar())) {
              // \uNNNN format
              let hex = this.currentChar();
              for (let i = 0; i < 3 && this.isHexDigit(this.peekChar()); i++) {
                this.readChar();
                hex += this.currentChar();
              }
              if (hex.length === 4) {
                value += String.fromCharCode(parseInt(hex, 16));
              } else {
                value += 'u' + hex;
              }
            } else {
              value += 'u';
              continue;
            }
            break;
          default:
            value += escaped;
        }
      } else {
        value += this.currentChar();
      }
      this.readChar();
    }

    if (!unterminated && this.ch === quote) {
      this.readChar(); // consume closing quote
    }

    return createToken(TokenType.STRING, value, startLine, startColumn, startPos, this.position);
  }

  /**
   * Read a number literal (supports integers, decimals, and exponential notation)
   */
  private readNumber(): Token {
    const startLine = this.line;
    const startColumn = this.column;
    const startPos = this.position;

    let num = this.readWhile((ch) => this.isDigit(ch));

    // Check for decimal
    if (this.ch === '.' && this.isDigit(this.peekChar())) {
      num += this.ch;
      this.readChar();
      num += this.readWhile((ch) => this.isDigit(ch));
    }

    // Check for exponential notation (e.g., 1e10, 3.14E-2)
    if (this.ch === 'e' || this.ch === 'E') {
      let exp = this.ch;
      this.readChar();

      // Handle optional sign (use currentChar() to avoid TypeScript narrowing)
      const sign = this.currentChar();
      if (sign === '+' || sign === '-') {
        exp += sign;
        this.readChar();
      }

      // Must have at least one digit after e/E
      if (this.isDigit(this.currentChar())) {
        exp += this.readWhile((ch) => this.isDigit(ch));
        num += exp;
      } else {
        // Invalid exponential, backtrack
        // Put back the characters we read
        this.position -= exp.length;
        this.readPosition = this.position + 1;
        this.ch = this.source[this.position] || '';
      }
    }

    return createToken(TokenType.NUMBER, num, startLine, startColumn, startPos, this.position);
  }

  /**
   * Read text content between tags
   * Supports \# escape sequence to render literal #
   */
  private readTextContent(): Token {
    const startLine = this.line;
    const startColumn = this.column;
    const startPos = this.position;

    let content = '';
    while (this.ch !== '' && this.ch !== '<' && this.ch !== '{') {
      // Check for escape sequences
      if (this.ch === '\\') {
        const nextCh = this.peekChar();
        if (nextCh === '#' || nextCh === '{' || nextCh === '<' || nextCh === '\\') {
          // Consume backslash and add the escaped character
          this.readChar();
          content += this.ch;
          this.readChar();
          continue;
        }
      }

      // Stop at # unless escaped
      if (this.ch === '#') {
        break;
      }

      content += this.ch;
      this.readChar();
    }

    // Normalize whitespace but preserve single leading/trailing spaces
    // This ensures "{expr} text" keeps the space between expression and text
    const hadLeadingSpace = /^\s/.test(content);
    const hadTrailingSpace = /\s$/.test(content);
    content = content.replace(/\s+/g, ' ').trim();
    if (hadLeadingSpace && content) content = ' ' + content;
    if (hadTrailingSpace && content) content = content + ' ';

    // If content is empty (pure whitespace), skip to what comes next without recursion
    if (content === '' || content === ' ') {
      // Check what we stopped at and handle it directly
      if (this.ch === '<') {
        return this.readTagStart();
      }
      if (this.ch === '{') {
        this.inExpression++;
        const token = createToken(
          TokenType.EXPR_START,
          '{',
          this.line,
          this.column,
          this.position,
          this.position + 1
        );
        this.readChar();
        return token;
      }
      if (this.ch === '#') {
        this.inControlFlow = 1;
        this.controlFlowParenDepth = 0;
        const token = createToken(
          TokenType.HASH,
          '#',
          this.line,
          this.column,
          this.position,
          this.position + 1
        );
        this.readChar();
        return token;
      }
      if (this.ch === '') {
        return createToken(TokenType.EOF, '', this.line, this.column, this.position, this.position);
      }
      // Fallback: return empty text
      return createToken(TokenType.TEXT, '', startLine, startColumn, startPos, this.position);
    }

    return createToken(TokenType.TEXT, content, startLine, startColumn, startPos, this.position);
  }

  /**
   * Read script content until </script>
   * Called after TAG_CLOSE has been returned for <script>
   */
  private readScriptContent(): Token {
    const startLine = this.line;
    const startColumn = this.column;
    const startPos = this.position;

    // Read until </script>
    let content = '';
    const endTag = '</script>';
    while (this.ch !== '') {
      // Check for end tag using character-by-character comparison (Unicode safe)
      if (this.ch === '<' && this.matchAhead(endTag)) {
        break;
      }
      content += this.ch;
      this.readChar();
    }

    this.inScriptBlock = false;
    return createToken(
      TokenType.SCRIPT_CONTENT,
      content.trim(),
      startLine,
      startColumn,
      startPos,
      this.position
    );
  }

  /**
   * Read logic content until </logic>
   * Called after TAG_CLOSE has been returned for <logic>
   */
  private readLogicContent(): Token {
    const startLine = this.line;
    const startColumn = this.column;
    const startPos = this.position;

    // Read until </logic>
    let content = '';
    const endTag = '</logic>';
    while (this.ch !== '') {
      if (this.ch === '<' && this.matchAhead(endTag)) {
        break;
      }
      content += this.ch;
      this.readChar();
    }

    this.inLogicBlock = false;
    return createToken(
      TokenType.LOGIC_CONTENT,
      content.trim(),
      startLine,
      startColumn,
      startPos,
      this.position
    );
  }

  /**
   * Read style content until </style>
   * Called after TAG_CLOSE has been returned for <style>
   */
  private readStyleContent(): Token {
    const startLine = this.line;
    const startColumn = this.column;
    const startPos = this.position;

    // Read until </style>
    let content = '';
    const endTag = '</style>';
    while (this.ch !== '') {
      if (this.ch === '<' && this.matchAhead(endTag)) {
        break;
      }
      content += this.ch;
      this.readChar();
    }

    this.inStyleBlock = false;
    return createToken(
      TokenType.STYLE_CONTENT,
      content.trim(),
      startLine,
      startColumn,
      startPos,
      this.position
    );
  }

  /**
   * Check if the upcoming characters match a string (case-insensitive for tags)
   */
  private matchAhead(str: string): boolean {
    for (let i = 0; i < str.length; i++) {
      const sourceChar = this.source[this.position + i];
      if (sourceChar === undefined) return false;
      if (sourceChar.toLowerCase() !== str[i].toLowerCase()) return false;
    }
    return true;
  }

  /**
   * Read a line comment
   */
  private readLineComment(): Token {
    const startLine = this.line;
    const startColumn = this.column;
    const startPos = this.position;

    this.readChar(); // consume first /
    this.readChar(); // consume second /

    const comment = this.readWhile((ch) => ch !== '\n' && ch !== '');

    return createToken(
      TokenType.COMMENT,
      comment.trim(),
      startLine,
      startColumn,
      startPos,
      this.position
    );
  }

  /**
   * Read an HTML comment: <!-- ... -->
   */
  private readHtmlComment(): Token {
    const startLine = this.line;
    const startColumn = this.column;
    const startPos = this.position;

    // Consume <!--
    this.readChar(); // <
    this.readChar(); // !
    this.readChar(); // -
    this.readChar(); // -

    // Read until we find -->
    let comment = '';
    while (this.ch !== '') {
      if (this.ch === '-' && this.peekCharAt(1) === '-' && this.peekCharAt(2) === '>') {
        // Consume -->
        this.readChar(); // -
        this.readChar(); // -
        this.readChar(); // >
        break;
      }
      comment += this.ch;
      this.readChar();
    }

    return createToken(
      TokenType.COMMENT,
      comment.trim(),
      startLine,
      startColumn,
      startPos,
      this.position
    );
  }

  /**
   * Read the next character
   */
  private readChar(): void {
    if (this.readPosition >= this.source.length) {
      this.ch = '';
    } else {
      this.ch = this.source[this.readPosition];
    }

    this.position = this.readPosition;
    this.readPosition++;

    if (this.ch === '\n') {
      this.line++;
      this.column = 0;
    } else {
      this.column++;
    }
  }

  /**
   * Peek at the next character without consuming it
   */
  private peekChar(): string {
    if (this.readPosition >= this.source.length) {
      return '';
    }
    return this.source[this.readPosition];
  }

  /**
   * Peek at a character at a specific offset from current position
   */
  private peekCharAt(offset: number): string {
    const pos = this.position + offset;
    if (pos >= this.source.length) {
      return '';
    }
    return this.source[pos];
  }

  /**
   * Peek at the next word (for detecting special blocks)
   */
  private peekWord(): string {
    let pos = this.position;
    while (pos < this.source.length && this.isWhitespace(this.source[pos])) {
      pos++;
    }
    let word = '';
    while (pos < this.source.length && this.isIdentifierPart(this.source[pos])) {
      word += this.source[pos];
      pos++;
    }
    return word.toLowerCase();
  }

  /**
   * Read while a condition is true
   */
  private readWhile(condition: (ch: string) => boolean): string {
    let result = '';
    while (this.ch !== '' && condition(this.ch)) {
      result += this.ch;
      this.readChar();
    }
    return result;
  }

  /**
   * Skip whitespace characters
   */
  private skipWhitespace(): void {
    while (this.isWhitespace(this.ch)) {
      this.readChar();
    }
  }

  private isWhitespace(ch: string): boolean {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
  }

  /**
   * Check if character can start an identifier
   * Supports Unicode letters, _, and $
   */
  private isIdentifierStart(ch: string): boolean {
    if (ch === '_' || ch === '$') return true;
    if (ch >= 'a' && ch <= 'z') return true;
    if (ch >= 'A' && ch <= 'Z') return true;
    // Support Unicode letters (basic check for extended Latin, Greek, Cyrillic, etc.)
    const code = ch.charCodeAt(0);
    // Unicode letter ranges (simplified)
    if (code >= 0x00c0 && code <= 0x024f) return true; // Latin Extended
    if (code >= 0x0370 && code <= 0x03ff) return true; // Greek
    if (code >= 0x0400 && code <= 0x04ff) return true; // Cyrillic
    if (code >= 0x4e00 && code <= 0x9fff) return true; // CJK
    if (code >= 0xac00 && code <= 0xd7af) return true; // Korean Hangul
    return false;
  }

  /**
   * Check if character can continue an identifier
   */
  private isIdentifierPart(ch: string): boolean {
    if (this.isIdentifierStart(ch)) return true;
    if (ch >= '0' && ch <= '9') return true;
    // Unicode combining marks
    const code = ch.charCodeAt(0);
    if (code >= 0x0300 && code <= 0x036f) return true; // Combining Diacritical Marks
    return false;
  }

  private isDigit(ch: string): boolean {
    return ch >= '0' && ch <= '9';
  }

  private isHexDigit(ch: string): boolean {
    return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
  }
}

/**
 * Tokenize a source string into an array of tokens
 */
export function tokenize(source: string): Token[] {
  const lexer = new Lexer(source);
  const tokens: Token[] = [];

  let token = lexer.nextToken();
  while (token.type !== TokenType.EOF) {
    tokens.push(token);
    token = lexer.nextToken();
  }
  tokens.push(token); // Include EOF

  return tokens;
}
