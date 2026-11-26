/**
 * What a module imports, as a browser links it (src/esm-linker.ts).
 *
 * Each imported name was a copy taken when its import ran (`const count = mod.count`), and
 * each import ran where it was written. So: an `export let` the exporter changed later was
 * never seen by the modules that imported it; in a cycle (a imports b, b imports a) the copy
 * was taken before the other module had made the value, and the app stopped with "cannot
 * access a lexical binding before initialization"; a module's code above its imports ran
 * before what it imports, and could not read their names; and two modules of a cycle
 * imported at once waited for each other for good. A name is now read from its module where
 * it is written, as the module's binding is then, the imports run before the module's own
 * code, and a cycle is linked whichever module is asked for first.
 *
 * The registrations are run here in a VM with the registry's own preamble and a host that
 * answers `esm.resolve` and `esm.load` as the container's does, and checked against what
 * Node's own loader does with the same modules.
 */
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { ESM_REGISTRY_PREAMBLE, resolveModuleSpecifier, transformEsModule } from '../src/esm-linker';

const ORIGIN = 'https://app.softn.local';

interface Ran {
  logs: string[];
  error?: string;
  ns?: Record<string, unknown>;
}

/**
 * Run `entry` of `files` through the registry: modules named in `preload` are registered at
 * the start (as the program compiled at the start registers them), the rest when imported.
 */
async function run(files: Record<string, string>, entry: string, preload: string[] = []): Promise<Ran> {
  const logs: string[] = [];
  const defined = new Set<string>();
  const has = (p: string) => p in files;
  const collect = (p: string, url: string, blocks: string[]) => {
    if (defined.has(url)) return;
    defined.add(url);
    const t = transformEsModule(files[p], url);
    for (const spec of t.staticImports) {
      const r = resolveModuleSpecifier(spec, p, {}, has);
      if (r.kind === 'vfs' && has(r.path)) collect(r.path, r.url, blocks);
    }
    blocks.push(t.factoryCode);
  };
  const pathOf = (importer: unknown) => (String(importer).startsWith(`${ORIGIN}/`) ? String(importer).slice(ORIGIN.length + 1) : 'index.html');
  const host = {
    callSync(kind: string, spec: string, importer: string) {
      if (kind !== 'esm.resolve') throw new Error(`no ${kind}`);
      return resolveModuleSpecifier(spec, pathOf(importer), {}, has).url;
    },
    call(kind: string, args: string[], reply: (answer: unknown) => void) {
      if (kind !== 'esm.load') return;
      const r = resolveModuleSpecifier(args[0], pathOf(args[1]), {}, has);
      const blocks: string[] = [];
      if (r.kind !== 'vfs' || !has(r.path)) return setTimeout(() => reply({ error: `no module ${args[0]}` }), 0);
      collect(r.path, r.url, blocks);
      setTimeout(() => reply({ url: r.url, blocks, urls: [] }), 0);
    },
  };
  const context = vm.createContext({ host, console: { log: (...parts: unknown[]) => logs.push(parts.map(String).join(' ')) }, setTimeout });
  vm.runInContext(ESM_REGISTRY_PREAMBLE, context);
  for (const p of preload) {
    const blocks: string[] = [];
    collect(p, `${ORIGIN}/${p}`, blocks);
    for (const block of blocks) vm.runInContext(block, context);
  }
  const registry = (context as unknown as { __softnModules: { import(spec: string, from: string): Promise<Record<string, unknown>> } }).__softnModules;
  const url = `${ORIGIN}/${entry}`;
  const settled = await Promise.race([
    registry.import(url, url).then((ns) => ({ ns }), (e: unknown) => ({ error: String(e instanceof Error ? `${e.name}: ${e.message}` : e) })),
    new Promise<{ error: string }>((resolve) => setTimeout(() => resolve({ error: 'never settled' }), 2_000)),
  ]);
  return { logs, ...settled };
}

