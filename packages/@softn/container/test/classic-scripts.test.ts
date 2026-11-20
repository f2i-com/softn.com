/**
 * A classic script file of any size.
 *
 * The engine compiles 64 KB of code at run time and no more, and a classic script is run by
 * `eval`. One past that size stopped the whole app where it started: a page that named
 * jQuery, or any library of that size shipped as one file, showed nothing at all. A long
 * script is written into the app's program as a function instead (esm-linker.ts,
 * classicScriptAsFunction), with `this` the global object and what it declares at its top
 * made the page's globals, as a script's are.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountSoftNContainer } from '../src/index';
import { classicImportsRewritten, classicScriptAsFunction, scriptForEval, tooLongForEval, transformEsModule } from '../src/esm-linker';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LITE_WASM = path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-javascript-lite.wasm');
/** Enough of nothing to take a script past what `eval` is handed. */
const PADDING = `/* ${'padding '.repeat(12_000)} */`;

async function open(source: Record<string, string>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const said: string[] = [];
  const handle = await mountSoftNContainer(host, {
    isolation: 'inline',
    engineWasm: { lite: LITE_WASM },
    permissionMode: 'deny',
    onConsole: (level, text) => said.push(`${level}: ${text}`),
    onError: (error) => said.push(`failed: ${error.message}`),
    source,
  });
  const text = (selector: string) => handle.shadowRoot.querySelector(selector)?.textContent ?? '';
  return { handle, said, text };
}

