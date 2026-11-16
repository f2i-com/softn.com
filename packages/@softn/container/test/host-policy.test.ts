/**
 * What an app can put into the page that embeds it.
 *
 * The app's script runs in a VM and cannot touch the page, but it decides the arguments of
 * every DOM call it makes, and the archive decides the first page's markup and CSS. Each case
 * here is something v0.0.43 let through: script that ran in the embedding page, a request to
 * an origin the app had been granted nothing for, the embedding page navigated or covered,
 * another app's saved data read.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountSoftNContainer } from '../src/index';
import { rewriteCss } from '../src/css-policy';
import { canvasPropertyAllowed, canvasSide, hostElementName, isDeclaredElementProperty } from '../src/host-policy';
import { transformEsModule } from '../src/esm-linker';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LITE_WASM = path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-javascript-lite.wasm');
const EVIL = 'https://evil.example';

function settle(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mount(source: Record<string, string>, extra: Record<string, unknown> = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const errors: string[] = [];
  const handle = await mountSoftNContainer(host, {
    isolation: 'inline',
    engineWasm: { lite: LITE_WASM },
    permissionMode: 'deny',
    onError: (error) => errors.push(error.message),
    source,
    ...extra,
  });
  await settle();
  return { handle, host, errors };
}

/** Everything the page was given, as markup, for a search of the whole of it. */
const drawn = (root: ShadowRoot): string => [...root.querySelectorAll('*')].map((el) => (el.localName === 'style' ? el.textContent : el.outerHTML)).join('\n');

