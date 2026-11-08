// @vitest-environment node
/**
 * Where a realm takes ZIPP's JavaScript bindings from (zipp-glue.ts): the glue
 * core carries, unless a host names its own ZIPP's glue (FormLogic's /zipp/
 * folder), which is checked against the digest the host gives and refused when
 * it lacks a name core calls. Data URLs stand in for the host's files.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bundled = vi.hoisted(() => ({ marker: 'bundled' }));
vi.mock('../wasm-zipp/zipp_wasm.js', () => ({
  default: vi.fn(),
  Engine: class {},
  accelGuestCall: vi.fn(),
  addPythonPackage: vi.fn(),
  zipp_install_panic_hook: vi.fn(),
  zippProfile: vi.fn(() => JSON.stringify(bundled)),
}));

const GLUE = [
  'export default function init() { return {}; }',
  'export class Engine { which() { return "host"; } }',
  'export function accelGuestCall() {}',
  'export function addPythonPackage() {}',
  'export function zipp_install_panic_hook() {}',
  'export function zippProfile() { return "{\\"languages\\":[\\"javascript\\"],\\"from\\":\\"host\\"}"; }',
].join('\n');
const urlOf = (source: string) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const digestOf = (source: string) => createHash('sha256').update(source).digest('hex');
/** The host's server: answers the glue's own bytes at its address. */
const serve = (source: string) => vi.fn(async () => new Response(source));

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('the ZIPP glue a realm runs', () => {
  it("is core's own unless a host names another, and loading it fetches nothing", async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const glue = await import('../src/runtime/zipp-glue');
    const loaded = await glue.loadZippGlue();
    expect(loaded.zippProfile()).toContain('bundled');
    expect(glue.zippGlue()).toBe(loaded);
    expect(await glue.zippGlueForWorker()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is the host's, once its bytes match the digest the host gave", async () => {
    const url = urlOf(GLUE);
    vi.stubGlobal('fetch', serve(GLUE));
    const glue = await import('../src/runtime/zipp-glue');
    glue.configureZippGlue({ url, sha256: digestOf(GLUE) });
    expect(() => glue.zippGlue()).toThrow(/before its glue loaded/);
    const loaded = await glue.loadZippGlue();
    expect(loaded.zippProfile()).toContain('host');
    expect(new (glue.zippGlue().Engine as unknown as new () => { which(): string })().which()).toBe('host');
    // A worker this realm starts is told the same address.
    expect(await glue.zippGlueForWorker()).toBe(url);
    expect(() => glue.configureZippGlue({ url })).toThrow(/before initialization/);
  });

  it('refuses a glue whose bytes are not the ones named, and one without a name core calls', async () => {
    vi.stubGlobal('fetch', serve(`${GLUE}\n// changed`));
    let glue = await import('../src/runtime/zipp-glue');
    glue.configureZippGlue({ url: urlOf(GLUE), sha256: digestOf(GLUE) });
    await expect(glue.loadZippGlue()).rejects.toThrow(/is not the one its host named/);

    vi.resetModules();
    const partial = GLUE.replace('export function accelGuestCall() {}', '').replace('export class Engine { which() { return "host"; } }', '');
    vi.stubGlobal('fetch', serve(partial));
    glue = await import('../src/runtime/zipp-glue');
    glue.configureZippGlue({ url: urlOf(partial), sha256: digestOf(partial) });
    await expect(glue.loadZippGlue()).rejects.toThrow('does not export Engine, accelGuestCall, which SoftN calls');
  });

  it('can be tried again after a failed load, and only the same glue', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockImplementation(async () => new Response(GLUE));
    vi.stubGlobal('fetch', fetch);
    const glue = await import('../src/runtime/zipp-glue');
    glue.configureZippGlue({ url: urlOf(GLUE), sha256: digestOf(GLUE) });
    await expect(glue.loadZippGlue()).rejects.toThrow(/could not be fetched: offline/);
    expect(() => glue.configureZippGlue({ url: 'https://elsewhere.example/glue.js' })).toThrow(/before initialization/);
    expect((await glue.loadZippGlue()).zippProfile()).toContain('host');
  });

  it("is a worker's page's: adopted before the worker starts, ignored after", async () => {
    vi.stubGlobal('fetch', vi.fn());
    const glue = await import('../src/runtime/zipp-glue');
    glue.adoptZippGlue(urlOf(GLUE));
    expect((await glue.loadZippGlue()).zippProfile()).toContain('host');
    glue.adoptZippGlue('https://elsewhere.example/glue.js');
    expect(await glue.zippGlueForWorker()).toBe(urlOf(GLUE));
  });

  it('names what a glue lacks, and refuses a malformed digest', async () => {
    const glue = await import('../src/runtime/zipp-glue');
    expect(glue.missingGlueExports({ default() {}, Engine: class {} })).toEqual(['accelGuestCall', 'addPythonPackage', 'zipp_install_panic_hook', 'zippProfile']);
    expect(() => glue.configureZippGlue({ url: 'x', sha256: 'ABC' })).toThrow(/64 lowercase hex/);
  });

  it("waits for a glue a host will name when it connects, and tells a worker started meanwhile", async () => {
    vi.stubGlobal('fetch', serve(GLUE));
    const glue = await import('../src/runtime/zipp-glue');
    let name!: (source: { url: string; sha256?: string } | null) => void;
    glue.awaitZippGlue(new Promise((resolve) => { name = resolve; }));
    const forWorker = glue.zippGlueForWorker();
    const loading = glue.loadZippGlue();
    expect(() => glue.zippGlue()).toThrow(/before its glue loaded/);
    name({ url: urlOf(GLUE), sha256: digestOf(GLUE) });
    expect(await forWorker).toBe(urlOf(GLUE));
    expect((await loading).zippProfile()).toContain('host');
  });

  it('says whether it runs a host glue, and loads it before telling a worker where it is', async () => {
    const fetch = serve(GLUE);
    vi.stubGlobal('fetch', fetch);
    const glue = await import('../src/runtime/zipp-glue');
    glue.configureZippGlue({ url: urlOf(GLUE), sha256: digestOf(GLUE) });
    expect(glue.runsHostGlue()).toBe(false);
    expect(await glue.zippGlueForWorker()).toBe(urlOf(GLUE));
    // Checked against its digest before the address was handed on.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(glue.runsHostGlue()).toBe(true);

    vi.resetModules();
    vi.stubGlobal('fetch', serve(`${GLUE}// changed`));
    const refused = await import('../src/runtime/zipp-glue');
    refused.configureZippGlue({ url: urlOf(GLUE), sha256: digestOf(GLUE) });
    await expect(refused.zippGlueForWorker()).rejects.toThrow(/is not the one its host named/);
  });

  it("runs core's own when the host names none", async () => {
    vi.stubGlobal('fetch', vi.fn());
    const glue = await import('../src/runtime/zipp-glue');
    glue.awaitZippGlue(Promise.resolve(null));
    expect((await glue.loadZippGlue()).zippProfile()).toContain('bundled');
    expect(await glue.zippGlueForWorker()).toBeNull();
  });
});