describe('a classic script too long for eval', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('runs, in its turn among the others, with this the global object and what it declares global', async () => {
    const library = `${PADDING}
      // A library as libraries are shipped: one function, called with the global object.
      (function (root, factory) { root.Toolkit = factory(); })(this, function () { return { name: 'toolkit', twice: function (n) { return n * 2; } }; });
      var counter = 0;
      let label = 'first';
      const FIXED = 7;
      function bump() { counter++; return counter; }
      class Shape { area() { return FIXED * 2; } }
      var config = { sizes: [1, 2, 3] }, { a: picked, b: [second] } = { a: 'A', b: ['B'] };
      order.push('long:' + (typeof before) + ':' + (this === window));`;
    expect(tooLongForEval(library)).toBe(true);
    const { handle, said, text } = await open({
      'big.js': library,
      'index.html': `<!doctype html><html><body><p id="out">waiting</p>
        <script>var order = []; var before = 'set by the script before';</script>
        <script src="big.js"></script>
        <script>
          order.push('after');
          var seen = {
            order: order.join(','),
            library: Toolkit.name + ':' + Toolkit.twice(21) + ':' + (window.Toolkit === Toolkit),
            declared: [typeof counter, label, FIXED, typeof bump, typeof Shape, config.sizes.length, picked, second].join('|'),
            onWindow: [window.counter, window.label, typeof window.bump, 'config' in window].join('|'),
          };
          // One variable, by either name: the script's own function changes it, and so may the page.
          bump(); bump();
          seen.live = counter + ':' + window.counter;
          counter = 40;
          seen.written = bump();
          label = 'second';
          seen.relabelled = window.label;
          try { FIXED = 8; seen.fixed = 'changed'; } catch (e) { seen.fixed = e.name + ':' + FIXED; }
          seen.shape = new Shape().area();
          document.getElementById('out').textContent = JSON.stringify(seen);
        </script></body></html>`,
    });
    await expect.poll(() => text('#out'), { timeout: 10_000 }).not.toBe('waiting');
    expect(JSON.parse(text('#out'))).toEqual({
      order: 'long:string:true,after',
      library: 'toolkit:42:true',
      declared: 'number|first|7|function|function|3|A|B',
      onWindow: '0|first|function|true',
      live: '2:2',
      written: 41,
      relabelled: 'second',
      fixed: 'TypeError:7',
      shape: 14,
    });
    expect(said.filter((line) => line.startsWith('failed') || line.startsWith('error'))).toEqual([]);
    handle.dispose();
  });

  it('shares the globals its var names with the scripts around it, as a browser does', async () => {
    // Emscripten's output begins `var Module = typeof Module != 'undefined' ? Module : {}`,
    // for the page to set Module up first; a namespace is added to across files the same way.
    // A var was a new local over the global of its name, undefined until assigned.
    const { handle, said, text } = await open({
      'big.js': `${PADDING}
        var Module = typeof Module != 'undefined' ? Module : {};
        Module.ran = true;
        var App = App || {};
        App.two = 2;
        var Map;
        var later;
        function readLater() { return later; }
        later = 'set';
        globalThis.onready = async function onready() {};
        const { a = defaults.size, b: [c = defaults.size] } = { b: [] };`,
      'index.html': `<!doctype html><html><body><p id="out">waiting</p>
        <script>var Module = { print: 'kept' }; var App = { one: 1 }; var defaults = { size: 9 };</script>
        <script src="big.js"></script>
        <script>
          document.getElementById('out').textContent = [Module.print, Module.ran, App.one, App.two, typeof Map, new Map([[1, 2]]).get(1), readLater(), window.later, typeof window.onready, String(window.size), a, c].join('|');
        </script></body></html>`,
    });
    await expect.poll(() => text('#out'), { timeout: 10_000 }).toBe('kept|true|1|2|function|2|set|set|function|undefined|9|9');
    expect(said.filter((line) => line.startsWith('failed') || line.startsWith('error'))).toEqual([]);
    handle.dispose();
  });

  it('that throws stops itself and not the scripts after it', async () => {
    const { handle, said, text } = await open({
      'big.js': `${PADDING}\nvar started = true;\nnotDefinedAnywhere();\nvar finished = true;`,
      'index.html': `<!doctype html><html><body><p id="out">waiting</p><script src="big.js"></script>
        <script>document.getElementById('out').textContent = [typeof started, started, typeof finished, String(finished)].join('|');</script></body></html>`,
    });
    await expect.poll(() => text('#out'), { timeout: 10_000 }).toBe('boolean|true|undefined|undefined');
    expect(said.some((line) => line.includes('Script startup error') && line.includes('notDefinedAnywhere'))).toBe(true);
    handle.dispose();
  });

  it('that does not parse stops itself and not the scripts around it, and says so', async () => {
    // Written into the app's program, it stopped the whole app where it started.
    const { handle, said, text } = await open({
      'first.js': `${PADDING}\nvar fromFirst = 'first';`,
      'broken.js': `${PADDING}\nvar fine = 1;\nvar broken = ;\n`,
      'index.html': `<!doctype html><html><body><p id="out">waiting</p><script src="first.js"></script><script src="broken.js"></script>
        <script>document.getElementById('out').textContent = [fromFirst, typeof fine].join('|');</script></body></html>`,
    });
    await expect.poll(() => text('#out'), { timeout: 10_000 }).toBe('first|undefined');
    expect(said.filter((line) => line.includes('Script startup error') && line.includes('broken.js') && line.includes('SyntaxError'))).toHaveLength(1);
    expect(said.filter((line) => line.startsWith('failed'))).toEqual([]);
    handle.dispose();
  });

  it('is read for the names it declares at its top, and for nothing inside', () => {
    const read = (code: string) => classicScriptAsFunction(code, 'f');
    expect(read('var a = 1, b = function () { var inner = 2; return inner; };\nlet c\nconst { d, e: [f] } = x\nfunction g() { function nested() {} }\nclass H {}\nasync function i() {}\nfunction* j() {}').names.sort()).toEqual(['H', 'a', 'b', 'c', 'd', 'f', 'g', 'i', 'j']);
    // A function or a class in an expression declares nothing, nor does a loop's own variable, nor a member named like a keyword.
    expect(read('(function named() { var x; })();\nvar k = class Inner {};\nfor (var n = 0; n < 1; n++) {}\nthing.var = 1; other.function = 2;\nvar s = "var t = 1; function u() {}";\nvar r = /var w = 1/.test(s);').names.sort()).toEqual(['k', 'r', 's']);
    // A declaration that runs over lines, and one ended by its line.
    expect(read('var total = first +\n  second,\n  another = 3\nvar last = 4\ncall()').names.sort()).toEqual(['another', 'last', 'total']);
    // The global object's own names, and the language's, stay what they are.
    expect(read('var window = 1, document = 2, mine = 3;').names).toEqual(['mine']);
    // A strict script is a strict function, with its directive first.
    expect(read('"use strict";\nvar strictly = 1;').source.startsWith("function f() { 'use strict'; __softnGlobalVars([\"strictly\"]);")).toBe(true);
    // A var of plain names is the global's: taken out, its statement goes on as assignments.
    expect(read('var a = 1, b;\nvar { c } = o;').source).toContain('; a = 1, b;\nvar { c } = o;');
    // Only a declaration where a statement begins: a function in an expression declares nothing,
    // and a pattern's default values and member names bind nothing.
    expect(read('globalThis.onready = async function onready() {};\nx = function named() {};\nconst { a = defaults.size, b: [c = d.e] } = o;').names.sort()).toEqual(['a', 'c']);
    expect(read('if (x)\nfunction notTop() {}\nfoo()\nfunction top() {}').names).toEqual(['top']);
    // A statement ended by a line after `x++`, or after a name the reader takes for a keyword.
    expect(read('count++\nvar afterIncrement = 1\nvar t = type\nvar afterType = 2').names.sort()).toEqual(['afterIncrement', 'afterType', 't']);
    // A var in the statement an if or an else runs is the script's too, its keyword left where it is.
    const nested = read('if (ready)\n  var whenReady = 1\nelse\n  var otherwise = 2');
    expect(nested.names.sort()).toEqual(['otherwise', 'whenReady']);
    expect(nested.source).toContain('if (ready)\n  var whenReady = 1\nelse\n  var otherwise = 2');
    // Brackets that do not balance: the reading is not trusted, and no name is made global.
    const odd = read('var looks = 1; }');
    expect([odd.trusted, odd.names]).toEqual([false, []]);
  });
});