describe('what an app may put into the page that embeds it', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    (globalThis as Record<string, unknown>).__HOST_PWNED__ = false;
  });

  it('names an element by what follows a prefix, in any namespace', () => {
    // createElementNS(svg, 'svg:script') makes an SVG `script`, which runs.
    expect(hostElementName('svg:script', 'svg')).toBeNull();
    expect(hostElementName('x:SCRIPT', undefined)).toBeNull();
    expect(hostElementName('script', 'svg')).toBeNull();
    for (const tag of ['iframe', 'frame', 'object', 'embed', 'base', 'portal', 'fencedframe', 'slot', 'noscript']) expect(hostElementName(tag, undefined), tag).toBeNull();
    // Not a name at all.
    for (const tag of ['', 'a b', 'img/onerror=1', '1up', 'div>']) expect(hostElementName(tag, undefined), tag).toBeNull();
    expect(hostElementName('DIV', undefined)).toBe('div');
    expect(hostElementName('foreignObject', 'svg')).toBe('foreignObject');
    expect(hostElementName('svg:rect', 'svg')).toBe('rect');
    expect(hostElementName('softn-chart', undefined)).toBe('softn-chart');
  });

  it('creates no script from the first page, whatever namespace or prefix it is written in', async () => {
    const { handle } = await mount({
      'index.html': `<!doctype html><html><body>
        <svg><svg:script>window.__HOST_PWNED__ = 'static svg:script'</svg:script><script>window.__HOST_PWNED__ = 'static svg script'</script><rect width="5" height="5"/></svg>
        <math><script>window.__HOST_PWNED__ = 'math script'</script></math>
        <p id="ok">drawn</p></body></html>`,
    });
    expect((globalThis as Record<string, unknown>).__HOST_PWNED__).toBe(false);
    expect([...handle.shadowRoot.querySelectorAll('*')].filter((el) => el.localName.toLowerCase().endsWith('script'))).toEqual([]);
    expect(handle.shadowRoot.querySelector('#ok')?.textContent).toBe('drawn');
    expect(handle.shadowRoot.querySelector('rect')).not.toBeNull();
    handle.dispose();
  });

  it('holds every operation the script sends to the same rule: no script element, no markup through a property', async () => {
    const { handle } = await mount({
      'index.html': `<!doctype html><html><body><p id="ok">…</p><div id="box"></div><script>
        var id = 900001;
        __softnPushExtraOp(['e', id, 'svg:script', {}, 'svg']);
        __softnPushExtraOp(['x', id + 1, "window.__HOST_PWNED__ = 'dynamic svg:script'"]);
        __softnPushExtraOp(['c', id, [id + 1]]);
        __softnPushExtraOp(['e', id + 2, 'SCRIPT', { src: '${EVIL}/x.js' }]);
        __softnPushExtraOp(['e', id + 3, 'img/onerror=1', {}]);
        __softnPushExtraOp(['c', document.getElementById('box').__softnNode, [id, id + 2, id + 3]]);
        var el = document.createElement('softn-anything');
        document.body.appendChild(el);
        __softnPushExtraOp(['p', el.__softnNode, 'innerHTML', '<img src="x" onerror="window.__HOST_PWNED__ = \\'innerHTML\\'">']);
        __softnPushExtraOp(['p', el.__softnNode, 'outerHTML', '<img src="x" onerror="window.__HOST_PWNED__ = \\'outerHTML\\'">']);
        document.getElementById('ok').textContent = 'ran';
      </script></body></html>`,
    });
    await settle(120);
    expect((globalThis as Record<string, unknown>).__HOST_PWNED__).toBe(false);
    expect(handle.shadowRoot.querySelector('#ok')?.textContent).toBe('ran');
    expect([...handle.shadowRoot.querySelectorAll('*')].filter((el) => el.localName.toLowerCase().endsWith('script'))).toEqual([]);
    expect(handle.shadowRoot.querySelector('softn-anything img')).toBeNull();
    handle.dispose();
  });

  it('hands a <softn-*> element only the properties its own class declares', () => {
    class Grid extends HTMLElement {
      kept: unknown;
      set rows(value: unknown) {
        this.kept = value;
      }
    }
    if (!customElements.get('softn-test-grid')) customElements.define('softn-test-grid', Grid);
    const el = document.createElement('softn-test-grid');
    expect(isDeclaredElementProperty(el, 'rows')).toBe(true);
    for (const prop of ['innerHTML', 'outerHTML', 'textContent', 'className', 'id', 'style', 'onclick', 'constructor', '__proto__', 'hidden', 'slot']) {
      expect(isDeclaredElementProperty(el, prop), prop).toBe(false);
    }
    // An element with no class of its own declares nothing.
    expect(isDeclaredElementProperty(document.createElement('softn-unknown-thing'), 'rows')).toBe(false);
  });

  it('fetches nothing the app was not granted: every attribute that names an address, on the first page and after', async () => {
    const { handle } = await mount({
      'index.html': `<!doctype html><html><body>
        <img id="i" src="${EVIL}/src.png" srcset="${EVIL}/srcset.png 1x, ${EVIL}/srcset2.png 2x">
        <picture><source imagesrcset="${EVIL}/imagesrcset.png 1x" srcset="${EVIL}/source.png"></picture>
        <table background="${EVIL}/background.png"><tr><td>t</td></tr></table>
        <a id="p" href="#x" ping="${EVIL}/ping">ping</a>
        <video poster="${EVIL}/poster.png"></video>
        <svg><image href="${EVIL}/image.png"/><a><set attributeName="href" to="javascript:alert(1)"/><text>t</text></a></svg>
        <div popover id="pop">pop</div><button popovertarget="pop">open</button>
        <script>
          var im = document.createElement('img');
          im.setAttribute('srcset', '${EVIL}/dyn-srcset.png 1x');
          im.setAttribute('ping', '${EVIL}/dyn-ping');
          document.body.appendChild(im);
          var a = document.createElement('a');
          a.setAttribute('ping', '${EVIL}/dyn-a-ping');
          a.setAttribute('href', '#y');
          a.id = 'dyn';
          document.body.appendChild(a);
        </script></body></html>`,
    });
    await settle(100);
    const all = drawn(handle.shadowRoot);
    expect(all).not.toContain('evil.example');
    expect(all).not.toContain('javascript:');
    expect(handle.shadowRoot.querySelector('#p')?.hasAttribute('ping')).toBe(false);
    expect(handle.shadowRoot.querySelector('#dyn')?.hasAttribute('ping')).toBe(false);
    expect(handle.shadowRoot.querySelector('set')?.hasAttribute('attributeName')).toBe(false);
    expect(handle.shadowRoot.querySelector('#pop')?.hasAttribute('popover')).toBe(false);
    handle.dispose();
  });

  it('reads CSS as CSS does: an escaped url(), a bracket inside a quoted address, image-set(), @import', () => {
    const kept: string[] = [];
    const css = rewriteCss(
      `@import url("${EVIL}/import.css"); @\\69mport "${EVIL}/escaped-import.css";
       .a{background:u\\72l(${EVIL}/escaped.png)}
       .b{background-image:image-set("${EVIL}/set.png" 1x, url(${EVIL}/set2.png) 2x)}
       .c{background:url("${EVIL}/paren.png?a=)")}
       .d{background:URL( '${EVIL}/upper.png' )}
       .e{background:-webkit-image-set("${EVIL}/webkit.png" 1x)}
       .f{content:"url(${EVIL}/in-a-string.png)"; width:expression(alert(1))}
       .sm\\:flex{display:flex} /* a comment with url(${EVIL}/comment.png) */
       .g{background:url(#gradient)}`,
      (address) => {
        kept.push(address);
        return address.startsWith('#') ? address : null;
      }
    );
    // Every address was asked about as CSS resolves it; none was let through.
    expect(kept.sort()).toEqual([
      '#gradient',
      `${EVIL}/escaped.png`,
      `${EVIL}/paren.png?a=)`,
      `${EVIL}/set.png`,
      `${EVIL}/set2.png`,
      `${EVIL}/upper.png`,
      `${EVIL}/webkit.png`,
    ]);
    expect(css).not.toMatch(/evil\.example\/(?!in-a-string)/);
    expect(css).not.toContain('@import');
    expect(css).not.toContain('expression');
    // What is not an address is as it was: a string's text, an escaped class name.
    expect(css).toContain(`"url(${EVIL}/in-a-string.png)"`);
    expect(css).toContain('.sm\\:flex{display:flex}');
    expect(css).toContain('url("#gradient")');
  });

  it('keeps :host out of the app’s reach, however it is spelled', () => {
    const css = rewriteCss(
      `:host{position:fixed;inset:0} :host(.x) p{color:red} :host-context(body){display:none} :\\68ost{z-index:9} a:hover{color:blue} p::before{content:":host"}`,
      () => null
    );
    expect(css).not.toMatch(/:host(?![^"]*")/);
    expect(css.match(/:not\(\*\)/g)?.length).toBe(4);
    expect(css).toContain('a:hover{color:blue}');
    expect(css).toContain('p::before{content:":host"}');
  });

  it('sanitises a stylesheet the script writes, and one it links to, before the page reads it', async () => {
    const { handle } = await mount({
      'theme.css': `@import url("${EVIL}/linked-import.css"); .t{background:url(${EVIL}/linked.png); color: rgb(1, 2, 3)}`,
      'index.html': `<!doctype html><html><body><p class="t z" id="p">p</p><script>
        var st = document.createElement('style');
        st.textContent = '@import url("${EVIL}/dyn-import.css"); .z{background:url(${EVIL}/dyn.png); outline: 3px solid rgb(4, 5, 6)}';
        document.body.appendChild(st);
        var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = './theme.css'; document.body.appendChild(l);
        var pre = document.createElement('link'); pre.rel = 'preload'; pre.href = '${EVIL}/preload.js'; document.body.appendChild(pre);
      </script></body></html>`,
    });
    await settle(100);
    const sheets = [...handle.shadowRoot.querySelectorAll('style')].map((el) => el.textContent ?? '');
    expect(sheets.join('\n')).not.toContain('evil.example');
    // Both sheets arrived, with what is harmless in them intact.
    expect(sheets.some((text) => text.includes('rgb(4, 5, 6)'))).toBe(true);
    expect(sheets.some((text) => text.includes('rgb(1, 2, 3)'))).toBe(true);
    // The page has no <link>: it never fetches what one names.
    expect(handle.shadowRoot.querySelector('link')).toBeNull();
    handle.dispose();
  });

  it('never gives a file the browser would run as a document a same-origin address', async () => {
    const { handle } = await mount({
      'pic.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>top.__HOST_PWNED__ = 1</script></svg>',
      'index.html': `<!doctype html><html><body><img id="i" src="pic.svg"><a id="a" href="pic.svg">open</a><a id="page" href="index.html">home</a></body></html>`,
    });
    // An SVG as an image is a data: address: it draws, runs nothing, and opens as no page.
    expect(handle.shadowRoot.querySelector('#i')?.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
    // A link to a file of the app's keeps the file's path, which only the container follows.
    expect(handle.shadowRoot.querySelector('#a')?.getAttribute('href')).toBe('pic.svg');
    expect(handle.shadowRoot.querySelector('#page')?.getAttribute('href')).toBe('index.html');
    expect(drawn(handle.shadowRoot)).not.toContain('blob:');
    handle.dispose();
  });

  it('opens a link out in a tab of its own, whatever target the app wrote and in whatever order', async () => {
    const { handle } = await mount({
      'index.html': `<!doctype html><html><body>
        <a id="s" href="https://example.org/" target="_top">static</a>
        <map name="m"><area id="area" href="https://example.org/area" target="_parent" shape="rect" coords="0,0,5,5"></map>
        <form id="f" action="https://example.org/post" target="_top"></form>
        <script>
          var a = document.createElement('a'); a.id = 'd';
          a.setAttribute('href', 'https://example.org/later');
          a.setAttribute('target', '_top');
          a.setAttribute('rel', 'opener');
          document.body.appendChild(a);
        </script></body></html>`,
    });
    await settle(100);
    for (const id of ['#s', '#area', '#d']) {
      const link = handle.shadowRoot.querySelector(id)!;
      expect(link.getAttribute('target'), id).toBe('_blank');
      expect(link.getAttribute('rel'), id).toBe('noopener noreferrer');
    }
    // A target that names the embedding page is not set at all.
    expect(handle.shadowRoot.querySelector('#f')?.hasAttribute('target')).toBe(false);

    // A click is the host's to carry out: the browser's own navigation never happens.
    const opened: unknown[][] = [];
    const realOpen = window.open;
    window.open = ((...args: unknown[]) => {
      opened.push(args);
      return null;
    }) as typeof window.open;
    try {
      const click = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
      handle.shadowRoot.querySelector('#s')!.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
      expect(opened).toEqual([['https://example.org/', '_blank', 'noopener,noreferrer']]);
    } finally {
      window.open = realOpen;
    }
    handle.dispose();
  });

  it('opens a dialog without the browser’s top layer', async () => {
    const { handle } = await mount({
      'index.html': `<!doctype html><html><body><dialog id="d">hello</dialog><script>document.getElementById('d').showModal();</script></body></html>`,
    });
    await settle(100);
    const dialog = handle.shadowRoot.querySelector('#d') as HTMLDialogElement;
    expect(dialog.hasAttribute('open')).toBe(true);
    // jsdom has no :modal; a dialog shown with showModal() is the only kind in the top layer.
    let modal = false;
    try {
      modal = dialog.matches(':modal');
    } catch {
      modal = false;
    }
    expect(modal).toBe(false);
    handle.dispose();
  });

  it('reads an SVG paint attribute as the CSS it is, and never sets autofocus', async () => {
    const { handle } = await mount({
      'index.html': `<!doctype html><html><body>
        <svg width="20" height="20"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs>
          <rect id="r" width="20" height="20" fill="url(#g)" mask="url(${EVIL}/mask.png)" filter="url(${EVIL}/f.svg#f)" stroke="rgb(1, 2, 3)"/>
        </svg>
        <input id="field" autofocus>
        <script>
          var c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          c.setAttribute('id', 'c');
          c.setAttribute('clip-path', 'u\\\\72l(${EVIL}/clip.svg#c)');
          c.setAttribute('fill', 'blue');
          document.querySelector('svg').appendChild(c);
        </script></body></html>`,
    });
    await settle(100);
    expect(drawn(handle.shadowRoot)).not.toContain('evil.example');
    const rect = handle.shadowRoot.querySelector('#r')!;
    // A reference into the same document is as it was; so is a paint that names no address.
    expect(rect.getAttribute('fill')).toContain('#g');
    expect(rect.getAttribute('stroke')).toBe('rgb(1, 2, 3)');
    expect(handle.shadowRoot.querySelector('#c')?.getAttribute('fill')).toBe('blue');
    expect(handle.shadowRoot.querySelector('#field')?.hasAttribute('autofocus')).toBe(false);
    handle.dispose();
  });

  it('gives the app the focus only where that takes it from nobody', async () => {
    // The embedding page's own field, with the person typing in it.
    const hostField = document.createElement('input');
    document.body.appendChild(hostField);
    hostField.focus();
    expect(document.activeElement).toBe(hostField);
    const { handle, host } = await mount({
      'index.html': `<!doctype html><html><body><input id="mine"><button id="go">go</button><script>
        document.getElementById('mine').focus();
        document.getElementById('go').addEventListener('click', function () { document.getElementById('mine').focus(); });
      </script></body></html>`,
    });
    await settle(100);
    // The app asked for the focus as it started: the person's field keeps it.
    expect(document.activeElement).toBe(hostField);
    // With nothing in the page focused, the app may take it.
    hostField.blur();
    handle.shadowRoot.querySelector('#go')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
    await settle(100);
    expect(document.activeElement).toBe(host);
    expect(handle.shadowRoot.activeElement?.id).toBe('mine');
    handle.dispose();
  });

  it('holds a canvas to a size the page can hold', () => {
    expect(canvasSide(300)).toBe(300);
    expect(canvasSide(1e9)).toBe(8192);
    expect(canvasSide(-5)).toBe(0);
    expect(canvasSide(Number.NaN)).toBe(0);
    expect(canvasSide('300')).toBe(0);
  });

  it('sets only drawing properties on a canvas context', () => {
    expect(canvasPropertyAllowed('fillStyle', '#f00')).toBe(true);
    expect(canvasPropertyAllowed('lineWidth', 3)).toBe(true);
    expect(canvasPropertyAllowed('imageSmoothingEnabled', false)).toBe(true);
    expect(canvasPropertyAllowed('filter', 'blur(2px)')).toBe(true);
    // A filter that names an address is fetched.
    expect(canvasPropertyAllowed('filter', `url(${EVIL}/f.svg#f)`)).toBe(false);
    expect(canvasPropertyAllowed('filter', 'u\\72l(x)')).toBe(false);
    for (const name of ['__proto__', 'constructor', 'canvas', 'innerHTML', 'toString']) expect(canvasPropertyAllowed(name, 'x'), name).toBe(false);
    expect(canvasPropertyAllowed('fillStyle', { toString: 'x' })).toBe(false);
  });

  it('keeps an app’s saved data where the app cannot choose: not under the id its manifest claims', async () => {
    const alpha = await mount(
      {
        'manifest.json': JSON.stringify({ name: 'Alpha', version: '1', id: 'shared-id', engine: 2 }),
        'index.html': `<!doctype html><html><body><script>localStorage.setItem('note', 'ALPHA-PRIVATE-VALUE')</script></body></html>`,
      },
      { permissionMode: 'deny' }
    );
    alpha.handle.dispose();
    const keys = Object.keys(localStorage);
    expect(keys.length).toBe(1);
    expect(keys[0]).toMatch(/^softn-v2:sha256:[0-9a-f]{64}:ls:note$/);
    const beta = await mount({
      'manifest.json': JSON.stringify({ name: 'Beta', version: '1', id: 'shared-id', engine: 2 }),
      'index.html': `<!doctype html><html><body><pre id="o">…</pre><script>document.getElementById('o').textContent = String(localStorage.getItem('note'))</script></body></html>`,
    });
    expect(beta.handle.shadowRoot.querySelector('#o')?.textContent).toBe('null');
    expect(beta.handle.appId).not.toBe(alpha.handle.appId);
    beta.handle.dispose();
    // A host that names the place itself is taken at its word.
    const named = await mount({ 'index.html': '<!doctype html><html><body><script>localStorage.setItem("k", "v")</script></body></html>' }, { appId: 'host-chosen' });
    expect(Object.keys(localStorage)).toContain('softn-v2:host-chosen:ls:k');
    named.handle.dispose();
  });

  it('counts the app’s records against its storage quota, in the Worker and in the page', async () => {
    const { handle } = await mount(
      {
        'index.html': `<!doctype html><html><body><pre id="o">…</pre><script type="module">
          import { db } from 'softn:db';
          let kept = 0, refused = '';
          try { for (let i = 0; i < 400; i++) { db.create('notes', { text: 'x'.repeat(200) }); kept++; } } catch (e) { refused = String(e.message); }
          document.getElementById('o').textContent = kept + '|' + refused;
        </script></body></html>`,
      },
      { appId: 'quota-app', limits: { storageQuotaBytes: 20_000 } }
    );
    await settle(150);
    const [kept, refused] = (handle.shadowRoot.querySelector('#o')?.textContent ?? '').split('|');
    expect(Number(kept)).toBeGreaterThan(0);
    expect(Number(kept)).toBeLessThan(400);
    // The app is told it failed (the engine does not pass the host's own words on).
    expect(refused).not.toBe('');
    const stored = localStorage.getItem('softn-v2:quota-app:db') ?? '';
    expect(stored.length * 2).toBeLessThanOrEqual(20_000);
    handle.dispose();
  });

  it('shares functions and vars between the page’s classic scripts, and goes on past one that fails', async () => {
    const { handle } = await mount({
      'index.html': `<!doctype html><html><body><pre id="o">…</pre>
        <script>function greet(name) { return 'hi ' + name; } var SHARED = 41;</script>
        <script>this is not javascript</script>
        <script>throw new Error('second script fails');</script>
        <script>document.getElementById('o').textContent = greet('world') + ' / ' + (SHARED + 1);</script>
      </body></html>`,
    });
    await settle(100);
    expect(handle.shadowRoot.querySelector('#o')?.textContent).toBe('hi world / 42');
    handle.dispose();
  });

  it('resolves a dynamic import against the module that asks, with or without a second argument', () => {
    const plain = transformEsModule(`const m = await import('./a.js');`, 'https://app.softn.local/lib/app.js').factoryCode;
    expect(plain).toContain(`__import('./a.js', __meta.url)`);
    const withOptions = transformEsModule(`const m = await import('./data.json', { with: { type: 'json' } });`, 'https://app.softn.local/lib/app.js').factoryCode;
    expect(withOptions).toContain(`__import('./data.json', __meta.url)`);
    expect(withOptions).not.toContain('type:');
  });

  it('lets only the newest mount into an element draw in it or empty it', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const options = (text: string) => ({
      isolation: 'inline' as const,
      engineWasm: { lite: LITE_WASM },
      permissionMode: 'deny' as const,
      source: { 'index.html': `<!doctype html><html><body><p id="who">${text}</p></body></html>` },
    });
    // What a host's re-render does: a second mount starts while the first is starting, and
    // the first is disposed when it resolves.
    const first = mountSoftNContainer(host, options('first'));
    const second = mountSoftNContainer(host, options('second'));
    (await first).dispose();
    const live = await second;
    await settle();
    expect(live.shadowRoot.querySelector('#who')?.textContent).toBe('second');
    // And an earlier mount disposed late still leaves the live one alone.
    const third = await mountSoftNContainer(host, options('third'));
    live.dispose();
    expect(third.shadowRoot.querySelector('#who')?.textContent).toBe('third');
    third.dispose();
    expect(third.shadowRoot.querySelector('#who')).toBeNull();
  });
});
