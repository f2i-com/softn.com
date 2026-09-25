/**
 * Names the markup uses that nothing defines.
 *
 * The renderer never complains about them. An identifier it cannot find
 * evaluates to undefined (render.tsx, evaluateExpression), a member of
 * undefined is undefined, `{…}` of undefined renders as nothing, `#each`
 * over it renders nothing, and a click on a handler that calls a missing
 * function does nothing (the warning it logs comes at the click, not at the
 * render). So a page whose markup reads `weekData` and calls `save()` that
 * the logic never defined renders, empty and inert, without a word — and a
 * check that only renders it passes. This reads the markup with core's own
 * parser and resolves every name against what the running logic exposes.
 *
 * Every finding is an error: the renderer's behaviour for all of them is to
 * show nothing, which no one intends.
 */

import type { Expression, SoftNDocument, TemplateNode } from '@softn/core';

/**
 * The JavaScript globals a template expression can name: render.tsx's
 * JS_GLOBALS, which core does not export. The list is checked against the
 * real evaluator by a test (templateNames.test.ts), so the two cannot drift
 * apart. `Object`, `console`, `window`, `Set` and the rest are not in it: in a
 * template they are undefined.
 */
export const TEMPLATE_GLOBALS: readonly string[] = [
  'Number',
  'String',
  'Boolean',
  'Array',
  'Date',
  'Math',
  'JSON',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'NaN',
  'Infinity',
  'undefined',
  'encodeURIComponent',
  'decodeURIComponent',
];

/**
 * Functions the hosts add to every render: `asset()` (the web and desktop
 * runtimes and Studio's preview), and the `xdb_*` helpers SoftNWithXDB — what
 * the players render with — merges in.
 */
export const HOST_FUNCTIONS: readonly string[] = [
  'asset',
  'xdb_create',
  'xdb_update',
  'xdb_delete',
  'xdb_getAll',
  'xdb_query',
  'xdb_get',
  'xdb_count',
  'xdb_clear',
  'xdb_sync',
  'xdb_startSync',
  'xdb_stopSync',
  'xdb_getSyncStatus',
  'xdb_getSavedSyncRoom',
  'xdb_getDbPath',
];

/** JavaScript globals a model reaches for that a template does not have. */
const UNAVAILABLE_GLOBALS = new Set([
  'Object', 'Set', 'Map', 'WeakMap', 'Promise', 'Intl', 'RegExp', 'Symbol', 'BigInt', 'Error', 'Reflect', 'Function',
  'console', 'window', 'document', 'globalThis', 'localStorage', 'sessionStorage', 'navigator', 'location', 'fetch',
  'setTimeout', 'setInterval', 'structuredClone', 'crypto', 'performance',
]);

/** What the page's logic exposes, as the runtime loaded it. */
export interface LogicNames {
  state: Set<string>;
  functions: Set<string>;
  computed: Set<string>;
}

/** One .ui file to check: its path, its parsed document, and the component tags it imports. */
export interface TemplateFile {
  path: string;
  doc: SoftNDocument;
  /** Tags that are <import>ed .ui files: the composer pastes their markup and drops the tag's props and children. */
  importedTags: Set<string>;
}

export interface NameCheckInput {
  files: TemplateFile[];
  logic: LogicNames;
  /** Names the render's `data` holds whatever the page declares: the preview's seeded collections. */
  dataNames: Iterable<string>;
  /** Template helpers core adds to every render (builtinHelpers). */
  helpers: Iterable<string>;
  python: boolean;
}

type RefKind = 'call' | 'handler' | 'bind' | 'read' | 'assign';

interface Ref {
  kind: RefKind;
  name: string;
  line: number;
  /** The event, for a handler or a call inside one. */
  event?: string;
  /** Names in scope where the reference is (loop variables, arrow parameters). */
  local: Set<string>;
}

/** Edit distance with transpositions (optimal string alignment), for "did you mean". */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/**
 * The closest of `candidates` to `name`, if one is close enough to be a slip:
 * a few edits apart (a third of the name's length, at most three), the same
 * name in another case, or one that begins with the other (`save` for
 * `saveItem`).
 */