describe('a module’s imports', () => {
  it('read an exported let as the exporter has it now, through any number of re-exports', async () => {
    const ran = await run({
      'counter.js': 'export let count = 0; export function inc() { count++; }',
      'barrel.js': 'export * from "./counter.js";',
      'renamed.js': 'export { count as total, inc as plus } from "./counter.js";',
      'kept.js': 'import { count, inc } from "./counter.js"; export { count, inc };',
      'main.js': `import { count, inc } from "./counter.js";
        import { count as viaStar } from "./barrel.js";
        import { total, plus } from "./renamed.js";
        import * as ns from "./kept.js";
        inc(); plus(); ns.inc();
        const shorthand = { count };
        console.log(count, viaStar, total, ns.count, shorthand.count, \`\${count}\`);`,
    }, 'main.js');
    expect(ran.error).toBeUndefined();
    expect(ran.logs).toEqual(['3 3 3 3 3 3']);
  });

  it('link a cycle: a module’s code reads the other’s const, class and default once they are made', async () => {
    const ran = await run({
      'a.js': `import { describe, B } from "./b.js";
        export const name = "A";
        export class Shape { area() { return 2; } }
        export default function greet() { return "hi " + name; }
        console.log(describe(), new B().area());`,
      'b.js': `import { name, Shape } from "./a.js";
        import greet from "./a.js";
        export function describe() { return "b sees " + name + " and " + greet(); }
        export class B { area() { return new Shape().area() * 10; } }`,
      'main.js': 'import { name } from "./a.js"; console.log("main", name);',
    }, 'main.js');
    expect(ran.error).toBeUndefined();
    expect(ran.logs).toEqual(['b sees A and hi A 20', 'main A']);
  });

  it('run before the module’s own code, in their order, wherever they are written', async () => {
    const ran = await run({
      'first.js': 'console.log("first"); export const value = "V";',
      'second.js': 'import "./third.js"; console.log("second");',
      'third.js': 'console.log("third");',
      'main.js': `console.log("main starts", value);
        import { value } from "./first.js";
        import "./second.js";
        console.log("main ends");`,
    }, 'main.js');
    expect(ran.error).toBeUndefined();
    expect(ran.logs).toEqual(['first', 'third', 'second', 'main starts V', 'main ends']);
  });

  it('of two modules of a cycle imported at once both arrive', async () => {
    const ran = await run({
      'x.js': 'import { y } from "./y.js"; export const x = "X"; export const seeY = () => y;',
      'y.js': 'import { x } from "./x.js"; export const y = "Y"; export const seeX = () => x;',
      'main.js': 'const [mx, my] = await Promise.all([import("./x.js"), import("./y.js")]); console.log(mx.seeY() + my.seeX());',
    }, 'main.js', ['x.js', 'y.js']);
    expect(ran.error).toBeUndefined();
    expect(ran.logs).toEqual(['YX']);
  });

  it('keep the module’s own names where it declares one again, and read the import everywhere else', async () => {
    const ran = await run({
      'lib.js': 'export let state = 1; export function bump() { state++; } export const t = (s) => "T:" + s; export const e = "E";',
      'main.js': `import { state, bump, t, e } from "./lib.js";
        function reducer(state, action) { return state + action; }
        const marks = ["a"].map(t => t + "!");
        try { throw "thrown"; } catch (e) { console.log(e); }
        { let state = "block"; console.log(state); }
        bump();
        console.log(reducer(10, 1), marks[0], t("x"), e, state);`,
    }, 'main.js');
    expect(ran.error).toBeUndefined();
    expect(ran.logs).toEqual(['thrown', 'block', '11 a! T:x E 2']);
  });

  it('leave properties, keys and members of the same names alone', async () => {
    const ran = await run({
      'lib.js': 'export const name = "lib"; export const value = 5; export let size = 3;',
      'main.js': `import { name, value, size } from "./lib.js";
        const o = { name: "key", value() { return "method"; }, get size() { return size * 2; }, [name]: 1 };
        class C { name = "field"; value() { return value; } static size = size; }
        const p = { default: { name }, case: { value } };
        function f() { return o.name, name }
        console.log(o.name, o.value(), o.size, o.lib, new C().name, new C().value(), C.size, p.default.name, p.case.value, f(), o?.name);`,
    }, 'main.js');
    expect(ran.error).toBeUndefined();
    expect(ran.logs).toEqual(['key method 6 1 field 5 3 lib 5 lib key']);
  });

  it('are kept as values once their module has run when they never change, and read live when they do', async () => {
    // A getter's call for every read of an imported function in a loop cost four times what a
    // local's read does in the engine; what never changes is a plain property once its module has run.
    const ran = await run({
      'lib.js': `export const W = 3; export function area(h) { return W * h; } export let n = 0; export function inc() { n++; }
        export function patched() { return 1; } export function patch() { patched = () => 2; } export default class Shape {}`,
      'main.js': `import * as lib from "./lib.js";
        const kind = (k) => (Object.getOwnPropertyDescriptor(lib, k).get ? "getter" : "value");
        lib.patch(); lib.inc();
        console.log(["W", "area", "default", "n", "patched"].map(kind).join(), lib.n, lib.patched());`,
    }, 'main.js');
    expect(ran.error).toBeUndefined();
    expect(ran.logs).toEqual(['value,value,value,getter,getter 1 2']);
  });
});

