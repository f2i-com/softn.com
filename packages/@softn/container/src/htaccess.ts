/**
 * Apache `.htaccess` reader and rewrite engine for PHP backends that run in the browser.
 *
 * What it decides: `backend-runtime.ts` reads every `.htaccess` in an app's archive when its
 * Backend Worker starts, and runs `evaluateHtaccessChain` over each request the app's page sends
 * to an embedded PHP backend (`LocalBackendTransport`), for the path asked for and again for the
 * script or file that path resolves to. A refusal is answered with its status and a redirect as
 * a redirect; a rewrite decides which script runs, or which static file is served, with what
 * query; `DirectoryIndex` picks a directory's index file. That is so in every host that runs
 * such a backend in the page: the web player and the desktop shell (`@softn/runtime-shell`),
 * Studio and Builder previews, `<softn-app>` and `mountSoftNContainer`, and FormLogic's host
 * when the backend is local. Rust, JavaScript and Python backends, and a backend reached over
 * `backendUrl`, do not consult it. The server hosts read `.htaccess` themselves
 * (`apps/softn-host-rust/src/container_backend.rs`, `apps/softn-host-php/runtime/container-backend.mjs`).
 *
 * It reads `RewriteEngine`, `RewriteBase`, `RewriteCond` (`%{REQUEST_FILENAME}`, `%{REQUEST_URI}`,
 * `%{QUERY_STRING}`, `%{REQUEST_METHOD}`, `%{HTTP_HOST}`, `%{HTTPS}`, `%{HTTP:Name}`; `-f`, `-d`,
 * `-s`, `-l`, `=text` or a pattern, each negatable with `!`; `[NC,OR]`), `RewriteRule` (a pattern
 * negatable with `!`, which leaves `$1`…`$9` empty; `[L,END,QSA,NC,B,R,R=code,F,G]`, `$1`…`$9`,
 * `%1`…`%9`, `-`), `Require all denied` / `Deny from all`
 * in the directory or in `<Files>`/`<FilesMatch>` and `<Limit>`/`<LimitExcept>`, `RedirectMatch`,
 * `DirectoryIndex`, `ErrorDocument` and `Options ±Indexes`.
 *
 * Access is read as those hosts read it, and test/htaccess-and-vnav.test.ts holds this reader to
 * their cases:
 * - `Require all denied` and `Deny from all` (by their words, in any case and spacing) refuse
 *   everything under the directory, a request for the directory itself included. Inside a
 *   `<Files>`, `<Files ~>` or `<FilesMatch>` block they refuse the file the request is mapped
 *   to: its last segment, or a segment before it that is a file (the rest is its PATH_INFO). A
 *   block whose pattern does not compile here denies nothing.
 * - Inside `<Limit>`/`<LimitExcept>` a deny is for the methods named (HEAD is GET, names match
 *   by case, and nested or empty sections deny every method). `<If>`, `<ElseIf>` and `<Else>`
 *   are not evaluated and nothing in them is read; `<IfModule>` and the like apply as written.
 *   Nothing but a deny is read inside a block or a method section.
 * - `RedirectMatch` to a status of 400 or more refuses what it matches with that status;
 *   `RewriteRule … [F]` refuses with 403 and `[G]` with 410.
 * - A file over 64 KiB, with more than 64 denies, 256 RewriteRule or 256 RedirectMatch lines, or
 *   64 RewriteCond lines before one rule, whose sections do not match up (one left open, or one
 *   closed that is not the innermost open), with a section tag Apache does not read (`</Files >`,
 *   `<Files "x"` with no `>`, words after a tag's `>`), or with a `<Files>`, `<Files ~>` or
 *   `<FilesMatch>` pattern over 512 bytes, refuses everything under its directory.
 * - `%{HTTP:Cookie}`, `Authorization` and `Proxy-Authorization` are never read into a rule.
 *
 * Where it is less exact than the hosts:
 * - It is handed text, so the size is the text's in UTF-8: a file that is not UTF-8 (each bad
 *   byte decoded as U+FFFD) measures longer than it is, and a byte-order mark the decoder took
 *   off is not counted.
 * - Patterns are JavaScript's, behind a guard against shapes that can backtrack without end
 *   (`hasUnsafeRegexStructure`) which turns away patterns a host compiles (`.*.*`, `(a+)+`,
 *   more than three unbounded repeats, and a rule's, a condition's or a RedirectMatch's over 512
 *   characters). What it turns away is not read: a rule that is not run, a block that denies
 *   nothing. Only the first 512 characters of a
 *   string are matched, so a path, or a segment of one, longer than that is not refused by a
 *   pattern anchored at its end, and a negated rule anchored at its end is run for it.
 * - Rewrites run file by file (up to four passes each) and again for the files a new path is
 *   under, with the access rules checked on the path each file leaves and on the last one. The
 *   hosts run up to four passes over all the files and check after every rewrite, so a request
 *   rewritten through a refused path to another is refused there and not here.
 * Beyond the hosts it reads `DirectoryIndex` (the Rust host parses it and leaves it unused),
 * `Options ±Indexes` and `ErrorDocument` (parsed, unused), the `[B]` and `[END]` flags,
 * `%{HTTP_NAME}` variables, `-s` as a file that is not empty, a substitution that is a full URL
 * as a redirect without `[R]`, and a relative redirect as one under `RewriteBase` or the
 * directory.
 */

export interface HtaccessRewriteCond {
  testString: string;
  pattern: string;
  regex?: RegExp | null;
  negated: boolean;
  nocase: boolean;
  orNext: boolean;
}

export interface HtaccessRewriteRule {
  /** The pattern, without the `!` that negates it. */
  pattern: string;
  regex: RegExp;
  /** `RewriteRule !pattern`: for a path the pattern does not match, with `$1`…`$9` empty. */
  negated: boolean;
  substitution: string;
  conds: HtaccessRewriteCond[];
  last: boolean;
  end: boolean;
  qsa: boolean;
  nocase: boolean;
  escapeBackrefs: boolean;
  redirectStatus: number | null;
  forbidden: boolean;
  gone: boolean;
}

export interface HtaccessRedirectMatch {
  status: number;
  regex: RegExp;
  target: string | null;
}