export function nearestName(name: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  const lower = name.toLowerCase();
  for (const candidate of candidates) {
    if (candidate === name) continue;
    const other = candidate.toLowerCase();
    const prefix = Math.min(lower.length, other.length) >= 3 && (other.startsWith(lower) || lower.startsWith(other));
    const distance = other === lower ? 0.5 : editDistance(lower, other);
    const limit = Math.max(1, Math.min(3, Math.floor(Math.max(name.length, candidate.length) / 3)));
    if (distance > limit && !prefix) continue;
    if (distance < bestScore || (distance === bestScore && best !== null && candidate < best)) {
      best = candidate;
      bestScore = distance;
    }
  }
  return best;
}

/** The identifier an assignment or binding writes: `a` of `a.b[c]`. */
function rootName(expr: Expression): { name: string; line: number } | null {
  let node: Expression = expr;
  while (node.type === 'MemberExpression') node = node.object;
  return node.type === 'Identifier' ? { name: node.name, line: node.loc.line } : null;
}

/** Every name an expression reads or calls, with arrow parameters in scope. */
function collect(expr: Expression, local: Set<string>, out: Ref[], handler: string | undefined): void {
  const visit = (e: Expression, scope: Set<string>) => collect(e, scope, out, handler);
  switch (expr.type) {
    case 'Identifier':
      out.push({ kind: 'read', name: expr.name, line: expr.loc.line, local, event: handler });
      return;
    case 'Literal':
      return;
    case 'MemberExpression':
      visit(expr.object, local);
      if (expr.computed) visit(expr.property, local);
      return;
    case 'CallExpression':
      if (expr.callee.type === 'Identifier') {
        out.push({ kind: 'call', name: expr.callee.name, line: expr.callee.loc.line, local, event: handler });
      } else {
        visit(expr.callee, local);
      }
      for (const arg of expr.arguments) visit(arg, local);
      return;
    case 'ArrowFunctionExpression': {
      if (typeof expr.body === 'string') return; // A block body never runs; lintTemplates says so.
      const inner = new Set(local);
      for (const param of expr.params) inner.add(param.replace(/^\.\.\./, '').replace(/\s*=.*$/, '').trim());
      visit(expr.body, inner);
      return;
    }
    case 'AssignmentExpression': {
      const root = rootName(expr.left);
      if (root) out.push({ kind: 'assign', name: root.name, line: root.line, local, event: handler });
      // A compound assignment reads its target; `a.b[i] = …` reads i whatever the operator.
      if (expr.left.type === 'MemberExpression') visit(expr.left, local);
      else if (expr.operator !== '=' && root) out.push({ kind: 'read', name: root.name, line: root.line, local, event: handler });
      visit(expr.right, local);
      return;
    }
    case 'BinaryExpression':
      visit(expr.left, local);
      visit(expr.right, local);
      return;
    case 'UnaryExpression':
      visit(expr.argument, local);
      return;
    case 'ConditionalExpression':
      visit(expr.test, local);
      visit(expr.consequent, local);
      visit(expr.alternate, local);
      return;
    case 'ObjectExpression':
      for (const property of expr.properties) visit(property.value, local);
      return;
    case 'ArrayExpression':
      for (const element of expr.elements) visit(element, local);
      return;
    case 'SpreadElement':
      visit(expr.argument, local);
      return;
    case 'TemplateLiteral':
      for (const part of expr.expressions) visit(part, local);
      return;
    default:
      return;
  }
}

/** A handler: `@click={save}` names a function; anything else is read as an expression whose calls are the handler's. */
function collectHandler(expr: Expression, local: Set<string>, out: Ref[], event: string): void {
  if (expr.type === 'Identifier') {
    out.push({ kind: 'handler', name: expr.name, line: expr.loc.line, local, event });
    return;
  }
  collect(expr, local, out, event);
}

