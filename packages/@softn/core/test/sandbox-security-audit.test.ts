import { describe, expect, it } from 'vitest';
import { filter, find, get, groupBy, map, pluck } from '../src/runtime/helpers';
import { createFormState, validateForm } from '../src/runtime/form-binding';
import { isBlockedFunction, markupValue } from '../src/renderer/host-values';
import { dropRawMarkupProp, dropTopLayerStyle, sanitizeSvgReferences } from '../src/renderer/prop-safety';
import { cssResourceReferences, rewriteCssResources, sanitizeSvg } from '../src/renderer/sanitize-html';
import { DocumentShell } from '../src/document-shell/host';
import { checkSourceModules, GENERATED_SOURCE_HEADER } from '@softn/bundle-format/source-modules';
import type { EgressConfig } from '../src/runtime/egress-policy';

const DENY_ALL_EGRESS: EgressConfig = {
  permissions: { net: { enabled: false, allowed_hosts: [], allow_http: false } },
};

describe('sandbox security audit regressions (@softn/core + @softn/bundle-format)', () => {
  it('blocks prototype traversal and dangerous function callbacks in runtime helpers', () => {
    expect(get({}, 'constructor.constructor')).toBeUndefined();
    expect(get({ a: {} }, 'a.__proto__.toString')).toBeUndefined();
    expect(pluck([{ name: 'ok' }], '__proto__')).toEqual([undefined]);
    expect(pluck([{ name: 'ok' }], 'constructor')).toEqual([undefined]);
    // groupBy never walks inherited `constructor` (groups under 'undefined', never Object)
    const grouped = groupBy([{ a: 1 }], 'constructor');
    expect(Object.keys(grouped)).toEqual(['undefined']);

    expect(filter([1, 2], Function as unknown as (x: number) => boolean)).toEqual([]);
    expect(map(['return 1'], Function as unknown as (x: string) => unknown)).toEqual([]);
    expect(find([1], eval as unknown as (x: number) => boolean)).toBeUndefined();
  });

  it('blocks prototype keys and Function validators in form-binding', () => {
    const state = createFormState(
      [
        { name: 'name', defaultValue: 'Alice' },
        { name: '__proto__', defaultValue: { polluted: true } },
        { name: 'constructor', defaultValue: 'bad' },
      ],
      { name: 'Alice' }
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(state.values, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(state.values, 'constructor')).toBe(false);

    const errors = validateForm(
      state,
      [{ name: 'name', validate: Function as unknown as (v: unknown) => string | null }]
    );
    expect(errors.name).toBeNull();
  });

  it('identifies dangerous host constructors and neutralizes browser globals in markupValue', () => {
    const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
    const GenFn = Object.getPrototypeOf(function* () {}).constructor;
    expect(isBlockedFunction(Function)).toBe(true);
    expect(isBlockedFunction(eval)).toBe(true);
    expect(isBlockedFunction(AsyncFn)).toBe(true);
    expect(isBlockedFunction(GenFn)).toBe(true);
    expect(isBlockedFunction(Object)).toBe(true);
    expect(isBlockedFunction(Reflect.construct)).toBe(true);

    expect(markupValue(Function)).toBeUndefined();
    expect(markupValue(globalThis)).toBeUndefined();
    if (typeof window !== 'undefined') {
      expect(markupValue(window)).toBeUndefined();
      expect(markupValue(window.localStorage)).toBeUndefined();
      expect(markupValue(window.location)).toBeUndefined();
      expect(markupValue(window.navigator)).toBeUndefined();
      expect(markupValue(document)).toBeUndefined();
    }
  });

  it('drops function/object ref props while keeping string ref, and blocks non-primitive SVG attributes', () => {
    const fnProps: Record<string, unknown> = { ref: () => {}, id: 'x' };
    dropRawMarkupProp(fnProps);
    expect('ref' in fnProps).toBe(false);

    const objProps: Record<string, unknown> = { ref: { current: null }, id: 'x' };
    dropRawMarkupProp(objProps);
    expect('ref' in objProps).toBe(false);

    const strProps: Record<string, unknown> = { ref: 'mine', id: 'x' };
    dropRawMarkupProp(strProps);
    expect(strProps.ref).toBe('mine');

    const svgProps: Record<string, unknown> = {
      href: { toString: () => 'javascript:alert(1)' },
      filter: ['url(https://evil.test/#f)'],
    };
    sanitizeSvgReferences(svgProps, 'use', DENY_ALL_EGRESS);
    expect('href' in svgProps).toBe(false);
    expect('filter' in svgProps).toBe(false);
  });

  it('strips obfuscated and var()/attr()/env() top-layer appearance styles in dropTopLayerStyle', () => {
    const props: Record<string, unknown> = {
      style: {
        appearance: 'b\\61se-select',
        webkitAppearance: '/*comment*/ var(--evil-appearance)',
        color: 'blue',
      },
    };
    dropTopLayerStyle(props);
    const style = props.style as Record<string, unknown>;
    expect(style.appearance).toBeUndefined();
    expect(style.webkitAppearance).toBeUndefined();
    expect(style.color).toBe('blue');
  });

  it('blocks CSS line-continuation URL smuggling and SVG presentation URL attributes', () => {
    const smuggled = 'background: url("ht\\\ntps://evil.test/a.png"), url("ht\\\r\ntps://evil.test/b.png");';
    const scan = cssResourceReferences(smuggled);
    expect(scan.urls).toContain('https://evil.test/a.png');
    expect(scan.urls).toContain('https://evil.test/b.png');

    const rewritten = rewriteCssResources(smuggled, (target) => target.startsWith('https://evil.test'));
    expect(rewritten).not.toContain('evil.test');

    const dirtySvg =
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" filter="url(https://evil.test/#f)" mask="url(https://evil.test/#m)" clip-path="url(https://evil.test/#c)" cursor="url(https://evil.test/cur.png), auto" /></svg>';
    const cleaned = sanitizeSvg(dirtySvg, (url) => !url.includes('evil.test'));
    expect(cleaned).not.toContain('evil.test');
  });

  it('rejects generated source modules missing a valid SHA-256 digest header', async () => {
    const forged = new Map<string, string>([
      ['src/App.jsx', 'export default function App() { return null; }'],
      ['__softn_generated__/src/App.jsx.js', `${GENERATED_SOURCE_HEADER}alert(1);`],
    ]);
    await expect(checkSourceModules(forged)).rejects.toThrow(/has changed since its JavaScript was generated/);
  });

  it('rejects forbidden tags and cyclic/over-deep structures in DocumentShell', () => {
    const shell = new DocumentShell([], () => false);
    shell.apply([
      ['e', 2, 'script', {}],
      ['e', 3, 'iframe', {}],
      ['e', 4, 'div', { id: 'safe', __proto__: 'evil' }],
      ['c', 1, [2, 3, 4]],
      ['c', 4, [4]], // self-cycle
    ] as unknown as Parameters<DocumentShell['apply']>[0]);
    const body = shell.bodyFor([]);
    const serialized = JSON.stringify(body).toLowerCase();
    expect(serialized).not.toContain('"tag":"script"');
    expect(serialized).not.toContain('"tag":"iframe"');
    expect(serialized).toContain('"tag":"div"');
    expect(shell.elementFor(4).children).toEqual([]);
  });
});