/**
 * The methods a deny is for: every one (`null`), or the ones its `<Limit>` names (`except:
 * false`) or does not name (`<LimitExcept>`, `except: true`). Names are kept as Apache knows
 * them: as written (it matches them by case), and `HEAD` as `GET`.
 */
export type HtaccessDenyMethods = { except: boolean; methods: string[] } | null;

/** A deny inside a `<Files>`/`<FilesMatch>` block: the names it is for, and the methods. */
export interface HtaccessFilesDeny {
  matcher: RegExp;
  methods: HtaccessDenyMethods;
}

export interface ParsedHtaccess {
  /** Directory prefix this `.htaccess` applies to (`""` for root, `"admin"` for `admin/.htaccess`). */
  dirPrefix: string;
  rewriteEngine: boolean;
  rewriteBase: string | null;
  directoryIndex: string[];
  allowIndexes: boolean;
  errorDocuments: Record<number, string>;
  /** The directory's own denies (`Require all denied`, `Deny from all`), each with its methods. */
  denyAll: HtaccessDenyMethods[];
  /** The denies of its `<Files>`/`<FilesMatch>` blocks. */
  denyFiles: HtaccessFilesDeny[];
  redirectMatches: HtaccessRedirectMatch[];
  rules: HtaccessRewriteRule[];
}

export interface HtaccessVfsProbe {
  isFile(relPath: string): boolean;
  isDir(relPath: string): boolean;
  fileSize?(relPath: string): number;
}

export interface HtaccessEvalInput {
  /** Normalized pathname starting with `/` (e.g. `"/signin"` or `"/blogs/search/hello"`). */
  pathname: string;
  /** Raw query string without leading `?`. */
  query: string;
  method: string;
  host?: string;
  headers?: Record<string, string>;
  https?: boolean;
}

export type HtaccessEvalResult =
  /** Refused: 403 for a deny or `[F]`, 410 for `[G]`, or the status of a `RedirectMatch` (400 or more). */
  | { action: 'deny'; status: number }
  | { action: 'redirect'; status: number; location: string }
  | { action: 'rewrite'; pathname: string; query: string; rewritten: boolean };

/**
 * What Rust's `char::is_whitespace` is true of, where the Rust host cuts a line into words:
 * JavaScript's `\s` without the byte-order mark, and with U+0085.
 */
const isApacheSpace = (ch: string) => ch.codePointAt(0) !== 0xfeff && /[\s\u0085]/.test(ch);

/**
 * Split an Apache directive line into its words as the hosts do: apart at spaces, with quotes
 * holding one together and, inside double quotes, a backslash taking the next character as it is.
 */
function tokenizeDirective(line: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  const chars = Array.from(line);

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (quote) {
      if (ch === '\\' && quote === '"') {
        if (i + 1 < chars.length) cur += chars[++i];
      } else if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      hasToken = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (isApacheSpace(ch)) {
      if (hasToken) {
        tokens.push(cur);
        cur = '';
        hasToken = false;
      }
    } else {
      cur += ch;
      hasToken = true;
    }
  }
  if (hasToken) tokens.push(cur);
  return tokens;
}

const MAX_HTACCESS_REGEX_INPUT_LEN = 512;
const MAX_HTACCESS_UNBOUNDED_QUANTIFIERS = 3;

/** Parse a `{m}` / `{m,}` / `{m,n}` quantifier starting at `i`. Returns null if literal `{`. */
function parseBraceQuantifier(
  pattern: string,
  i: number
): { end: number; repeatsMoreThanOnce: boolean; unbounded: boolean } | null {
  if (pattern[i] !== '{') return null;
  const close = pattern.indexOf('}', i + 1);
  if (close <= i + 1) return null;
  const spec = pattern.slice(i + 1, close);
  const m = /^(\d+)(?:,(\d*))?$/.exec(spec);
  if (!m) return null;
  const min = Number(m[1]);
  const hasComma = spec.includes(',');
  const maxStr = m[2];
  if (!hasComma) {
    return { end: close, repeatsMoreThanOnce: min > 1, unbounded: min > 16 };
  }
  if (!maxStr) {
    return { end: close, repeatsMoreThanOnce: true, unbounded: true };
  }
  const max = Number(maxStr);
  return { end: close, repeatsMoreThanOnce: max > 1, unbounded: max > 16 || max > min };
}

/**
 * Rejects ReDoS-prone regexes: overly long patterns, nested quantifiers across arbitrary group
 * nesting (including `?` and `{m,n}`), quantified alternations (`(a|a)+`), backreferences
 * (`\1`–`\9`, `\k`), quantifiers inside lookarounds, excessive variable/unbounded quantifiers,
 * and adjacent quantified atoms (`.*.*`, `(a+)(a+)`, `a+a+`).
 */