/** Every reference in a file's template, each with the loop variables and parameters in scope where it is. */
export function templateReferences(file: TemplateFile): Ref[] {
  const out: Ref[] = [];
  const walkNodes = (nodes: TemplateNode[] | undefined, local: Set<string>) => {
    for (const node of nodes ?? []) walk(node, local);
  };
  const walk = (node: TemplateNode, local: Set<string>): void => {
    switch (node.type) {
      case 'Element': {
        // An imported component's tag is replaced by its markup: its props and children never render.
        if (file.importedTags.has(node.tag)) return;
        let scope = local;
        if (node.inlineEach) {
          collect(node.inlineEach.iterable, local, out, undefined);
          scope = new Set(local);
          scope.add(node.inlineEach.itemName);
          if (node.inlineEach.indexName) scope.add(node.inlineEach.indexName);
        }
        if (node.conditionalIf) collect(node.conditionalIf, scope, out, undefined);
        for (const prop of node.props) {
          if (prop.value.type !== 'expression') continue;
          const value = prop.value.value;
          // `onClick={…}` is a callback, read the way an event is.
          const callback = prop.name.startsWith('on') && prop.name.length > 2 && /[A-Z]/.test(prop.name[2]);
          if (callback) collectHandler(value, scope, out, prop.name);
          else collect(value, scope, out, undefined);
        }
        for (const event of node.events) collectHandler(event.handler, scope, out, `@${event.name}`);
        for (const binding of node.bindings) {
          if (binding.name === 'bind') {
            const root = rootName(binding.expression);
            if (root) out.push({ kind: 'bind', name: root.name, line: root.line, local: scope });
            if (binding.expression.type === 'MemberExpression') collect(binding.expression, scope, out, undefined);
          } else {
            collect(binding.expression, scope, out, undefined);
          }
        }
        walkNodes(node.children, scope);
        return;
      }
      case 'Expression':
        collect(node.expression, local, out, undefined);
        return;
      case 'IfBlock': {
        collect(node.condition, local, out, undefined);
        walkNodes(node.consequent, local);
        const alternate = node.alternate;
        if (Array.isArray(alternate)) walkNodes(alternate, local);
        else if (alternate) walk(alternate, local);
        return;
      }
      case 'EachBlock': {
        collect(node.iterable, local, out, undefined);
        const inner = new Set(local);
        inner.add(node.itemName);
        if (node.indexName) inner.add(node.indexName);
        if (node.keyExpression) collect(node.keyExpression, inner, out, undefined);
        walkNodes(node.body, inner);
        walkNodes(node.emptyFallback, local);
        return;
      }
      case 'Slot':
        walkNodes(node.fallback, local);
        return;
      case 'TemplateSlot':
        walkNodes(node.children, local);
        return;
      default:
        return;
    }
  };
  walkNodes(file.doc.template, new Set());
  return out;
}

const list = (names: Iterable<string>, max = 8): string => {
  const sorted = [...names].sort();
  if (sorted.length === 0) return '(none)';
  return sorted.length > max ? `${sorted.slice(0, max).join(', ')} and ${sorted.length - max} more` : sorted.join(', ');
};

/**
 * What the markup of `files` uses that nothing defines: handlers that call
 * a missing function, `:bind` to a name that is not state, and reads of names
 * that are neither logic state, functions or computed values, `<data>`
 * aliases, loop variables or arrow parameters in scope, a component's
 * declared props, nor a built-in the template evaluator provides.
 */
