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

import { patternNames } from '@softn/core';
import type { BindingTarget, Expression, SoftNDocument, TemplateNode } from '@softn/core';

/**
 * The JavaScript globals a template expression can name: render.tsx's
 * JS_GLOBALS, which core does not export. The list is checked against the
 * real evaluator by a test (templateNames.test.ts), so the two cannot drift
 * apart. `Object` is three read-only functions there (`keys`, `values`,
 * `entries`); `console`, `window` and the rest are not in it: in a template
 * they are undefined.
 */
export const TEMPLATE_GLOBALS: readonly string[] = [
  'Number',
  'String',
  'Boolean',
  'Array',
  'Date',
  'Map',
  'Set',
  'Math',
  'JSON',
  'Object',
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

/**
 * Props whose name reads like a callback's (`on…`) and are not one: the
 * component manifest types them as data. Per tag, checked against the manifest
 * by a test (templateNames.test.ts), so a new one cannot be missed.
 *
 * Every `on…` prop was read as a handler, so `<Switch onColor={accent} />`,
 * whose onColor is the colour of the switch when it is on, was reported as
 * "onColor calls accent, but accent is state, not a function".
 */
export const ON_PROPS_THAT_ARE_VALUES: Readonly<Record<string, readonly string[]>> = {
  Switch: ['onColor'],
};

/** Whether a prop is a callback: named `on…`, and not one the manifest types as a value. */
function isCallbackProp(tag: string, name: string): boolean {
  if (!/^on[A-Z]/.test(name)) return false;
  return !(Object.hasOwn(ON_PROPS_THAT_ARE_VALUES, tag) && ON_PROPS_THAT_ARE_VALUES[tag].includes(name));
}

/** JavaScript globals a model reaches for that a template does not have. */
const UNAVAILABLE_GLOBALS = new Set([
  'WeakMap', 'Promise', 'Intl', 'RegExp', 'Symbol', 'BigInt', 'Error', 'Reflect', 'Function',
  'console', 'window', 'document', 'globalThis', 'localStorage', 'sessionStorage', 'navigator', 'location', 'fetch',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame', 'structuredClone', 'crypto', 'performance',
]);

/** Timers: page logic (JavaScript) has these four, markup has none of them. */
const LOGIC_TIMERS = new Set(['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval']);
const LOOP_EXAMPLE = '<Loop interval={100} running={running} @tick={() => step()} />';

/**
 * What to say of a timer named in the markup, or null for a name that is not
 * one: why it does nothing there, and what to write instead. Page logic in
 * JavaScript runs the four timers, so the way is a logic function that sets
 * one; Python logic has none, and nothing in SoftN has requestAnimationFrame.
 * Without this the name was "not defined by the logic", which a model answers
 * by defining a function of that name.
 */
function timerAdvice(name: string, python: boolean, event: string | undefined): { why: string; instead: string } | null {
  if (!LOGIC_TIMERS.has(name) && name !== 'requestAnimationFrame') return null;
  if (python) return { why: 'Python logic does not have', instead: `For a delay or a clock use ${LOOP_EXAMPLE}.` };
  if (name === 'requestAnimationFrame') return { why: 'SoftN does not have', instead: `For a clock use ${LOOP_EXAMPLE}, or setInterval in a logic function.` };
  const [verb, fn] = name.startsWith('clear') ? ['clears', 'stopTimer'] : ['sets', 'startTimer'];
  return {
    why: "works in the page's logic and not in markup",
    instead: `Call a logic function that ${verb} the timer: function ${fn}() { ${name}(…) }, then ${event ? `${event}={() => ${fn}()}` : `{${fn}()}`}.`,
  };
}

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
  /** For each of those tags, the path of the file it pastes, when that file is among the ones checked. */
  imports?: Map<string, string>;
}