function hasUnsafeRegexStructure(pattern: string, maxLength: number): boolean {
  if (pattern.length > maxLength) return true;
  // Reject adjacent wildcard/variable quantifiers (`.*.*`, `a+a+`, `\w+\w+`, `(a+)(a+)`) which cause polynomial ReDoS.
  if (/(?:^|[^\\])\.[*+]\??\.[*+]/.test(pattern)) return true;
  if (/(?:(?<!\\)\*|(?<!\\)\+|\{\d+,\d*\})\??(?:\([^)]*\)|\[[^\]]*\]|\\.|[^|()[\]{}*+?])(?:(?<!\\)\*|(?<!\\)\+|\{\d+,\d*\})/.test(pattern)) {
    // Allow disjoint character classes such as `[a-z]+[0-9]+` (common in URL slugs/IDs),
    // while blocking overlapping/identical quantified runs.
    const m = /(?:\[([^\]]+)\]|([a-zA-Z0-9.])|(\\[dDwWsS]))(?:(?<!\\)\*|(?<!\\)\+|\{\d+,\d*\})\??(?:\[([^\]]+)\]|([a-zA-Z0-9.])|(\\[dDwWsS]))(?:(?<!\\)\*|(?<!\\)\+|\{\d+,\d*\})/.exec(pattern);
    if (!m || !m[1] || !m[4] || m[1] === m[4]) return true;
  }
  if (/\([^)]*(?:(?<!\\)[*+]|\{\d+,\d*\})[^)]*\)\s*\([^)]*(?:(?<!\\)[*+]|\{\d+,\d*\})[^)]*\)/.test(pattern)) return true;

  interface GroupFrame {
    hasQuantifier: boolean;
    hasAlternation: boolean;
    isLookaround: boolean;
  }
  const stack: GroupFrame[] = [];
  let inCharClass = false;
  let escaped = false;
  let prevWasQuantifier = false;
  let unboundedCount = 0;

  const markQuantifier = (unbounded: boolean): boolean => {
    if (unbounded) {
      unboundedCount++;
      if (unboundedCount > MAX_HTACCESS_UNBOUNDED_QUANTIFIERS) return true;
    }
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].isLookaround) return true;
    }
    if (stack.length > 0) stack[stack.length - 1].hasQuantifier = true;
    return false;
  };

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (escaped) {
      // Backreferences (numbered or named) can trigger exponential backtracking in JS engines.
      if (!inCharClass && ((ch >= '1' && ch <= '9') || ch === 'k')) return true;
      escaped = false;
      prevWasQuantifier = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (inCharClass) {
      if (ch === ']') {
        inCharClass = false;
        prevWasQuantifier = false;
      }
      continue;
    }
    if (ch === '[') {
      inCharClass = true;
      prevWasQuantifier = false;
      continue;
    }
    if (ch === '(') {
      let isLookaround = false;
      if (pattern[i + 1] === '?') {
        const next2 = pattern[i + 2];
        const next3 = pattern[i + 3];
        if (next2 === '=' || next2 === '!') {
          isLookaround = true;
          i += 2;
        } else if (next2 === '<' && (next3 === '=' || next3 === '!')) {
          isLookaround = true;
          i += 3;
        } else if (next2 === ':') {
          i += 2;
        } else if (next2 === '<') {
          const nameEnd = pattern.indexOf('>', i + 3);
          if (nameEnd > i + 2) i = nameEnd;
          else i += 1;
        } else {
          i += 1;
        }
      }
      stack.push({ hasQuantifier: false, hasAlternation: false, isLookaround });
      prevWasQuantifier = false;
      continue;
    }
    if (ch === ')') {
      const frame = stack.pop();
      if (!frame) {
        prevWasQuantifier = false;
        continue;
      }
      const next = pattern[i + 1];
      const brace = next === '{' ? parseBraceQuantifier(pattern, i + 1) : null;
      const repeats = next === '*' || next === '+' || Boolean(brace?.repeatsMoreThanOnce);
      const optional = next === '?' || (brace !== null && !brace.repeatsMoreThanOnce);
      if (repeats) {
        if (frame.hasQuantifier || frame.hasAlternation || frame.isLookaround) return true;
        if (markQuantifier(next === '*' || next === '+' || Boolean(brace?.unbounded))) return true;
        if (brace) i = brace.end;
        else i += 1;
        prevWasQuantifier = true;
      } else if (optional) {
        if (frame.isLookaround) return true;
        if (markQuantifier(false)) return true;
        if (stack.length > 0 && frame.hasAlternation) stack[stack.length - 1].hasAlternation = true;
        if (brace) i = brace.end;
        else i += 1;
        prevWasQuantifier = true;
      } else {
        if (stack.length > 0) {
          if (frame.hasQuantifier) stack[stack.length - 1].hasQuantifier = true;
          if (frame.hasAlternation) stack[stack.length - 1].hasAlternation = true;
        }
        prevWasQuantifier = false;
      }
      continue;
    }
    if (ch === '|' && stack.length > 0) {
      stack[stack.length - 1].hasAlternation = true;
      prevWasQuantifier = false;
      continue;
    }
    if (ch === '+' || ch === '*') {
      if (markQuantifier(true)) return true;
      prevWasQuantifier = true;
      continue;
    }
    if (ch === '?') {
      if (prevWasQuantifier) {
        // Lazy modifier (`*?`, `+?`, `??`, `{m,n}?`) — not a new quantifier.
        prevWasQuantifier = false;
      } else {
        if (markQuantifier(false)) return true;
        prevWasQuantifier = true;
      }
      continue;
    }
    if (ch === '{') {
      const brace = parseBraceQuantifier(pattern, i);
      if (brace) {
        if (markQuantifier(brace.unbounded)) return true;
        i = brace.end;
        prevWasQuantifier = true;
        continue;
      }
    }
    prevWasQuantifier = false;
  }
  return false;
}

/** A pattern as a RegExp, or null for one the guard turns away (longer than `maxLength` among them) or that does not compile. */
function safeCompileRegex(pattern: string, flags = '', maxLength = 512): RegExp | null {
  if (hasUnsafeRegexStructure(pattern, maxLength)) return null;
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

function normalizeHtaccessPathname(raw: string): string {
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  const trailing = withSlash.length > 1 && withSlash.endsWith('/');
  const resolved: string[] = [];
  for (const seg of withSlash.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (resolved.length > 0) resolved.pop();
      continue;
    }
    resolved.push(seg);
  }
  return '/' + resolved.join('/') + (trailing && resolved.length > 0 ? '/' : '');
}

/** Lower and upper case as Apache takes them: of A to Z only. */
const asciiLower = (text: string) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());
const asciiUpper = (text: string) => text.replace(/[a-z]/g, (c) => c.toUpperCase());

/** The flags of a RewriteRule or RewriteCond (`[L,QSA]`), each as written, as the hosts read them. */
function parseFlags(raw: string | undefined): string[] {
  return (raw ?? '').replace(/^\[+/, '').replace(/\]+$/, '').split(',').map((flag) => flag.trim());
}

/** The status of a RewriteRule's `[R=…]` (given in upper case): PERMANENT, TEMP, or 300 to 399; else 302. */
function redirectFlagStatus(value: string): number {
  if (value === 'PERMANENT') return 301;
  if (value === 'TEMP') return 302;
  const code = /^\+?[0-9]+$/.test(value) ? Number(value) : NaN;
  return code >= 300 && code < 400 ? code : 302;
}