export function checkTemplateNames(input: NameCheckInput): { errors: string[]; warnings: string[] } {
  const { logic } = input;
  const helpers = new Set([...input.helpers, ...HOST_FUNCTIONS]);
  const globals = new Set(TEMPLATE_GLOBALS);
  const aliases = new Set<string>(input.dataNames);
  for (const file of input.files) for (const c of file.doc.data?.collections ?? []) aliases.add(c.as);
  const references = input.files.map((file) => ({ file, refs: templateReferences(file) }));
  // A name the markup assigns (`@click={() => tab = "a"}`) becomes state when the handler runs.
  const assigned = new Set<string>();
  for (const { refs } of references) for (const r of refs) if (r.kind === 'assign') assigned.add(r.name);

  const declare = input.python ? (name: string) => `${name} = …` : (name: string) => `let ${name} = …`;
  const functionsText = () => `The logic's functions: ${list(logic.functions)}.`;
  const findings = new Map<string, { path: string; lines: number[]; message: string; warning: boolean }>();
  const report = (path: string, key: string, line: number, message: () => string) => {
    const id = `${path}\u0000${key}`;
    const found = findings.get(id);
    if (found) {
      if (!found.lines.includes(line)) found.lines.push(line);
      return;
    }
    findings.set(id, { path, lines: [line], message: message(), warning: key.startsWith('assign:') });
  };

  for (const { file, refs } of references) {
    const props = new Set((file.doc.component?.props ?? []).map((p) => p.name));
    const isValue = (name: string, local: Set<string>) =>
      local.has(name) || logic.state.has(name) || logic.computed.has(name) || logic.functions.has(name) || aliases.has(name) || props.has(name) || globals.has(name) || helpers.has(name);
    const suggest = (name: string, pool: Iterable<string>) => {
      const near = nearestName(name, pool);
      return near ? ` Did you mean ${near}?` : '';
    };
    for (const ref of refs) {
      const { name, local } = ref;
      switch (ref.kind) {
        case 'handler':
        case 'call': {
          const callable = logic.functions.has(name) || helpers.has(name) || globals.has(name) || local.has(name) || props.has(name) || logic.computed.has(name);
          if (callable) break;
          if (ref.kind === 'call' && !ref.event && (logic.state.has(name) || aliases.has(name) || assigned.has(name))) break;
          const where = ref.event ? `${ref.event} calls ${name}${ref.kind === 'call' ? '()' : ''}` : `{${name}(…)} calls ${name}()`;
          const effect = ref.event ? 'so it does nothing when it fires' : 'so it renders nothing';
          const pool = [...logic.functions, ...helpers];
          if (logic.state.has(name) || aliases.has(name)) {
            report(file.path, `call:${name}`, ref.line, () => `${where}, but ${name} is ${logic.state.has(name) ? 'state' : 'a <data> collection'}, not a function — ${effect}. ${functionsText()}`);
          } else {
            report(file.path, `call:${name}`, ref.line, () => `${where}, which the logic does not define — ${effect}.${suggest(name, pool)} ${functionsText()}`);
          }
          break;
        }
        case 'bind': {
          if (logic.state.has(name) || local.has(name) || aliases.has(name)) break;
          const why = logic.computed.has(name)
            ? `${name} is a computed value, which cannot be written`
            : logic.functions.has(name)
              ? `${name} is a function, not state`
              : props.has(name)
                ? `${name} is a prop, which is read-only`
                : `${name} is not state`;
          const declared = logic.computed.has(name) || logic.functions.has(name) || props.has(name);
          report(file.path, `bind:${name}`, ref.line, () => `:bind={${name}} — ${why}, so ${declared ? 'typing into the field is lost' : 'the field has no value to show and typing into it is lost'}.${suggest(name, logic.state)} ${declared ? 'Bind' : `Declare it in the logic (${declare(name)}) or bind`} to one of its state variables: ${list(logic.state)}.`);
          break;
        }
        case 'assign': {
          if (logic.state.has(name) || local.has(name) || aliases.has(name)) break;
          report(file.path, `assign:${name}`, ref.line, () => `${ref.event ?? 'An expression'} assigns ${name}, which the logic does not declare: it has no value until the handler runs.${suggest(name, logic.state)} Declare it in the logic (${declare(name)}).`);
          break;
        }
        case 'read': {
          if (isValue(name, local) || assigned.has(name)) break;
          if (UNAVAILABLE_GLOBALS.has(name)) {
            report(file.path, `read:${name}`, ref.line, () => `${name} is not available in templates, so it is undefined there (templates have ${TEMPLATE_GLOBALS.filter((g) => /^[A-Z]/.test(g) && g !== 'NaN' && g !== 'Infinity').join(', ')} and the helpers). Compute the value in a logic function and call it.`);
            break;
          }
          const pool = [...logic.state, ...logic.computed, ...logic.functions, ...aliases, ...local, ...props];
          report(file.path, `read:${name}`, ref.line, () => `${name} is read here but nothing defines it — not the logic's state, functions or computed values, a <data> alias, nor a loop variable in scope — so it renders empty.${suggest(name, pool)} Define it in the logic (${declare(name)}).`);
          break;
        }
      }
    }
  }
  const text = (f: { path: string; lines: number[]; message: string }) => {
    const [first, ...rest] = f.lines;
    return `${f.path} line ${first}${rest.length > 0 ? ` (also line${rest.length > 1 ? 's' : ''} ${rest.slice(0, 6).join(', ')}${rest.length > 6 ? ', …' : ''})` : ''}: ${f.message}`;
  };
  // An assignment to an undeclared name works once the handler has run (the renderer creates the
  // state), so it is a warning; everything else renders nothing, and is an error.
  const all = [...findings.values()];
  return { errors: all.filter((f) => !f.warning).map(text), warnings: all.filter((f) => f.warning).map(text) };
}
