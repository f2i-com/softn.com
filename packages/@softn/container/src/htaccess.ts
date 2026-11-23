/**
 * Apache `.htaccess` Parser & Rewrite Engine for SoftN Full-Stack Containers.
 *
 * Supports the real-world `mod_rewrite` / `mod_authz` / `mod_alias` / `mod_dir`
 * subset used by PHP web apps (including Sngine, WordPress, Slim, Laravel):
 * - `RewriteEngine On|Off`
 * - `RewriteBase /...`
 * - `RewriteCond TestString CondPattern [NC,OR]`
 *   (`%{REQUEST_FILENAME}`, `%{REQUEST_URI}`, `%{QUERY_STRING}`, `%{HTTP_HOST}`,
 *    `%{REQUEST_METHOD}`, `%{HTTPS}`, `%{HTTP:Header}`, `-f`, `!-f`, `-d`, `!-d`,
 *    `-s`, `!-s`, `-l`, `!-l`, regex & `!regex`)
 * - `RewriteRule Pattern Substitution [L,END,QSA,NC,B,R=301|302|307|308,F,G]`
 *   with `$1..$9` rule backrefs, `%1..%9` cond backrefs, and `-` pass-through
 * - `<FilesMatch "regex"> ... Deny from all / Require all denied ... </FilesMatch>`
 * - `RedirectMatch [status] pattern [target]`
 * - `DirectoryIndex file1 file2 ...`
 * - `ErrorDocument 404 /404.php`
 * - `Options -Indexes` / `+Indexes`
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
  pattern: string;
  regex: RegExp;
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

export interface ParsedHtaccess {
  /** Directory prefix this `.htaccess` applies to (`""` for root, `"admin"` for `admin/.htaccess`). */
  dirPrefix: string;
  rewriteEngine: boolean;
  rewriteBase: string | null;
  directoryIndex: string[];
  allowIndexes: boolean;
  errorDocuments: Record<number, string>;
  denyFilesPatterns: RegExp[];
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
  | { action: 'deny'; status: 403 | 404 | 410 }
  | { action: 'redirect'; status: number; location: string }
  | { action: 'rewrite'; pathname: string; query: string; rewritten: boolean };