/**
 * What a RedirectMatch's first word says: the status it gives, and where its pattern is. A
 * keyword, or a status from 300 to 599, comes before the pattern; any other word is the pattern
 * itself, with 302.
 */
const REDIRECT_KEYWORDS = new Map([['permanent', 301], ['temp', 302], ['seeother', 303], ['gone', 410]]);
function redirectMatchStatus(word: string): { status: number; patternAt: number } {
  const keyword = REDIRECT_KEYWORDS.get(asciiLower(word));
  if (keyword) return { status: keyword, patternAt: 2 };
  const code = /^\+?[0-9]+$/.test(word) ? Number(word) : NaN;
  return code >= 300 && code <= 599 ? { status: code, patternAt: 2 } : { status: 302, patternAt: 1 };
}

/** The largest `.htaccess` that is read (as UTF-8), and the most denies kept from one. */
const MAX_HTACCESS_BYTES = 64 * 1024;
const MAX_HTACCESS_DENY = 64;
/** The most RewriteRule and RedirectMatch lines read from one, and RewriteCond lines before one rule. */
const MAX_HTACCESS_RULES = 256;
const MAX_HTACCESS_CONDS = 64;
/** The longest `<Files>`, `<Files ~>` or `<FilesMatch>` pattern read, in bytes, as the hosts count it. */
const MAX_HTACCESS_FILES_PATTERN_BYTES = 512;

/** Sections whose condition is not evaluated: nothing in them is read. */
const UNEVALUATED_SECTIONS = new Set(['if', 'elseif', 'else']);

/**
 * Whether a line is `Deny from all` or `Require all denied`: by its words, in any case and with
 * any run of spaces and tabs between them, as Apache reads a directive (so `Deny from
 * all.example.com` is not one).
 */
function isApacheDenyAll(line: string): boolean {
  const words = line.split(/[ \t]+/).filter(Boolean).slice(0, 3).map(asciiLower);
  const said = words.join(' ');
  return words.length === 3 && (said === 'deny from all' || said === 'require all denied');
}

const apacheMethod = (name: string) => (name === 'HEAD' ? 'GET' : name);

/** The methods of a `<Limit methods>` (`except`: `<LimitExcept methods>`); one that names none, all. */
function denyMethodsOfSection(except: boolean, args: string): HtaccessDenyMethods {
  const methods = tokenizeDirective(args).map(apacheMethod);
  if (!except && methods.length === 0) return null;
  return { except, methods };
}

const denyMethodsKey = (scope: HtaccessDenyMethods) => (scope ? JSON.stringify([scope.except, scope.methods]) : 'all');

/** Whether a deny is for a request made with `method`, taken in upper case. */
function denyApplies(scope: HtaccessDenyMethods, method: string): boolean {
  if (!scope) return true;
  const listed = scope.methods.includes(apacheMethod(asciiUpper(method)));
  return scope.except ? !listed : listed;
}

/**
 * The section tag a line is, if it starts as one does (with `<` and a letter, or with `</`):
 * for `<Name args>`, `<Name>` or `</Name>`, whether it closes the section, its lower-cased name,
 * and what sits between the name and the `>`. `'malformed'` for a line that starts as a tag
 * does and is not one Apache reads, which it answers with 500 for everything under the
 * directory: an opening tag whose name runs into its arguments or that does not end with its
 * `>` (`<Files "secret.txt"`), or a closing tag that is not `</Name>` alone (`</Files >`,
 * `</Files`). Apache passes over words after a tag's `>` after some tags and not others; here a
 * tag is its whole line, and they are malformed too. As the hosts read it.
 */
function parseSectionTag(line: string): { closing: boolean; name: string; args: string } | 'malformed' | null {
  if (line.startsWith('</')) {
    const close = /^<\/([A-Za-z]+)>$/.exec(line);
    return close ? { closing: true, name: close[1].toLowerCase(), args: '' } : 'malformed';
  }
  const open = /^<([A-Za-z]+)([\s\S]*)$/.exec(line);
  if (!open) return null;
  // The name, then its `>`, or a space and the arguments and then the `>` that ends the line.
  const afterName = open[2];
  if (afterName !== '>' && !(isApacheSpace(afterName[0] ?? '') && afterName.endsWith('>'))) return 'malformed';
  return { closing: false, name: open[1].toLowerCase(), args: afterName.slice(0, -1).trim() };
}

/**
 * The pattern of a `<Files>`/`<FilesMatch>` header, unquoted, and whether it is a regular
 * expression: `<FilesMatch regex>` and `<Files ~ regex>` hold one, `<Files name>` a wildcard
 * name. As the hosts take it.
 */