describe('a short classic script', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('declares at its top what the scripts after it can name, let, const and class too', async () => {
    // Run by eval, its let, const and class were its own: a page with its settings in one
    // script and the code that reads them in the next found nothing defined.
    const { handle, said, text } = await open({
      'index.html': `<!doctype html><html><body><p id="out">waiting</p><button id="go" type="button" onclick="document.getElementById('out').textContent = API + ':' + count">go</button>
        <script>const API = 'https://api.example'; let count = 1; class Shape { area() { return 4; } } function helper() { return count; } var old = 'old';</script>
        <script>'use strict';
          var strictVar = 'sv'; function strictFn() { return strictVar; } const strictConst = 'sc';</script>
        <script>
          count = 5;
          document.getElementById('out').textContent = [API, count, helper(), new Shape().area(), old, typeof window.Shape, strictVar, strictFn(), strictConst].join('|');
        </script></body></html>`,
    });
    await expect.poll(() => text('#out'), { timeout: 10_000 }).toBe('https://api.example|5|5|4|old|function|sv|sv|sc');
    // And an inline handler reads them as well.
    (handle.shadowRoot.querySelector('#go') as HTMLElement).click();
    await expect.poll(() => text('#out')).toBe('https://api.example:5');
    expect(said.filter((line) => line.startsWith('failed') || line.startsWith('error'))).toEqual([]);
    handle.dispose();
  });

  it('leaves the page’s own names as they are, and reads as undefined what has not been declared yet', async () => {
    // Published over the page's, \`let history = []\` took window.history from every router,
    // and \`const requestAnimationFrame = window.requestAnimationFrame || …\` read its own
    // uninitialized binding and threw; and a strict \`var NS = window.NS || {}\` lost NS.one.
    const shims = `const requestAnimationFrame = window.requestAnimationFrame || function () {};
      let history = [];
      const X = window.X || { made: true };`;
    const { handle, said, text } = await open({
      'long.js': `${PADDING}\n${shims.replace(/\bX\b/g, 'Y')}\nvar fromLong = typeof requestAnimationFrame;`,
      'index.html': `<!doctype html><html><body><p id="out">waiting</p>
        <script>window.NS = { one: 1 };</script>
        <script>${shims}</script>
        <script>'use strict'; var NS = window.NS || {}; NS.two = 2;</script>
        <script src="long.js"></script>
        <script>document.getElementById('out').textContent = [typeof window.requestAnimationFrame, typeof window.history.pushState, window.X.made, window.Y.made, NS.one, NS.two, typeof requestAnimationFrame, fromLong].join('|');</script>
      </body></html>`,
    });
    await expect.poll(() => text('#out'), { timeout: 10_000 }).toBe('function|function|true|true|1|2|function|function');
    expect(said.filter((line) => line.startsWith('failed') || line.startsWith('error'))).toEqual([]);
    handle.dispose();
  });

  it('in TypeScript declares at its top what the scripts after it can name, its enums and abstract classes too', async () => {
    // Written into a function of the app's program (TypeScript is compiled with it), all it
    // declared was the function's own: the next script found nothing defined.
    const { handle, said, text } = await open({
      'index.html': `<!doctype html><html><body><p id="out">waiting</p>
        <script type="text/typescript">
          const greeting: string = 'hi';
          let count: number = 1, items: Array<{ name: string }> = [{ name: 'a' }];
          function shout(s: string): string { return s.toUpperCase(); }
          enum Colour { Red = 'red', Blue = 'blue' }
          const enum Size { Small = 1 }
          abstract class Shape { abstract area(): number; }
          class Square extends Shape { area(): number { return 4; } }
          declare const fromElsewhere: number;
          interface Named { name: string }
          type Pair = [number, number];
          var legacy: string = 'old';
        </script>
        <script>
          count = 2;
          document.getElementById('out').textContent = [shout(greeting), count, items[0].name, Colour.Blue, new Square().area(), legacy, typeof window.Shape, typeof fromElsewhere, typeof Size].join('|');
        </script></body></html>`,
    });
    await expect.poll(() => text('#out'), { timeout: 10_000 }).toBe('HI|2|a|blue|4|old|function|undefined|object');
    expect(said.filter((line) => line.startsWith('failed') || line.startsWith('error'))).toEqual([]);
    handle.dispose();
  });

  it('imports a module with import(), resolved against the script’s own address, a long script and a module with a method named import too', async () => {
    // The engine's own import() refused every module with no word of why: a page that started
    // itself with <script>import('./app.js')</script> ran nothing. And a method named import
    // (in a class or an object) was taken for a call, and its script did not parse.
    const { handle, said, text } = await open({
      'js/part.js': 'export const part = "part";',
      'js/boot.js': `import('./part.js').then(function (m) { window.fromFile = m.part; });`,
      'js/long.js': `${PADDING}\nimport('./part.js').then(function (m) { window.fromLong = m.part + ' long'; });`,
      'js/loader.js': `export class Loader { import(name) { return 'loaded ' + name; } }
        const methods = { import(name) { return 'method ' + name; } };
        export const both = new Loader().import('a') + ' ' + methods.import('b');`,
      'index.html': `<!doctype html><html><body><p id="out">waiting</p>
        <script src="js/boot.js"></script>
        <script src="js/long.js"></script>
        <script>
          var objects = { import(name) { return 'inline ' + name; } };
          Promise.all([import('./js/loader.js'), import('softn:nothing').catch(function (e) { return e.message; })]).then(function (got) {
            setTimeout(function () {
              document.getElementById('out').textContent = [window.fromFile, window.fromLong, got[0].both, objects.import('c'), got[1]].join(' | ');
            }, 50);
          });
        </script></body></html>`,
    });
    await expect.poll(() => text('#out'), { timeout: 10_000 }).toBe('part | part long | loaded a method b | inline c | There is no module softn:nothing here');
    expect(said.filter((line) => line.startsWith('failed') || line.startsWith('error'))).toEqual([]);
    handle.dispose();
  });

  it('starts a TypeScript module and script that name a module by import() as a type', async () => {
    // Taken for calls, the types were rewritten and did not parse: the whole app stopped
    // ("SyntaxError: expected ';'").
    const { handle, said, text } = await open({
      'api.ts': 'export interface Api { name: string }\nexport const made: Api = { name: "api" };',
      'main.ts': `let api: import('./api').Api = { name: 'typed' };
        type Mod = typeof import('./api');
        const later: Promise<Mod> = import('./api');
        later.then((m) => { (window as any).fromModule = api.name + ' ' + m.made.name; });`,
      'index.html': `<!doctype html><html><body><p id="out">waiting</p>
        <script type="module" src="main.ts"></script>
        <script type="text/typescript">
          let named: import('./api').Api | null = null;
          import('./api').then((m: typeof import('./api')) => {
            named = m.made;
            setTimeout(() => { document.getElementById('out')!.textContent = (window as any).fromModule + ' | ' + named!.name; }, 50);
          });
        </script></body></html>`,
    });
    await expect.poll(() => text('#out'), { timeout: 10_000 }).toBe('typed api | api');
    expect(said.filter((line) => line.startsWith('failed') || line.startsWith('error'))).toEqual([]);
    handle.dispose();
  });

  it('rewrites import() calls and only them', () => {
    const rewritten = classicImportsRewritten(`a.import(x); import('./b.js'); import(spec, { with: { type: 'json' } }); var s = "import('./no.js')"; class C { import(u) { return u; } }`, 'https://app.softn.local/js/x.js');
    expect(rewritten.code).toBe(`a.import(x); __softnModules.import('./b.js', "https://app.softn.local/js/x.js"); __softnModules.import(spec, "https://app.softn.local/js/x.js"); var s = "import('./no.js')"; class C { import(u) { return u; } }`);
    expect(rewritten.named).toEqual(['./b.js']);
    expect(transformEsModule('const o = { import(u) { return u; } }; import("./c.js");', 'https://app.softn.local/m.js').factoryCode).toContain('const o = { import(u) { return u; } }; __import("./c.js", __meta.url);');
    // A member of TypeScript's named import with a return type, and a private method, left as they are.
    const members = 'interface Loader { import(id: string): Promise<unknown>; } class C { #import(x: number) { return x; } run() { return this.#import(1); } import(id: string): string { return id; } }';
    expect(transformEsModule(members, 'https://app.softn.local/m.ts').factoryCode).toContain(members);
    expect(classicImportsRewritten('class D { #import(x) { return x; } go() { return this.#import(1); } }', 'u').code).toBe('class D { #import(x) { return x; } go() { return this.#import(1); } }');
    expect(classicImportsRewritten('var m = c ? import("./a.js") : import("./b.js");', 'u').code).toBe('var m = c ? __softnModules.import("./a.js", "u") : __softnModules.import("./b.js", "u");');
    // Types of TypeScript's that name a module, left as they are; a call's then, rewritten.
    expect(classicImportsRewritten(`let a: import('./t').A; type M = typeof import('./t'); import('./t').then(f);`, 'u').code).toBe(`let a: import('./t').A; type M = typeof import('./t'); __softnModules.import('./t', "u").then(f);`);
  });

  it('is handed to eval as it was, with the names published before it, and after a strict one’s directive', () => {
    expect(scriptForEval('var a = 1; function f() {}')).toBe('var a = 1; function f() {}');
    expect(scriptForEval('const API = 1;')).toBe('__softnGlobals({ "API": [function () { return API; }, function (__softnValue) { API = __softnValue; }] }, true); const API = 1;');
    expect(scriptForEval("'use strict'\nvar s = 1;").startsWith("'use strict'; __softnGlobals({ \"s\":")).toBe(true);
    expect(scriptForEval('"use strict"; let t;').startsWith('"use strict"; __softnGlobals({ "t":')).toBe(true);
    // What it cannot read for certain is left as it is.
    expect(scriptForEval('let x = 1; }')).toBe('let x = 1; }');
  });
});