describe('a module’s registration', () => {
  const factory = (code: string, url = `${ORIGIN}/m.ts`) => transformEsModule(code, url).factoryCode;
  const exported = (code: string, url?: string) => [...factory(code, url).matchAll(/defineProperty\(__exports, "([^"]+)"/g)].map((m) => m[1]);

  it('exports only what is declared, not the types a TypeScript value is written with', () => {
    // `new Map<string, number>()` exported a `number`, and `<A, B>(a: A, b: B) => …` exported B, a and b:
    // names the module never declared, each a ReferenceError to whatever read the module's namespace.
    expect(exported('export const cache = new Map<string, number>();')).toEqual(['cache']);
    expect(exported('export const pair = <A, B>(a: A, b: B): [A, B] => [a, b];')).toEqual(['pair']);
    expect(exported('export const id = <T,>(x: T) => x;')).toEqual(['id']);
    expect(exported('export const m = new Map<string, { value: number; at: number }>(), other = 1;')).toEqual(['m', 'other']);
    expect(exported('export const s = f<A, B>(x), t = 2;')).toEqual(['s', 't']);
    // Values that are comparisons are still two declarations.
    expect(exported('export const small = a < 10, big = a > 100;', `${ORIGIN}/m.js`)).toEqual(['small', 'big']);
  });

  it('compiles where a keyword is a property’s name before a division, and a regular expression follows a block', () => {
    // `x.default / 2` was taken for a regular expression's start, which swallowed the line with its
    // brackets, and every export after it was left in the registration: the module did not compile.
    for (const code of [
      'if (sizes.default / 2 > 1) { go(); }\nexport const z = 1;',
      'const q = (a.return / 2) * (b);\nexport const z = 1;',
      'function f() {}\n/[(]/.test(s);\nexport const z = 1;',
      'if (ready) { start(); }\n/^[{]/.test(v) && go();\nexport const z = 1;',
    ]) {
      const code2 = factory(code, `${ORIGIN}/m.js`);
      expect(code2).not.toContain('export const');
      expect(() => new Function('__softnModules', code2)).not.toThrow();
    }
  });

  it('compiles a module that starts with #! and one with TypeScript’s export declare and export namespace', () => {
    const shebang = factory('#!/usr/bin/env node\nexport const a = 1;', `${ORIGIN}/m.js`);
    expect(() => new Function('__softnModules', shebang)).not.toThrow();
    expect(factory('export declare const x: number;\nexport const y = 1;')).not.toMatch(/export\s+declare/);
    const ns = factory('export namespace Shapes { export const unit = 1; }');
    expect(ns).not.toMatch(/export\s+namespace/);
    expect(exported('export namespace Shapes { export const unit = 1; }')).toEqual(['Shapes']);
  });

  it('reads an import in a TypeScript type as a qualified name, and never rewrites what declares a name', () => {
    const code = factory(`import React, { useState, Props, T } from 'react';
      const S: React.FC<Props> = () => null;
      function id<T>(x: T): T { return x; }
      const [v] = useState<Props | null>(null);
      interface View { useState(): void; Props: number }`);
    expect(code).toContain('const S: __softn_m0.default.FC<__softn_m0.Props> = () => null;');
    expect(code).toContain('function id<T>(x: T): T { return x; }');
    expect(code).toContain('__softn_m0.useState<__softn_m0.Props | null>(null)');
    expect(code).toContain('interface View { useState(): void; Props: number }');
  });
});