function filesBlockPattern(name: string, args: string): { pattern: string; isRegex: boolean } {
  const unquote = (s: string) => s.trim().replace(/^["']+|["']+$/g, '');
  const tilde = name === 'files' && /^~\s/.test(args);
  return { pattern: unquote(tilde ? args.slice(1) : args), isRegex: name === 'filesmatch' || tilde };
}

/** The matcher of a `<Files>`/`<FilesMatch>` pattern, by any case. Null when it does not compile here. */
function compileFilesBlockMatcher({ pattern, isRegex }: { pattern: string; isRegex: boolean }): RegExp | null {
  if (isRegex) return safeCompileRegex(pattern, 'i');
  // A name is held to MAX_HTACCESS_FILES_PATTERN_BYTES; the pattern made of it is longer than
  // the name, and is not held to the guard's length.
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return safeCompileRegex(`^${escaped}$`, 'i', Infinity);
}

function normalizeDirPrefix(dirPrefix: string): string {
  return dirPrefix.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function emptyHtaccess(dirPrefix: string): ParsedHtaccess {
  return {
    dirPrefix: normalizeDirPrefix(dirPrefix),
    rewriteEngine: false,
    rewriteBase: null,
    directoryIndex: [],
    allowIndexes: false,
    errorDocuments: {},
    denyAll: [],
    denyFiles: [],
    redirectMatches: [],
    rules: [],
  };
}

/** Parse one `.htaccess` file into a structured ruleset, as the server hosts read it. */
export function parseHtaccess(source: string, dirPrefix = ''): ParsedHtaccess {
  const result = emptyHtaccess(dirPrefix);
  // A rules file that cannot be read in full, holds more denies, rules or conditions than are
  // kept, or a <Files> pattern longer than is read, or whose sections do not match up or have a
  // tag Apache does not read, says who may not have what and cannot be asked: nobody has
  // anything under it. Read as far as it went, it let through what the rest refused.
  const closed = (): ParsedHtaccess => ({ ...emptyHtaccess(dirPrefix), denyAll: [null] });
  if (source.length > MAX_HTACCESS_BYTES || new TextEncoder().encode(source).length > MAX_HTACCESS_BYTES) return closed();

  let pendingConds: HtaccessRewriteCond[] = [];
  // The <Files>/<FilesMatch> block being read: its matcher and the methods its denies are for.
  // Being inside the block is kept apart from having a matcher, because a pattern that does not
  // compile here still opens a block, whose lines must not be read as the directory's own:
  // `Require all denied` under Drupal's stock <FilesMatch> would then refuse every request.
  let block: { matcher: RegExp | null; methods: HtaccessDenyMethods[] } | null = null;
  // How deep the line sits in <If>, <ElseIf> and <Else>, whose lines are skipped.
  let unevaluatedDepth = 0;
  // The <Limit>/<LimitExcept> sections the line sits in; where they nest, a deny is for every method.
  const limits: HtaccessDenyMethods[] = [];
  // The sections the line sits in, by name, the innermost last.
  const sections: string[] = [];
  const tooManyDenies = (pending: number) => result.denyAll.length + result.denyFiles.length + pending > MAX_HTACCESS_DENY;
  // Counted as they are read, compiled or not, so that the hosts, whose pattern engines differ
  // from this one, close the directory at the same line.
  let rewriteRulesRead = 0;
  let redirectMatchesRead = 0;

  const lines = source.split(/\r?\n/);
  for (const rawLine of lines) {
    // Trimmed as the hosts trim a line: Rust's whitespace, with the byte-order mark.
    const trimmed = rawLine.replace(/^[\s\u0085]+|[\s\u0085]+$/g, '');
    if (!trimmed || trimmed.startsWith('#')) continue;

    const tag = parseSectionTag(trimmed);
    if (tag === 'malformed') return closed();
    if (tag) {
      if (!tag.closing) sections.push(tag.name);
      else if (sections.pop() !== tag.name) return closed();
      if (UNEVALUATED_SECTIONS.has(tag.name)) {
        unevaluatedDepth = tag.closing ? Math.max(0, unevaluatedDepth - 1) : unevaluatedDepth + 1;
      } else if (unevaluatedDepth > 0) {
        // Skipped with the rest of the section.
      } else if (tag.name === 'limit' || tag.name === 'limitexcept') {
        if (tag.closing) limits.pop();
        else limits.push(denyMethodsOfSection(tag.name === 'limitexcept', tag.args));
      } else if (tag.name === 'files' || tag.name === 'filesmatch') {
        if (!tag.closing) {
          // A pattern over the limit is not read, and what it would have named cannot be worked
          // out: nobody has anything under the directory. It used to be read as one that does
          // not compile, which denies nothing.
          const files = filesBlockPattern(tag.name, tag.args);
          if (new TextEncoder().encode(files.pattern).length > MAX_HTACCESS_FILES_PATTERN_BYTES) return closed();
          block = { matcher: compileFilesBlockMatcher(files), methods: [] };
        } else {
          const matcher = block?.matcher;
          if (block && matcher) {
            for (const methods of block.methods) result.denyFiles.push({ matcher, methods });
            if (tooManyDenies(0)) return closed();
          }
          block = null;
        }
      }
      // <IfModule> and the like: the body applies as written.
      continue;
    }
    if (unevaluatedDepth > 0) continue;
    if (isApacheDenyAll(trimmed)) {
      const methods = limits.length === 1 ? limits[0] : null;
      // Said twice (`Require all denied` and, for an older Apache, `Deny from all`) is said once.
      const kept = block ? block.methods : result.denyAll;
      if (!kept.some((other) => denyMethodsKey(other) === denyMethodsKey(methods))) kept.push(methods);
      if (tooManyDenies(block ? block.methods.length : 0)) return closed();
      continue;
    }
    // Nothing else is read inside a block or a method section.
    if (block || limits.length > 0) continue;

    const tokens = tokenizeDirective(trimmed);
    if (tokens.length === 0) continue;
    const directive = asciiLower(tokens[0]);

    if (directive === 'rewriteengine' && tokens.length >= 2) {
      result.rewriteEngine = asciiLower(tokens[1]) === 'on';
      continue;
    }

    if (directive === 'rewritebase' && tokens.length >= 2) {
      result.rewriteBase = tokens[1];
      continue;
    }

    if (directive === 'directoryindex' && tokens.length >= 2) {
      result.directoryIndex = tokens.slice(1);
      continue;
    }

    if (directive === 'options') {
      for (const opt of tokens.slice(1)) {
        if (opt.toLowerCase() === '+indexes' || opt.toLowerCase() === 'indexes') {
          result.allowIndexes = true;
        } else if (opt.toLowerCase() === '-indexes') {
          result.allowIndexes = false;
        }
      }
      continue;
    }

    if (directive === 'errordocument' && tokens.length >= 3) {
      const code = Number(tokens[1]);
      if (Number.isInteger(code) && code >= 400 && code <= 599) {
        result.errorDocuments[code] = tokens.slice(2).join(' ');
      }
      continue;
    }

    if (directive === 'redirectmatch' && tokens.length >= 2) {
      if (++redirectMatchesRead > MAX_HTACCESS_RULES) return closed();
      const { status, patternAt } = redirectMatchStatus(tokens[1]);
      const pat = tokens[patternAt];
      const target = tokens[patternAt + 1] ?? null;
      const rx = pat !== undefined ? safeCompileRegex(pat) : null;
      if (rx) {
        result.redirectMatches.push({ status, regex: rx, target });
      }
      continue;
    }

    if (directive === 'rewritecond' && tokens.length >= 3) {
      if (pendingConds.length >= MAX_HTACCESS_CONDS) return closed();
      const testString = tokens[1];
      let rawPat = tokens[2];
      let negated = false;
      if (rawPat.startsWith('!')) {
        negated = true;
        rawPat = rawPat.slice(1);
      }
      const flags = parseFlags(tokens[3]);
      let nocase = false;
      let orNext = false;
      for (const f of flags) {
        const up = asciiUpper(f);
        if (up === 'NC' || up === 'NOCASE') nocase = true;
        if (up === 'OR' || up === 'ORNEXT') orNext = true;
      }
      const isSpecialCond =
        rawPat === '-f' ||
        rawPat === '-F' ||
        rawPat === '-d' ||
        rawPat === '-s' ||
        rawPat === '-l' ||
        rawPat === '-L' ||
        rawPat.startsWith('=');
      const regex = isSpecialCond ? null : safeCompileRegex(rawPat, nocase ? 'i' : '');
      pendingConds.push({ testString, pattern: rawPat, regex, negated, nocase, orNext });
      continue;
    }

    if (directive === 'rewriterule' && tokens.length >= 3) {
      if (++rewriteRulesRead > MAX_HTACCESS_RULES) return closed();
      // A leading `!` negates the pattern (it is not a part of it), as Apache reads it.
      const negated = tokens[1].startsWith('!');
      const pat = negated ? tokens[1].slice(1) : tokens[1];
      const substitution = tokens[2];
      const flags = parseFlags(tokens[3]);
      let last = false;
      let end = false;
      let qsa = false;
      let nocase = false;
      let escapeBackrefs = false;
      let forbidden = false;
      let gone = false;
      let redirectStatus: number | null = null;
      for (const f of flags) {
        const up = asciiUpper(f);
        if (up === 'L' || up === 'LAST') last = true;
        if (up === 'END') {
          end = true;
          last = true;
        }
        if (up === 'QSA' || up === 'QSAPPEND') qsa = true;
        if (up === 'NC' || up === 'NOCASE') nocase = true;
        if (up === 'B' || up === 'BNP') escapeBackrefs = true;
        if (up === 'F' || up === 'FORBIDDEN') {
          forbidden = true;
          last = true;
        }
        if (up === 'G' || up === 'GONE') {
          gone = true;
          last = true;
        }
        if (up === 'R') redirectStatus = 302;
        else if (up.startsWith('R=')) redirectStatus = redirectFlagStatus(up.slice(2));
      }
      const rx = safeCompileRegex(pat, nocase ? 'i' : '');
      if (rx) {
        result.rules.push({
          pattern: pat,
          regex: rx,
          negated,
          substitution,
          conds: pendingConds,
          last,
          end,
          qsa,
          nocase,
          escapeBackrefs,
          redirectStatus,
          forbidden,
          gone,
        });
      }
      pendingConds = [];
      continue;
    }
  }

  if (sections.length > 0) return closed();
  return result;
}

/** Headers never read into a rule. */
const UNREAD_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization']);

function expandVariables(
  expr: string,
  state: {
    relPath: string;
    fullPath: string;
    query: string;
    method: string;
    host: string;
    https: boolean;
    headers: Record<string, string>;
  }
): string {
  return expr.replace(/%\{([^}]+)\}/g, (_m, varName: string) => {
    const up = varName.toUpperCase();
    if (up === 'REQUEST_FILENAME') return state.relPath;
    if (up === 'REQUEST_URI') return state.fullPath;
    if (up === 'QUERY_STRING') return state.query;
    if (up === 'REQUEST_METHOD') return state.method;
    if (up === 'HTTP_HOST') return state.host;
    if (up === 'HTTPS') return state.https ? 'on' : 'off';
    // A header, but never the Cookie or an authorization, as on the hosts.
    let hdrName: string | null = null;
    if (up.startsWith('HTTP:')) hdrName = asciiLower(varName.slice(5));
    else if (up.startsWith('HTTP_')) hdrName = asciiLower(varName.slice(5)).replace(/_/g, '-');
    if (hdrName === null || UNREAD_HEADERS.has(hdrName)) return '';
    return Object.prototype.hasOwnProperty.call(state.headers, hdrName) ? state.headers[hdrName] : '';
  });
}

function evaluateCond(
  cond: HtaccessRewriteCond,
  state: {
    relPath: string;
    fullPath: string;
    query: string;
    method: string;
    host: string;
    https: boolean;
    headers: Record<string, string>;
  },
  vfs: HtaccessVfsProbe
): { matched: boolean; groups: string[] } {
  const testVal = expandVariables(cond.testString, state);
  let rawMatched = false;
  let groups: string[] = [];

  if (cond.pattern === '-f' || cond.pattern === '-F') {
    const clean = testVal.replace(/^\/+/, '');
    rawMatched = clean.length > 0 && vfs.isFile(clean);
  } else if (cond.pattern === '-d') {
    const clean = testVal.replace(/^\/+/, '').replace(/\/+$/, '');
    rawMatched = clean.length === 0 || vfs.isDir(clean);
  } else if (cond.pattern === '-s') {
    const clean = testVal.replace(/^\/+/, '');
    rawMatched = clean.length > 0 && vfs.isFile(clean) && (vfs.fileSize ? vfs.fileSize(clean) > 0 : true);
  } else if (cond.pattern === '-l' || cond.pattern === '-L') {
    rawMatched = false;
  } else if (cond.pattern.startsWith('=')) {
    const rhs = cond.pattern.slice(1);
    rawMatched = cond.nocase ? testVal.toLowerCase() === rhs.toLowerCase() : testVal === rhs;
  } else {
    const rx = cond.regex !== undefined ? cond.regex : safeCompileRegex(cond.pattern, cond.nocase ? 'i' : '');
    if (rx) {
      const m = rx.exec(testVal.slice(0, MAX_HTACCESS_REGEX_INPUT_LEN));
      if (m) {
        rawMatched = true;
        groups = m.slice(1).map((g) => g ?? '');
      }
    }
  }

  return {
    matched: cond.negated ? !rawMatched : rawMatched,
    groups: cond.negated ? [] : groups,
  };
}

function applyBackrefs(
  substitution: string,
  ruleGroups: string[],
  condGroups: string[],
  escapeBackrefs: boolean
): string {
  const encode = (s: string) => (escapeBackrefs ? encodeURIComponent(s) : s);
  return substitution.replace(/\$(\d)|%(\d)/g, (_m, rd: string | undefined, cd: string | undefined) => {
    if (rd !== undefined) {
      const idx = Number(rd);
      return idx === 0 ? '' : encode(ruleGroups[idx - 1] ?? '');
    }
    const idx = Number(cd);
    return idx === 0 ? '' : encode(condGroups[idx - 1] ?? '');
  });
}

function evaluateHtaccessAccessGuards(
  htaccess: ParsedHtaccess,
  cleanPathname: string,
  vfs: HtaccessVfsProbe,
  method: string
): HtaccessEvalResult | null {
  // 1. The directory's own denies, for what is under it and the directory itself.
  if (htaccess.denyAll.some((methods) => denyApplies(methods, method))) {
    return { action: 'deny', status: 403 };
  }

  // 2. <Files>/<FilesMatch> blocks: for the file the request is mapped to, which is the last
  //    segment, and a segment before it that is a file (the rest is its PATH_INFO).
  const denyFiles = htaccess.denyFiles.filter(({ methods }) => denyApplies(methods, method));
  if (denyFiles.length > 0) {
    const segs = cleanPathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    const basenamesToCheck = new Set<string>();
    if (segs.length > 0) basenamesToCheck.add(segs[segs.length - 1]);
    let prefix = '';
    for (let i = 0; i < segs.length - 1; i++) {
      prefix = prefix ? `${prefix}/${segs[i]}` : segs[i];
      if (vfs.isFile(prefix)) basenamesToCheck.add(segs[i]);
    }
    for (const candidate of basenamesToCheck) {
      const cappedCandidate = candidate.slice(0, MAX_HTACCESS_REGEX_INPUT_LEN);
      for (const { matcher } of denyFiles) {
        if (matcher.test(cappedCandidate)) {
          return { action: 'deny', status: 403 };
        }
      }
    }
  }

  // 3. RedirectMatch directives: one to a status of 400 or more refuses what it matches with
  //    that status (e.g. `RedirectMatch 404 ^/content/themes/[^/]+/src/`).
  const cappedCleanPathname = cleanPathname.slice(0, MAX_HTACCESS_REGEX_INPUT_LEN);
  for (const rm of htaccess.redirectMatches) {
    const m = rm.regex.exec(cappedCleanPathname);
    if (m) {
      if (rm.status >= 400) {
        return { action: 'deny', status: rm.status };
      }
      if (rm.target) {
        const loc = applyBackrefs(rm.target, m.slice(1).map((g) => g ?? ''), [], false);
        return { action: 'redirect', status: rm.status, location: loc };
      }
    }
  }
  return null;
}

/**
 * Evaluate a parsed `.htaccess` ruleset against an incoming HTTP request.
 */
export function evaluateHtaccess(
  htaccess: ParsedHtaccess,
  input: HtaccessEvalInput,
  vfs: HtaccessVfsProbe
): HtaccessEvalResult {
  const cleanPathname = normalizeHtaccessPathname(input.pathname);
  const lowerHeaders: Record<string, string> = Object.create(null);
  if (input.headers) {
    for (const [k, v] of Object.entries(input.headers)) {
      lowerHeaders[k.toLowerCase()] = v;
    }
  }

  const initialGuard = evaluateHtaccessAccessGuards(htaccess, cleanPathname, vfs, input.method);
  if (initialGuard) return initialGuard;

  if (!htaccess.rewriteEngine || htaccess.rules.length === 0) {
    return { action: 'rewrite', pathname: cleanPathname, query: input.query, rewritten: false };
  }

  // Strip directory prefix (per-directory `.htaccess` matches paths relative to its directory, without leading `/`)
  const prefixWithSlashes = htaccess.dirPrefix ? `/${htaccess.dirPrefix}/` : '/';
  let localPath: string;
  if (htaccess.dirPrefix) {
    if (cleanPathname === `/${htaccess.dirPrefix}`) {
      localPath = '';
    } else if (cleanPathname.startsWith(prefixWithSlashes)) {
      localPath = cleanPathname.slice(prefixWithSlashes.length);
    } else {
      return { action: 'rewrite', pathname: cleanPathname, query: input.query, rewritten: false };
    }
  } else {
    localPath = cleanPathname.replace(/^\/+/, '');
  }

  let currentQuery = input.query;
  let currentFullPath = cleanPathname;
  let rewritten = false;

  const MAX_PASSES = 4;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let passChanged = false;
    let stopAll = false;

    for (const rule of htaccess.rules) {
      // A rule is for a path its pattern matches, or for one it does not when it is negated,
      // which then has no groups: its `$1`…`$9` are empty.
      const m = rule.regex.exec(localPath.slice(0, MAX_HTACCESS_REGEX_INPUT_LEN));
      if (rule.negated ? m !== null : m === null) continue;

      const relForProbe = htaccess.dirPrefix
        ? localPath
          ? `${htaccess.dirPrefix}/${localPath}`
          : htaccess.dirPrefix
        : localPath;

      const state = {
        relPath: relForProbe,
        fullPath: currentFullPath,
        query: currentQuery,
        method: input.method.toUpperCase(),
        host: input.host ?? 'app.softn.local',
        https: input.https ?? true,
        headers: lowerHeaders,
      };

      // Evaluate RewriteCond chain (supports [OR] grouping, default AND)
      let condsOk = true;
      let lastCondGroups: string[] = [];
      if (rule.conds.length > 0) {
        let groupResult = false;
        let inOrGroup = false;
        for (let i = 0; i < rule.conds.length; i++) {
          const c = rule.conds[i];
          const ev = evaluateCond(c, state, vfs);
          if (ev.matched && ev.groups.length > 0) lastCondGroups = ev.groups;
          if (c.orNext) {
            groupResult = inOrGroup ? groupResult || ev.matched : ev.matched;
            inOrGroup = true;
          } else {
            const term = inOrGroup ? groupResult || ev.matched : ev.matched;
            inOrGroup = false;
            groupResult = false;
            if (!term) {
              condsOk = false;
              break;
            }
          }
        }
        if (inOrGroup && !groupResult) condsOk = false;
      }

      if (!condsOk) continue;

      if (rule.forbidden) return { action: 'deny', status: 403 };
      if (rule.gone) return { action: 'deny', status: 410 };

      // Pass-through `-`
      if (rule.substitution === '-') {
        if (rule.last || rule.end) {
          stopAll = true;
          break;
        }
        continue;
      }

      const ruleGroups = m ? m.slice(1).map((g) => g ?? '') : [];
      // Expand server variables BEFORE applying attacker-controlled regex backreferences
      // so a captured URL segment like `%{HTTP:Cookie}` is never evaluated as an Apache variable.
      const expanded = applyBackrefs(
        expandVariables(rule.substitution, state),
        ruleGroups,
        lastCondGroups,
        rule.escapeBackrefs
      );

      // Split substitution into path + optional query
      const qIdx = expanded.indexOf('?');
      const subPath = qIdx >= 0 ? expanded.slice(0, qIdx) : expanded;
      const subQuery = qIdx >= 0 ? expanded.slice(qIdx + 1) : null;

      let nextQuery = currentQuery;
      if (subQuery !== null) {
        if (rule.qsa && currentQuery) {
          nextQuery = subQuery ? `${subQuery}&${currentQuery}` : currentQuery;
        } else {
          nextQuery = subQuery;
        }
      }

      // External or explicit redirect `[R=...]`
      if (rule.redirectStatus !== null || /^https?:\/\//i.test(subPath)) {
        const locBase = /^https?:\/\//i.test(subPath)
          ? subPath
          : subPath.startsWith('/')
            ? subPath
            : `${htaccess.rewriteBase ? htaccess.rewriteBase.replace(/\/?$/, '/') : prefixWithSlashes}${subPath}`;
        const location = nextQuery ? `${locBase}?${nextQuery}` : locBase;
        return { action: 'redirect', status: rule.redirectStatus ?? 302, location };
      }

      // Internal rewrite — always normalize dot segments and slashes so rewrites cannot smuggle traversal
      let nextFullPath: string;
      if (subPath.startsWith('/')) {
        nextFullPath = normalizeHtaccessPathname(subPath);
      } else if (htaccess.rewriteBase) {
        const base = htaccess.rewriteBase.replace(/\/?$/, '/');
        nextFullPath = normalizeHtaccessPathname(`${base}${subPath}`);
      } else {
        nextFullPath = normalizeHtaccessPathname(`${prefixWithSlashes}${subPath}`);
      }

      localPath = htaccess.dirPrefix && nextFullPath.startsWith(prefixWithSlashes)
        ? nextFullPath.slice(prefixWithSlashes.length)
        : nextFullPath.replace(/^\/+/, '');
      currentFullPath = nextFullPath;
      currentQuery = nextQuery;
      rewritten = true;
      passChanged = true;

      if (rule.end || rule.last) {
        stopAll = true;
        break;
      }
    }

    if (stopAll || !passChanged) break;
  }

  // Re-evaluate <FilesMatch> and RedirectMatch on the post-rewrite path so an internal
  // RewriteRule cannot bypass security guards by rewriting a public path to a denied file.
  if (rewritten && currentFullPath !== cleanPathname) {
    const postGuard = evaluateHtaccessAccessGuards(htaccess, currentFullPath, vfs, input.method);
    if (postGuard) return postGuard;
  }

  return {
    action: 'rewrite',
    pathname: currentFullPath,
    query: currentQuery,
    rewritten,
  };
}

/**
 * Evaluate a chain of `.htaccess` files (root first, then any deeper directory `.htaccess`
 * along the request path). If an internal rewrite changes directories, re-evaluate newly
 * applicable `.htaccess` rulesets (bounded to prevent cycles).
 */
export function evaluateHtaccessChain(
  htaccessFiles: ReadonlyMap<string, ParsedHtaccess>,
  input: HtaccessEvalInput,
  vfs: HtaccessVfsProbe
): HtaccessEvalResult {
  let curPath = normalizeHtaccessPathname(input.pathname);
  let curQuery = input.query;
  let anyRewritten = false;
  const visitedPaths = new Set<string>([curPath]);
  const MAX_CHAIN_HOPS = 6;

  for (let hop = 0; hop < MAX_CHAIN_HOPS; hop++) {
    const segments = curPath.replace(/^\/+/, '').split('/').filter(Boolean);
    const prefixes: string[] = [''];
    let acc = '';
    for (let i = 0; i < segments.length; i++) {
      acc = acc ? `${acc}/${segments[i]}` : segments[i];
      if (htaccessFiles.has(acc)) prefixes.push(acc);
    }

    let pathChangedInHop = false;
    for (const prefix of prefixes) {
      const ruleset = htaccessFiles.get(prefix);
      if (!ruleset) continue;
      const res = evaluateHtaccess(
        ruleset,
        { ...input, pathname: curPath, query: curQuery },
        vfs
      );
      if (res.action === 'deny' || res.action === 'redirect') return res;
      if (res.rewritten) {
        const nextNorm = normalizeHtaccessPathname(res.pathname);
        if (nextNorm !== curPath) pathChangedInHop = true;
        curPath = nextNorm;
        curQuery = res.query;
        anyRewritten = true;
      }
    }

    if (!pathChangedInHop || visitedPaths.has(curPath)) break;
    visitedPaths.add(curPath);
  }

  // Final access-guard sweep across all applicable .htaccess files for the final path
  const finalSegments = curPath.replace(/^\/+/, '').split('/').filter(Boolean);
  const finalPrefixes: string[] = [''];
  let finalAcc = '';
  for (let i = 0; i < finalSegments.length; i++) {
    finalAcc = finalAcc ? `${finalAcc}/${finalSegments[i]}` : finalSegments[i];
    if (htaccessFiles.has(finalAcc)) finalPrefixes.push(finalAcc);
  }
  for (const prefix of finalPrefixes) {
    const ruleset = htaccessFiles.get(prefix);
    if (!ruleset) continue;
    const guard = evaluateHtaccessAccessGuards(ruleset, curPath, vfs, input.method);
    if (guard) return guard;
  }

  return { action: 'rewrite', pathname: curPath, query: curQuery, rewritten: anyRewritten };
}