export interface NameCheckInput {
  files: TemplateFile[];
  logic: LogicNames;
  /**
   * The names the composed page's `<data>` blocks bind beside those of the files checked: for a
   * page looked at on its own, what the page that imports it declares.
   */
  dataNames: Iterable<string>;
  /**
   * The project's collections, each with its file: what a page could declare, and does not
   * have until it does. A collection used to count as defined wherever it was read, because
   * Studio handed every one to every page; a runtime hands a page only what its blocks bind.
   */
  collections?: ReadonlyMap<string, string>;
  /** Every `<collection>` in effect for the composed page, for saying that one is bound under another name. */
  declared?: ReadonlyArray<{ name: string; as: string }>;
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

/** Every default written in a parameter's pattern, however deep. */
function visitDefaults(target: BindingTarget, visit: (expr: Expression) => void): void {
  if (target.default) visit(target.default);
  const pattern = target.pattern;
  if (pattern.type === 'ArrayPattern') for (const element of pattern.elements) visitDefaults(element, visit);
  else if (pattern.type === 'ObjectPattern') for (const property of pattern.properties) visitDefaults(property.value, visit);
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
      // `params` is every name the arrow binds, destructured ones included.
      for (const param of expr.params) inner.add(param.replace(/^\.\.\./, '').replace(/\s*=.*$/, '').trim());
      // A default is read with the parameters in scope: `(a, b = a) => …`.
      for (const param of expr.patterns ?? []) visitDefaults(param, (e) => visit(e, inner));
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
    case 'UpdateExpression': {
      // `count++` writes its target and reads it first.
      const root = rootName(expr.argument);
      if (root) out.push({ kind: 'assign', name: root.name, line: root.line, local, event: handler });
      if (expr.argument.type === 'MemberExpression') visit(expr.argument, local);
      else if (root) out.push({ kind: 'read', name: root.name, line: root.line, local, event: handler });
      return;
    }
    case 'NewExpression':
      // The class is read, not called: `new Date()` names the global Date.
      visit(expr.callee, local);
      for (const arg of expr.arguments) visit(arg, local);
      return;
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
      for (const property of expr.properties) {
        if (property.type === 'SpreadElement') {
          visit(property.argument, local);
          continue;
        }
        // `{ [field]: value }` reads `field`.
        if (property.computedKey) visit(property.computedKey, local);
        visit(property.value, local);
      }
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

/**
 * Every reference in a file's template, each with the loop variables and
 * parameters in scope where it is. `onImportUse` is told each place an
 * imported file's tag stands, with the names bound there.
 */
export function templateReferences(file: TemplateFile, onImportUse?: (tag: string, local: Set<string>) => void): Ref[] {
  const out: Ref[] = [];
  const walkNodes = (nodes: TemplateNode[] | undefined, local: Set<string>) => {
    for (const node of nodes ?? []) walk(node, local);
  };
  const walk = (node: TemplateNode, local: Set<string>): void => {
    switch (node.type) {
      case 'Element': {
        // An imported component's tag is replaced by its markup: its props and children never render.
        if (file.importedTags.has(node.tag)) {
          onImportUse?.(node.tag, local);
          return;
        }
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
          if (isCallbackProp(node.tag, prop.name)) collectHandler(value, scope, out, prop.name);
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
        // `#each ({ id, title } in tasks)` binds the names in the pattern;
        // `itemName` is then the pattern's text, not a name.
        if (node.itemPattern) for (const name of patternNames(node.itemPattern)) inner.add(name);
        else inner.add(node.itemName);
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
  // The composer pastes an imported file where its tag stands, so the file reads what is bound
  // there: inside `#each (task in tasks)` its `{task.title}` is the loop's. Checked on its own
  // with nothing in scope, such a file was told that task "renders empty", of a row that
  // renders. So each use of a file is noted with the names bound at it, and a name is the
  // file's to read when some use binds it; only one that no use binds is reported.
  const uses = new Map<string, Array<{ from: string; local: Set<string> }>>();
  const references = input.files.map((file) => ({
    file,
    refs: templateReferences(file, (tag, local) => {
      const target = file.imports?.get(tag);
      if (target === undefined) return;
      const list = uses.get(target) ?? [];
      list.push({ from: file.path, local });
      uses.set(target, list);
    }),
  }));
  const boundAtUse = new Map<string, Set<string>>();
  // To a fixed point, for an import of an import: what is bound around the outer one reaches the inner one.
  for (let pass = 0, grew = true; grew && pass <= input.files.length; pass++) {
    grew = false;
    for (const [path, list] of uses) {
      const names = boundAtUse.get(path) ?? new Set<string>();
      const before = names.size;
      for (const { from, local } of list) {
        for (const name of local) names.add(name);
        for (const name of boundAtUse.get(from) ?? []) names.add(name);
      }
      boundAtUse.set(path, names);
      if (names.size !== before) grew = true;
    }
  }
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
    const outer = boundAtUse.get(file.path);
    /** Bound here: by a loop or an arrow in this file, or around a tag this file is pasted in place of. */
    const bound = (name: string, local: Set<string>) => local.has(name) || (outer?.has(name) ?? false);
    const isValue = (name: string, local: Set<string>) =>
      bound(name, local) || logic.state.has(name) || logic.computed.has(name) || logic.functions.has(name) || aliases.has(name) || props.has(name) || globals.has(name) || helpers.has(name);
    const suggest = (name: string, pool: Iterable<string>) => {
      const near = nearestName(name, pool);
      return near ? ` Did you mean ${near}?` : '';
    };
    for (const ref of refs) {
      const { name, local } = ref;
      switch (ref.kind) {
        case 'handler':
        case 'call': {
          const callable = logic.functions.has(name) || helpers.has(name) || globals.has(name) || bound(name, local) || props.has(name) || logic.computed.has(name);
          if (callable) break;
          if (ref.kind === 'call' && !ref.event && (logic.state.has(name) || aliases.has(name) || assigned.has(name))) break;
          const where = ref.event ? `${ref.event} calls ${name}${ref.kind === 'call' ? '()' : ''}` : `{${name}(…)} calls ${name}()`;
          const effect = ref.event ? 'so it does nothing when it fires' : 'so it renders nothing';
          const pool = [...logic.functions, ...helpers];
          const timer = timerAdvice(name, input.python, ref.event);
          if (timer && !logic.state.has(name) && !aliases.has(name)) {
            report(file.path, `call:${name}`, ref.line, () => `${where}, which ${timer.why} — ${effect}. ${timer.instead}`);
          } else if (logic.state.has(name) || aliases.has(name)) {
            report(file.path, `call:${name}`, ref.line, () => `${where}, but ${name} is ${logic.state.has(name) ? 'state' : 'a <data> collection'}, not a function — ${effect}. ${functionsText()}`);
          } else {
            report(file.path, `call:${name}`, ref.line, () => `${where}, which the logic does not define — ${effect}.${suggest(name, pool)} ${functionsText()}`);
          }
          break;
        }
        case 'bind': {
          if (logic.state.has(name) || bound(name, local) || aliases.has(name)) break;
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
          if (logic.state.has(name) || bound(name, local) || aliases.has(name)) break;
          report(file.path, `assign:${name}`, ref.line, () => `${ref.event ?? 'An expression'} assigns ${name}, which the logic does not declare: it has no value until the handler runs.${suggest(name, logic.state)} Declare it in the logic (${declare(name)}).`);
          break;
        }
        case 'read': {
          if (isValue(name, local) || assigned.has(name)) break;
          const timer = timerAdvice(name, input.python, ref.event);
          if (timer) {
            report(file.path, `read:${name}`, ref.line, () => `${name} is read here, which ${timer.why} — so it is undefined here. ${timer.instead}`);
            break;
          }
          if (UNAVAILABLE_GLOBALS.has(name)) {
            report(file.path, `read:${name}`, ref.line, () => `${name} is not available in templates, so it is undefined there (templates have ${TEMPLATE_GLOBALS.filter((g) => /^[A-Z]/.test(g) && g !== 'NaN' && g !== 'Infinity').join(', ')} and the helpers). Compute the value in a logic function and call it.`);
            break;
          }
          // A collection the project has, read where no <data> block binds it: empty when the
          // app runs. Said with the line that would bind it, or the name it is bound under.
          const collectionFile = input.collections?.get(name);
          if (collectionFile !== undefined) {
            const under = input.declared?.find((c) => c.name === name);
            const main = input.files[0]?.path ?? file.path;
            report(file.path, `read:${name}`, ref.line, () =>
              under
                ? `${name} is read here, but this page binds that collection under another name (<collection name="${name}" as="${under.as}" />). Read ${under.as}, or write as="${name}" on that line.`
                : `${name} is read here, and the project has a collection of that name (${collectionFile}), but no <data> block declares it for this page, so it is empty when the app runs. Declare it in ${main}, ${input.files[0]?.doc.data ? `in its <data> block: <collection name="${name}" as="${name}" />` : `above <App>: <data> <collection name="${name}" as="${name}" /> </data>`}.`);
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
