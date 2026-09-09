// @vitest-environment node
import {beforeAll,describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {zipSync} from 'fflate';
import initWasm from '../wasm-zipp/zipp_wasm.js';
import {executeSandbox} from '../src/runtime/sandbox-execute';
import {readZipText} from '../src/runtime/zip-text';
beforeAll(async()=>{await initWasm({module_or_path:readFileSync(new URL('../wasm-zipp/zipp_wasm_bg.wasm',import.meta.url))});});
describe('isolated ZIPP scripts',()=>{
 it('returns JSON results from real ZIPP',()=>expect(executeSandbox('function update(c){return {data:{n:c.n+1},commands:[]};}',{n:4})).toEqual({data:{n:5},commands:[]}));
 it('does not retain globals between invocations',()=>{const s='let n=0;function update(){n++;return n;}';expect(executeSandbox(s,{})).toBe(1);expect(executeSandbox(s,{})).toBe(1);});
 it('cannot access browser DOM or the parent simulation',()=>expect(executeSandbox('function update(){return [typeof document,typeof osGame,typeof fetch];}',{})).toEqual(['undefined','undefined','undefined']));
 it('rejects queued host access without executing it',()=>expect(()=>executeSandbox('function update(){host.call("net.fetch",["https://example.com"],function(){});return {};}',{})).toThrow(/host access/));
 it('denies synchronous storage and database bridges',()=>{for(const expr of ['localStorage.getItem("x")','db.query("secret")'])expect(()=>executeSandbox('function update(){return '+expr+';}',{})).toThrow();});
 it('bounds runaway top-level code and hook code',()=>{expect(()=>executeSandbox('while(true){} function update(){return {};}',{})).toThrow();expect(()=>executeSandbox('function update(){while(true){}}',{})).toThrow();});
 it('rejects syntax errors and missing update hooks',()=>{expect(()=>executeSandbox('function update( {',{})).toThrow();expect(()=>executeSandbox('let x=2;',{})).toThrow();});
 it('rejects oversized source and output',()=>{expect(()=>executeSandbox(' '.repeat(65537),{})).toThrow();expect(()=>executeSandbox('function update(){return "a".repeat(65537);}',{})).toThrow();});
});
describe('small text ZIP reader',()=>{
 const enc=(s:string)=>new TextEncoder().encode(s);
 it('reads compressed files and verifies checksums',()=>{const zip=zipSync({'mod.json':enc('{"api":1}'),'main.js':enc('function update(){return {};}')});expect(readZipText(zip)['mod.json']).toBe('{"api":1}');const bad=zip.slice();bad[38]^=64;expect(()=>readZipText(bad)).toThrow();});
 it('bounds compressed, expanded, per-file and entry counts',()=>{expect(()=>readZipText(new Uint8Array(262145))).toThrow();expect(()=>readZipText(zipSync({'big.js':enc('a'.repeat(65537))}))).toThrow();expect(()=>readZipText(zipSync(Object.fromEntries(Array.from({length:33},(_,i)=>['x'+i,enc('x')]))))).toThrow();expect(()=>readZipText(zipSync(Object.fromEntries(Array.from({length:5},(_,i)=>['x'+i,enc('x'.repeat(60000))]))))).toThrow();});
 it('refuses malformed UTF-8 and non-ZIP files',()=>{expect(()=>readZipText(zipSync({'main.js':new Uint8Array([255,255])}))).toThrow();expect(()=>readZipText(enc('not a zip'))).toThrow();});
 it('never exports traversal filenames',()=>{const data=readZipText(zipSync({'../evil.js':enc('bad'),'main.js':enc('good')}));expect(Object.keys(data)).toEqual(['main.js']);});
});