/** Split an Apache directive line respecting single/double quotes and backslash escapes. */
function tokenizeDirective(line: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\' && i + 1 < line.length && quote === '"') {
        cur += line[++i];
      } else if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      hasToken = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (/\s/.test(ch)) {
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

const MAX_HTACCESS_REGEX_INPUT_LEN = 2048;

function isQuantifierChar(ch: string | undefined): boolean {
  return ch === '*' || ch === '+' || ch === '{';
}

/**
 * Rejects ReDoS-prone regexes: overly long patterns, nested quantifiers across arbitrary group
 * nesting (including `{m,n}`), quantified alternations (`(a|a)+`), and backreferences (`\1`–`\9`).
 */
function hasUnsafeRegexStructure(pattern: string): boolean {
  if (pattern.length > 512) return true;
  interface GroupFrame {
    hasQuantifier: boolean;
    hasAlternation: boolean;
  }
  const stack: GroupFrame[] = [];
  let inCharClass = false;
  let escaped = false;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (escaped) {
      // Backreferences inside regexes can trigger exponential backtracking in JS engines.
      if (!inCharClass && ch >= '1' && ch <= '9') return true;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (inCharClass) {
      if (ch === ']') inCharClass = false;
      continue;
    }
    if (ch === '[') {
      inCharClass = true;
      continue;
    }
    if (ch === '(') {
      stack.push({ hasQuantifier: false, hasAlternation: false });
      continue;
    }
    if (ch === ')') {
      const frame = stack.pop();
      if (!frame) continue;
      const next = pattern[i + 1];
      const quantified = isQuantifierChar(next);
      if (quantified) {
        if (frame.hasQuantifier || frame.hasAlternation) return true;
        if (stack.length > 0) stack[stack.length - 1].hasQuantifier = true;
      } else if (stack.length > 0) {
        if (frame.hasQuantifier) stack[stack.length - 1].hasQuantifier = true;
        if (frame.hasAlternation) stack[stack.length - 1].hasAlternation = true;
      }
      continue;
    }
    if (ch === '|' && stack.length > 0) {
      stack[stack.length - 1].hasAlternation = true;
      continue;
    }
    if ((ch === '+' || ch === '*') && stack.length > 0) {
      stack[stack.length - 1].hasQuantifier = true;
      continue;
    }
    if (ch === '{') {
      // Check for repetition quantifier `{m}` / `{m,}` / `{m,n}`
      const close = pattern.indexOf('}', i + 1);
      if (close > i + 1) {
        const spec = pattern.slice(i + 1, close);
        if (/^\d+(?:,\d*)?$/.test(spec)) {
          if (stack.length > 0) stack[stack.length - 1].hasQuantifier = true;
          i = close;
          continue;
        }
      }
    }
  }
  return false;
}

function safeCompileRegex(pattern: string, flags = ''): RegExp | null {
  if (hasUnsafeRegexStructure(pattern)) return null;
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

function parseFlags(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!raw || !raw.startsWith('[') || !raw.endsWith(']')) return out;
  for (const part of raw.slice(1, -1).split(',')) {
    const trimmed = part.trim();
    if (trimmed) out.add(trimmed);
  }
  return out;
}

function parseRedirectFlag(flags: Set<string>): number | null {
  for (const f of flags) {
    const m = /^R(?:=(\d{3}|permanent|temp))?$/i.exec(f);
    if (m) {
      if (!m[1] || m[1].toLowerCase() === 'temp') return 302;
      if (m[1].toLowerCase() === 'permanent') return 301;
      const code = Number(m[1]);
      if (code >= 300 && code <= 399) return code;
      return 302;
    }
  }
  return null;
}

function normalizeDirPrefix(dirPrefix: string): string {
  return dirPrefix.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

/** Parse one `.htaccess` file into a structured ruleset. */
export function parseHtaccess(source: string, dirPrefix = ''): ParsedHtaccess {
  const result: ParsedHtaccess = {
    dirPrefix: normalizeDirPrefix(dirPrefix),
    rewriteEngine: false,
    rewriteBase: null,
    directoryIndex: [],
    allowIndexes: false,
    errorDocuments: {},
    denyFilesPatterns: [],
    redirectMatches: [],
    rules: [],
  };

  let pendingConds: HtaccessRewriteCond[] = [];
  let inFilesMatchRegex: RegExp | null = null;
  let filesMatchDenied = false;

  const lines = source.split(/\r?\n/);
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Container blocks: <FilesMatch "..."> ... </FilesMatch>
    const fmOpen = /^<FilesMatch\s+["']?([^"'>]+)["']?\s*>$/i.exec(trimmed);
    if (fmOpen) {
      inFilesMatchRegex = safeCompileRegex(fmOpen[1], 'i');
      filesMatchDenied = false;
      continue;
    }
    if (/^<\/FilesMatch>$/i.test(trimmed)) {
      if (inFilesMatchRegex && filesMatchDenied) {
        result.denyFilesPatterns.push(inFilesMatchRegex);
      }
      inFilesMatchRegex = null;
      filesMatchDenied = false;
      continue;
    }
    if (inFilesMatchRegex) {
      if (/^(?:Deny\s+from\s+all|Require\s+all\s+denied)\b/i.test(trimmed)) {
        filesMatchDenied = true;
      }
      continue;
    }

    // Ignore <IfModule ...> / </IfModule> wrappers so inner rules still take effect
    if (/^<\/?IfModule\b/i.test(trimmed) || /^<\/?Files\b/i.test(trimmed) || /^<\/?Directory\b/i.test(trimmed)) {
      continue;
    }

    const tokens = tokenizeDirective(trimmed);
    if (tokens.length === 0) continue;
    const directive = tokens[0].toLowerCase();

    if (directive === 'rewriteengine' && tokens[1]) {
      result.rewriteEngine = tokens[1].toLowerCase() === 'on';
      continue;
    }

    if (directive === 'rewritebase' && tokens[1]) {
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
      let status = 302;
      let patIdx = 1;
      if (/^\d{3}$/.test(tokens[1])) {
        status = Number(tokens[1]);
        patIdx = 2;
      } else if (tokens[1].toLowerCase() === 'permanent') {
        status = 301;
        patIdx = 2;
      } else if (tokens[1].toLowerCase() === 'temp') {
        status = 302;
        patIdx = 2;
      } else if (tokens[1].toLowerCase() === 'gone') {
        status = 410;
        patIdx = 2;
      }
      const pat = tokens[patIdx];
      const target = tokens[patIdx + 1] ?? null;
      const rx = pat ? safeCompileRegex(pat) : null;
      if (rx) {
        result.redirectMatches.push({ status, regex: rx, target });
      }
      continue;
    }

    if (directive === 'rewritecond' && tokens.length >= 3) {
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
        const up = f.toUpperCase();
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
      const pat = tokens[1];
      const substitution = tokens[2];
      const flags = parseFlags(tokens[3]);
      let last = false;
      let end = false;
      let qsa = false;
      let nocase = false;
      let escapeBackrefs = false;
      let forbidden = false;
      let gone = false;
      for (const f of flags) {
        const up = f.toUpperCase();
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
      }
      const redirectStatus = parseRedirectFlag(flags);
      const rx = safeCompileRegex(pat, nocase ? 'i' : '');
      if (rx) {
        result.rules.push({
          pattern: pat,
          regex: rx,
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

  return result;
}

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
    if (up.startsWith('HTTP:')) {
      const hdrName = varName.slice(5).toLowerCase();
      return state.headers[hdrName] ?? '';
    }
    if (up.startsWith('HTTP_')) {
      const hdrName = varName.slice(5).toLowerCase().replace(/_/g, '-');
      return state.headers[hdrName] ?? '';
    }
    return '';
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

  // 1. <FilesMatch> security blocks (strip trailing slashes AND check PATH_INFO file segments)
  if (htaccess.denyFilesPatterns.length > 0) {
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
      for (const rx of htaccess.denyFilesPatterns) {
        if (rx.test(cappedCandidate)) {
          return { action: 'deny', status: 403 };
        }
      }
    }
  }

  // 2. RedirectMatch directives (e.g. `RedirectMatch 404 ^/content/themes/[^/]+/src/`)
  const cappedCleanPathname = cleanPathname.slice(0, MAX_HTACCESS_REGEX_INPUT_LEN);
  for (const rm of htaccess.redirectMatches) {
    const m = rm.regex.exec(cappedCleanPathname);
    if (m) {
      if (rm.status === 403 || rm.status === 404 || rm.status === 410) {
        return { action: 'deny', status: rm.status };
      }
      if (rm.target) {
        const loc = applyBackrefs(rm.target, m.slice(1).map((g) => g ?? ''), [], false);
        return { action: 'redirect', status: rm.status, location: loc };
      }
    }
  }

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
      const m = rule.regex.exec(localPath.slice(0, MAX_HTACCESS_REGEX_INPUT_LEN));
      if (!m) continue;

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

      const ruleGroups = m.slice(1).map((g) => g ?? '');
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

      // Internal rewrite
      let nextFullPath: string;
      if (subPath.startsWith('/')) {
        nextFullPath = subPath;
      } else if (htaccess.rewriteBase) {
        const base = htaccess.rewriteBase.replace(/\/?$/, '/');
        nextFullPath = `${base}${subPath}`.replace(/\/+/g, '/');
      } else {
        nextFullPath = `${prefixWithSlashes}${subPath}`.replace(/\/+/g, '/');
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

  return {
    action: 'rewrite',
    pathname: currentFullPath,
    query: currentQuery,
    rewritten,
  };
}

/**
 * Evaluate a chain of `.htaccess` files (root first, then any deeper directory `.htaccess`
 * along the request path) and merge their directory index / error document settings.
 */
export function evaluateHtaccessChain(
  htaccessFiles: ReadonlyMap<string, ParsedHtaccess>,
  input: HtaccessEvalInput,
  vfs: HtaccessVfsProbe
): HtaccessEvalResult {
  const cleanPath = normalizeHtaccessPathname(input.pathname);
  const segments = cleanPath.replace(/^\/+/, '').split('/').filter(Boolean);

  // Build list of applicable directory prefixes from root down to the request's folder
  const prefixes: string[] = [''];
  let acc = '';
  for (let i = 0; i < segments.length; i++) {
    acc = acc ? `${acc}/${segments[i]}` : segments[i];
    if (htaccessFiles.has(acc)) prefixes.push(acc);
  }

  let curPath = cleanPath;
  let curQuery = input.query;
  let anyRewritten = false;

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
      curPath = res.pathname;
      curQuery = res.query;
      anyRewritten = true;
    }
  }

  return { action: 'rewrite', pathname: curPath, query: curQuery, rewritten: anyRewritten };
}
