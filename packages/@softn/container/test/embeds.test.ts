/**
 * Another document in an app's page: a frame of a site the app was allowed (`<iframe>`), and
 * an app of the app's own (`<softn-app src>`).
 *
 * Both were refused outright, and still are for a mount that does not allow them. Allowed,
 * neither is made as the app wrote it: a frame is sandboxed by the host and shows only an
 * `https:` site the person allowed the app, and a nested app is a container of its own, with
 * its own data, allowed no more than the app around it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { ContainerArchive, mountSoftNContainer } from '../src/index';
import { nestedPermissions } from '../src/softn-app';
import { HostDomPatcher } from '../src/dom-patcher';
import {
  FRAME_REFERRER_DEFAULT,
  FRAME_SANDBOX,
  MAX_HOST_FRAMES,
  MAX_NESTED_APPS,
  MAX_NESTED_STARTS,
  MAX_TREE_NESTED_APPS,
  frameSandbox,
  guardFrame,
  hostAttributeValue,
  hostElementName,
  isNestedAppFile,
  isTrippedFrame,
  nestedAppSource,
  newEmbedBudget,
} from '../src/host-policy';
import { sanitizeFrameUrl } from '../src/sanitize';
import type { ContainerPermissions, ShellOp } from '../src/types';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LITE_WASM = path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-javascript-lite.wasm');

const VIDEO: ContainerPermissions = { permissions: { net: { enabled: true, allowed_hosts: ['www.youtube.com', '*.vimeo.com'] } } };
const permissionJson = (permissions: ContainerPermissions): string => JSON.stringify(permissions);

function settle(ms = 80): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mount(source: Record<string, string | Uint8Array> | Uint8Array, extra: Record<string, unknown> = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const said: string[] = [];
  const errors: string[] = [];
  const handle = await mountSoftNContainer(host, {
    isolation: 'inline',
    engineWasm: { lite: LITE_WASM },
    permissionMode: 'preapproved',
    // Frames are the host's to turn on (as softn.com does): a mount that says nothing has none.
    frames: 'allow',
    onConsole: (level, text) => said.push(`${level}: ${text}`),
    onError: (error) => errors.push(error.message),
    source,
    ...extra,
  });
  await settle();
  return { handle, host, said, errors };
}

/** An app as an archive's bytes, to be carried inside another. */
const packed = (files: Record<string, string | Uint8Array>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([name, body]) => [name, typeof body === 'string' ? strToU8(body) : body])));

const frames = (root: ShadowRoot): HTMLIFrameElement[] => [...root.querySelectorAll('iframe')];

describe('a frame in an app’s page', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('is an element only for a mount that allows frames, and never in SVG or MathML', () => {
    expect(hostElementName('iframe')).toBeNull();
    expect(hostElementName('iframe', undefined, { apps: true })).toBeNull();
    expect(hostElementName('iframe', undefined, { frames: true })).toBe('iframe');
    expect(hostElementName('x:IFRAME', undefined, { frames: true })).toBe('iframe');
    expect(hostElementName('iframe', 'svg', { frames: true })).toBeNull();
    expect(hostElementName('iframe', 'math', { frames: true })).toBeNull();
    // The other documents are no one's to have, allowance or not.
    for (const tag of ['frame', 'frameset', 'object', 'embed', 'portal', 'fencedframe', 'script', 'base']) {
      expect(hostElementName(tag, undefined, { frames: true, apps: true }), tag).toBeNull();
    }
  });

  it('shows an https site the person allowed the app, and nothing else', () => {
    const ok = (address: string) => sanitizeFrameUrl(address, VIDEO, true);
    expect(ok('https://www.youtube.com/embed/abc?rel=0')).toBe('https://www.youtube.com/embed/abc?rel=0');
    expect(ok('//www.youtube.com/embed/abc')).toBe('https://www.youtube.com/embed/abc');
    expect(ok('https://player.vimeo.com/video/1')).toBe('https://player.vimeo.com/video/1');
    expect(ok(' https://www.youtube.com/\tembed/\nabc ')).toBe('https://www.youtube.com/embed/abc');
    // Not allowed the network (not yet, or never), or not that site.
    expect(sanitizeFrameUrl('https://www.youtube.com/embed/abc', VIDEO, false)).toBeNull();
    expect(sanitizeFrameUrl('https://www.youtube.com/embed/abc', {}, true)).toBeNull();
    expect(ok('https://evil.example/')).toBeNull();
    expect(ok('https://www.youtube.com.evil.example/embed/abc')).toBeNull();
    expect(ok('https://www.youtube.com@evil.example/embed/abc')).toBeNull();
    // Never plain http, even for an app that declared it; and never anything that is not a site.
    const http: ContainerPermissions = { permissions: { net: { enabled: true, allow_http: true, allowed_hosts: ['www.youtube.com'] } } };
    expect(sanitizeFrameUrl('http://www.youtube.com/embed/abc', http, true)).toBeNull();
    for (const address of ['', 'about:blank', 'javascript:alert(1)', 'data:text/html,<script>1</script>', 'blob:https://www.youtube.com/x', 'page.html', '/page.html', './page.html', 'softn-blob:1', 'file:///etc/passwd']) {
      expect(ok(address), address).toBeNull();
    }
    // Nor a private or local address, even one the app listed: a frame is something the person clicks in.
    const local: ContainerPermissions = { permissions: { net: { enabled: true, allowed_hosts: ['192.168.1.1', 'localhost', 'router.local', '10.0.0.2'] } } };
    for (const address of ['https://192.168.1.1/', 'https://localhost/', 'https://localhost:3000/', 'https://10.0.0.2/admin', 'https://169.254.169.254/']) {
      expect(sanitizeFrameUrl(address, local, true), address).toBeNull();
    }
    // Any public site, for an app that declared the network without naming hosts.
    expect(sanitizeFrameUrl('https://example.org/embed', { permissions: { net: { enabled: true } } }, true)).toBe('https://example.org/embed');
  });

  it('never shows the embedding page’s own site', () => {
    const here = globalThis.location;
    const everywhere: ContainerPermissions = { permissions: { net: { enabled: true, allowed_hosts: ['*', 'softn.example', 'api.softn.example'] } } };
    Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL('https://softn.example/play/app') });
    try {
      expect(sanitizeFrameUrl('https://softn.example/account', everywhere, true)).toBeNull();
      expect(sanitizeFrameUrl('https://softn.example:8443/account', everywhere, true)).toBeNull();
      // Another host of the same site is sent the person's cookies for it as the page itself is.
      expect(sanitizeFrameUrl('https://api.softn.example/account', everywhere, true)).toBeNull();
      expect(sanitizeFrameUrl('https://www.youtube.com/embed/abc', everywhere, true)).toBe('https://www.youtube.com/embed/abc');
    } finally {
      Object.defineProperty(globalThis, 'location', { configurable: true, value: here });
    }
  });

  it('is given only the attributes that are a frame’s, each by the host’s rule', async () => {
    const archive = await ContainerArchive.open({ 'index.html': '<p>x</p>' });
    const set = (name: string, value: string, netGranted = true) =>
      hostAttributeValue('iframe', name, value, { entryPath: 'index.html', archive, permissions: VIDEO, netGranted });
    expect(set('src', 'https://www.youtube.com/embed/abc')).toBe('https://www.youtube.com/embed/abc');
    expect(set('src', 'https://www.youtube.com/embed/abc', false)).toBeNull();
    expect(set('SRC', 'https://evil.example/')).toBeNull();
    // A document written into the element, a name to be reached by, a handler: never.
    for (const name of ['srcdoc', 'name', 'onload', 'csp', 'credentialless', 'allowpaymentrequest', 'target', 'crossorigin', 'data-softn-id', 'is']) {
      expect(set(name, 'x'), name).toBeNull();
    }
    // The sandbox only ever narrower than the host's.
    expect(set('sandbox', 'allow-scripts allow-top-navigation allow-modals ALLOW-FORMS allow-downloads')).toBe('allow-scripts allow-forms');
    expect(set('sandbox', '')).toBe('');
    expect(set('sandbox', 'allow-top-navigation-by-user-activation allow-same-origin')).toBe('allow-same-origin');
    expect(frameSandbox()).toBe(FRAME_SANDBOX.join(' '));
    for (const never of ['allow-top-navigation', 'allow-top-navigation-by-user-activation', 'allow-modals', 'allow-downloads', 'allow-pointer-lock']) {
      expect(FRAME_SANDBOX, never).not.toContain(never);
    }
    // Of the page's own permissions, what a player needs and no more.
    expect(set('allow', 'accelerometer; autoplay *; camera; microphone *; geolocation; fullscreen; display-capture; payment; picture-in-picture')).toBe(
      'autoplay; fullscreen; picture-in-picture'
    );
    expect(set('allow', 'camera; microphone')).toBeNull();
    // Nor the clipboard, the share sheet or the device's motion, which a player's embed code asks for and plays without.
    expect(set('allow', 'clipboard-write; web-share; gyroscope; accelerometer')).toBeNull();
    expect(set('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share')).toBe('autoplay; encrypted-media; picture-in-picture');
    expect(set('allowfullscreen', 'true')).toBe('');
    // The embedding page's origin at most, never its whole address.
    expect(set('referrerpolicy', 'no-referrer')).toBe('no-referrer');
    expect(set('referrerpolicy', 'unsafe-url')).toBe(FRAME_REFERRER_DEFAULT);
    expect(set('referrerpolicy', 'no-referrer-when-downgrade')).toBe(FRAME_REFERRER_DEFAULT);
    expect(set('loading', 'LAZY')).toBe('lazy');
    expect(set('loading', 'whenever')).toBeNull();
    expect(set('width', '560')).toBe('560');
    expect(set('height', '56.25%')).toBe('56.25%');
    expect(set('width', 'calc(1px)')).toBeNull();
    expect(set('title', 'A video')).toBe('A video');
    expect(set('class', 'player')).toBe('player');
    expect(set('data-video', 'abc')).toBe('abc');
    archive.dispose();
  });

  it('is emptied when it comes to hold a document of the embedding page’s own origin', () => {
    const frame = document.createElement('iframe');
    frame.setAttribute('src', 'https://www.youtube.com/embed/abc');
    let replaced = '';
    const win = (href: string | Error) => ({
      location: {
        get href() {
          if (href instanceof Error) throw href;
          return href;
        },
        replace: (to: string) => {
          replaced = to;
        },
      },
    });
    // Another origin's document cannot be read from here: what the frame is for.
    Object.defineProperty(frame, 'contentWindow', { configurable: true, value: win(new Error('cross-origin')) });
    guardFrame(frame);
    expect(frame.getAttribute('src')).toBe('https://www.youtube.com/embed/abc');
    // Nor is an empty frame anything to act on.
    Object.defineProperty(frame, 'contentWindow', { configurable: true, value: win('about:blank') });
    guardFrame(frame);
    expect(frame.hasAttribute('src')).toBe(true);
    // A page of the embedding site, reached by the framed site's redirect: readable, so it must not be there.
    Object.defineProperty(frame, 'contentWindow', { configurable: true, value: win('http://localhost:3000/account') });
    guardFrame(frame);
    expect(frame.hasAttribute('src')).toBe(false);
    expect(replaced).toBe('about:blank');
  });

  it('is made from the first page’s markup sandboxed, with the allowed site and nothing the app added', async () => {
    const { handle } = await mount({
      'permission.json': permissionJson(VIDEO),
      'index.html': `<!DOCTYPE html><html><body>
        <iframe id="ok" src="https://www.youtube.com/embed/abc" width="560" height="315" title="Video"
          allow="autoplay; camera; fullscreen" allowfullscreen sandbox="allow-scripts allow-same-origin allow-top-navigation"
          name="win" onload="window.__HOST_PWNED__ = true"></iframe>
        <iframe id="bad" src="https://evil.example/frame"></iframe>
        <iframe id="doc" srcdoc="<script>parent.__HOST_PWNED__ = true</script>"></iframe>
        <iframe id="own" src="index.html"></iframe>
      </body></html>`,
    });
    const [ok, bad, doc, own] = ['ok', 'bad', 'doc', 'own'].map((id) => handle.shadowRoot.getElementById(id) as HTMLIFrameElement);
    expect(ok.getAttribute('src')).toBe('https://www.youtube.com/embed/abc');
    expect(ok.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
    expect(ok.getAttribute('allow')).toBe('autoplay; fullscreen');
    expect(ok.getAttribute('referrerpolicy')).toBe(FRAME_REFERRER_DEFAULT);
    // Shown as to someone the site has never seen (and, on a page that is cross-origin
    // isolated, shown at all: without it the browser refuses a player's document there).
    expect(ok.hasAttribute('credentialless')).toBe(true);
    expect(ok.hasAttribute('allowfullscreen')).toBe(true);
    expect(ok.hasAttribute('name')).toBe(false);
    expect(ok.hasAttribute('onload')).toBe(false);
    for (const frame of [bad, doc, own]) {
      expect(frame.hasAttribute('src'), frame.id).toBe(false);
      expect(frame.hasAttribute('srcdoc'), frame.id).toBe(false);
      expect(frame.getAttribute('sandbox'), frame.id).toBe(frameSandbox());
    }
    expect((globalThis as Record<string, unknown>).__HOST_PWNED__).not.toBe(true);
    handle.dispose();
  });

  it('is made by the app’s script the same way, and keeps its sandbox whatever the script takes off', async () => {
    const { handle } = await mount({
      'permission.json': permissionJson(VIDEO),
      'index.html': `<!DOCTYPE html><html><body><div id="root"></div><script>
        const root = document.getElementById('root');
        const a = document.createElement('iframe');
        a.id = 'a';
        a.setAttribute('src', 'https://player.vimeo.com/video/7');
        a.setAttribute('srcdoc', '<script>parent.__HOST_PWNED__ = true<\\/script>');
        root.appendChild(a);
        a.removeAttribute('sandbox');
        a.removeAttribute('referrerpolicy');
        a.removeAttribute('credentialless');
        const b = document.createElement('iframe');
        b.id = 'b';
        b.src = 'https://www.youtube.com/embed/prop';
        root.appendChild(b);
        const c = document.createElement('iframe');
        c.id = 'c';
        c.setAttribute('src', 'https://www.youtube.com/embed/first');
        root.appendChild(c);
        c.setAttribute('src', 'https://evil.example/second');
      </script></body></html>`,
    });
    const a = handle.shadowRoot.getElementById('a') as HTMLIFrameElement;
    expect(a.getAttribute('src')).toBe('https://player.vimeo.com/video/7');
    expect(a.hasAttribute('srcdoc')).toBe(false);
    expect(a.getAttribute('sandbox')).toBe(frameSandbox());
    expect(a.getAttribute('referrerpolicy')).toBe(FRAME_REFERRER_DEFAULT);
    expect(a.hasAttribute('credentialless')).toBe(true);
    // Set as a property, as a player's own snippet does.
    expect(handle.shadowRoot.getElementById('b')?.getAttribute('src')).toBe('https://www.youtube.com/embed/prop');
    // Asked for a site it may not have, a frame shows nothing: not what it showed before.
    expect(handle.shadowRoot.getElementById('c')?.hasAttribute('src')).toBe(false);
    handle.dispose();
  });

  it('shows its site only while the person allows the app the network', async () => {
    const { handle } = await mount(
      {
        'permission.json': permissionJson(VIDEO),
        'index.html': '<!DOCTYPE html><html><body><iframe id="v" src="https://www.youtube.com/embed/abc"></iframe><script>document.title = "ran";</script></body></html>',
      },
      { permissionMode: 'deny' }
    );
    const frame = () => handle.shadowRoot.getElementById('v') as HTMLIFrameElement;
    expect(frame().hasAttribute('src')).toBe(false);
    expect(frame().getAttribute('sandbox')).toBe(frameSandbox());
    handle.setGrantedCapabilities(['net']);
    expect(frame().getAttribute('src')).toBe('https://www.youtube.com/embed/abc');
    handle.setGrantedCapabilities([]);
    expect(frame().hasAttribute('src')).toBe(false);
    handle.dispose();
  });

  it('is not made at all for an app that declares no network, or a host that wants none', async () => {
    const page = '<!DOCTYPE html><html><body><iframe src="https://www.youtube.com/embed/abc"></iframe><script>document.body.appendChild(document.createElement("iframe"));</script></body></html>';
    const none = await mount({ 'index.html': page });
    expect(frames(none.handle.shadowRoot)).toHaveLength(0);
    none.handle.dispose();
    const denied = await mount({ 'permission.json': permissionJson(VIDEO), 'index.html': page }, { frames: 'deny' });
    expect(frames(denied.handle.shadowRoot)).toHaveLength(0);
    denied.handle.dispose();
    // Nor for a host that says nothing of frames: one that mounts an app as it did before
    // these existed is not given another site's documents in its page by an upgrade.
    const unsaid = await mount({ 'permission.json': permissionJson(VIDEO), 'index.html': page }, { frames: undefined });
    expect(frames(unsaid.handle.shadowRoot)).toHaveLength(0);
    unsaid.handle.dispose();
  });

  it('is one of no more than a page holds', async () => {
    const many = Array.from({ length: MAX_HOST_FRAMES + 6 }, (_, i) => `<iframe src="https://www.youtube.com/embed/s${i}"></iframe>`).join('');
    const { handle, said } = await mount({
      'permission.json': permissionJson(VIDEO),
      'index.html': `<!DOCTYPE html><html><body>${many}<script>
        for (let i = 0; i < 6; i++) {
          const f = document.createElement('iframe');
          f.setAttribute('src', 'https://www.youtube.com/embed/d' + i);
          document.body.appendChild(f);
        }
      </script></body></html>`,
    });
    const shown = frames(handle.shadowRoot).filter((frame) => frame.hasAttribute('src'));
    expect(shown.length).toBe(MAX_HOST_FRAMES);
    expect(said.some((line) => line.startsWith('warn:') && line.includes(`${MAX_HOST_FRAMES} frames`))).toBe(true);
    handle.dispose();
    // Disposed, no frame is left showing a site.
    expect(shown.every((frame) => !frame.hasAttribute('src'))).toBe(true);
  });

  it('keeps the frames a script makes in one turn up to the bound, and says so past it', async () => {
    const { handle, said } = await mount({
      'permission.json': permissionJson(VIDEO),
      'index.html': `<!DOCTYPE html><html><body><div id="root"></div><script>
        // All in one turn: none is on the page until the turn ends.
        for (let i = 0; i < ${MAX_HOST_FRAMES + 1}; i++) {
          const f = document.createElement('iframe');
          f.setAttribute('src', 'https://www.youtube.com/embed/t' + i);
          document.getElementById('root').appendChild(f);
        }
        // Then one of them is moved, with every place taken.
        setTimeout(() => { const root = document.getElementById('root'); root.insertBefore(root.children[3], root.firstChild); }, 150);
      </script></body></html>`,
    });
    await settle(120);
    // Each made earlier in the turn was let go of for the next, and one was left showing, with nothing said.
    expect(frames(handle.shadowRoot).filter((frame) => frame.hasAttribute('src'))).toHaveLength(MAX_HOST_FRAMES);
    expect(said.some((line) => line.startsWith('warn:') && line.includes(`${MAX_HOST_FRAMES} frames`))).toBe(true);
    await settle(300);
    // The one moved still shows its site: it is the same frame, not one more.
    const shown = frames(handle.shadowRoot).filter((frame) => frame.hasAttribute('src'));
    expect(shown).toHaveLength(MAX_HOST_FRAMES);
    expect(shown.map((frame) => frame.getAttribute('src'))).toContain('https://www.youtube.com/embed/t3');
    handle.dispose();
  });

  it('shows nothing again in a frame that came to hold the embedding site’s own page, nor that address in another', async () => {
    const { handle, said } = await mount({
      'permission.json': permissionJson(VIDEO),
      'index.html': `<!DOCTYPE html><html><body><iframe id="one" src="https://www.youtube.com/embed/turns"></iframe><button id="again">again</button><script>
        document.getElementById('again').addEventListener('click', () => {
          const one = document.getElementById('one');
          one.removeAttribute('src');
          one.setAttribute('src', 'https://www.youtube.com/embed/turns');
          const two = document.createElement('iframe');
          two.id = 'two';
          two.setAttribute('src', 'https://www.youtube.com/embed/turns');
          document.body.appendChild(two);
          const three = document.createElement('iframe');
          three.id = 'three';
          three.setAttribute('src', 'https://www.youtube.com/embed/other');
          document.body.appendChild(three);
        });
      </script></body></html>`,
    });
    const one = handle.shadowRoot.getElementById('one') as HTMLIFrameElement;
    expect(one.getAttribute('src')).toBe('https://www.youtube.com/embed/turns');
    // The framed site sends the frame to a page of the embedding site's: readable from here, so it must not be there.
    Object.defineProperty(one, 'contentWindow', {
      configurable: true,
      value: { location: { href: `${window.location.origin}/account`, replace: () => undefined } },
    });
    // Seen without waiting for the frame to finish loading.
    await settle(400);
    expect(one.hasAttribute('src')).toBe(false);
    expect(isTrippedFrame(one)).toBe(true);
    expect(said.some((line) => line.startsWith('warn:') && line.includes('A frame was emptied'))).toBe(true);
    // Asked for again, on the same frame and on a new one: it took its address back each time, and loaded it again.
    (handle.shadowRoot.getElementById('again') as HTMLElement).click();
    await settle(200);
    expect(one.hasAttribute('src')).toBe(false);
    expect((handle.shadowRoot.getElementById('two') as HTMLIFrameElement).hasAttribute('src')).toBe(false);
    // Another address of the same site is still shown.
    expect((handle.shadowRoot.getElementById('three') as HTMLIFrameElement).getAttribute('src')).toBe('https://www.youtube.com/embed/other');
    handle.dispose();
  });
});

describe('an app nested in an app’s page', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  const child = (label: string, extra: Record<string, string | Uint8Array> = {}, body = ''): Uint8Array =>
    packed({
      'index.html': `<!DOCTYPE html><html><body>${body}<p id="who">${label}</p><script>
        console.log('${label} ran');
        localStorage.setItem('who', '${label}');
        console.log('${label} kept ' + localStorage.getItem('who'));
      </script></body></html>`,
      ...extra,
    });

  it('is an element only for a mount that allows nesting', () => {
    expect(hostElementName('softn-app')).toBeNull();
    expect(hostElementName('softn-app', undefined, { frames: true })).toBeNull();
    expect(hostElementName('softn-app', undefined, { apps: true })).toBe('softn-app');
    expect(hostElementName('svg:softn-app', 'svg', { apps: true })).toBeNull();
  });

  it('names an archive among the app’s own files, never an address', async () => {
    const archive = await ContainerArchive.open({
      'index.html': '<p>x</p>',
      'widgets/clock.softn': child('clock'),
      'widgets/notes.zip': child('notes'),
      'widgets/readme.txt': 'not an app',
    });
    const context = { archive, entryPath: 'index.html' };
    expect(nestedAppSource('widgets/clock.softn', context)).toBe('/widgets/clock.softn');
    expect(nestedAppSource('/widgets/notes.zip?v=2#top', context)).toBe('/widgets/notes.zip');
    expect(nestedAppSource('./widgets/../widgets/clock.softn', context)).toBe('/widgets/clock.softn');
    for (const src of ['', 'widgets/readme.txt', 'index.html', 'widgets/missing.softn', 'https://evil.example/app.softn', '//evil.example/app.softn', 'blob:x', 'data:application/zip;base64,AAAA', 'javascript:1', '../outside.softn']) {
      expect(nestedAppSource(src, context), src).toBeNull();
    }
    const set = (name: string, value: string) => hostAttributeValue('softn-app', name, value, { ...context, permissions: {}, netGranted: false });
    expect(set('src', 'widgets/clock.softn')).toBe('/widgets/clock.softn');
    expect(set('initial-path', '/settings')).toBe('/settings');
    expect(set('initial-path', '//evil.example/')).toBeNull();
    // How a container runs is never the app's to say of the one it nests.
    for (const name of ['runtime-url', 'backend-url', 'permission-mode', 'virtual-nav', 'app-id', 'storage-prefix', 'theme', 'onload']) {
      expect(set(name, 'x'), name).toBeNull();
    }
    expect(set('class', 'widget')).toBe('widget');
    archive.dispose();
  });

  it('is allowed what the app around it declared, of what it asks for itself', () => {
    const outer: ContainerPermissions = { permissions: { net: { enabled: true, allowed_hosts: ['api.example.com'] }, camera: { enabled: true }, mic: { enabled: false } } };
    const inner: ContainerPermissions = {
      permissions: { net: { enabled: true, allowed_hosts: ['*', 'evil.example'], allow_http: true }, mic: { enabled: true }, location: { enabled: true }, files: { enabled: false } },
    };
    // The network on the outer app's terms; not the microphone it did not have, nor a place it never asked for; not the camera the inner one did not ask for.
    expect(nestedPermissions(inner, outer)).toEqual({ permissions: { net: { enabled: true, allowed_hosts: ['api.example.com'] } } });
    expect(nestedPermissions(inner, {})).toEqual({ permissions: {} });
    expect(nestedPermissions({}, outer)).toEqual({ permissions: {} });
    const sneaky = JSON.parse('{"permissions":{"__proto__":{"enabled":true},"constructor":{"enabled":true}}}') as ContainerPermissions;
    expect(nestedPermissions(sneaky, outer)).toEqual({ permissions: {} });
  });

  it('runs in a box of its own in the app’s page, and keeps its data apart from the app’s and from itself opened alone', async () => {
    const clock = child('clock');
    const { handle, said, errors } = await mount({
      'index.html': `<!DOCTYPE html><html><body>
        <softn-app id="nested" class="widget" src="widgets/clock.softn" runtime-url="https://evil.example/runtime/" permission-mode="preapproved" style="display:block;height:120px"></softn-app>
        <script>console.log('outer ran'); localStorage.setItem('who', 'outer');</script>
      </body></html>`,
      'widgets/clock.softn': clock,
    });
    await settle(250);
    expect(errors).toEqual([]);
    expect(said).toContain('log: outer ran');
    expect(said).toContain('log: clock ran');
    const box = handle.shadowRoot.getElementById('nested') as HTMLElement;
    expect(box.localName).toBe('softn-app');
    expect(box.getAttribute('src')).toBe('/widgets/clock.softn');
    expect(box.className).toBe('widget');
    expect(box.hasAttribute('runtime-url')).toBe(false);
    expect(box.hasAttribute('permission-mode')).toBe(false);
    // The nested app's page is in a root of its own: nothing of it is in the outer app's page.
    expect(handle.shadowRoot.getElementById('who')).toBeNull();

    // The outer app keeps `who` in the page's storage. The nested app keeps its own while it
    // runs and no longer: every archive an app carries would otherwise be a store of its own
    // beside the app's, each to the app's whole quota.
    const keys = Object.keys(localStorage);
    expect(keys.find((key) => localStorage.getItem(key)?.includes('outer'))).toBeDefined();
    expect(keys.find((key) => localStorage.getItem(key)?.includes('clock'))).toBeUndefined();
    expect(said).toContain('log: clock kept clock');

    // The same archive opened by itself keeps its data, as any app the person opens does.
    const alone = await mount(clock);
    await settle(150);
    const aloneKey = Object.keys(localStorage).find((key) => localStorage.getItem(key)?.includes('clock'));
    expect(aloneKey).toBeDefined();
    expect(aloneKey).not.toContain('nested');
    alone.handle.dispose();
    handle.dispose();
  });

  it('keeps no more while it runs than a share of what an app keeps', async () => {
    const big = packed({
      'index.html': `<!DOCTYPE html><html><body><script>
        var kept = 0;
        try { for (var i = 0; i < 40; i++) { localStorage.setItem('k' + i, new Array(100001).join('x')); if (localStorage.getItem('k' + i)) kept++; } } catch (e) {}
        console.log('kept ' + kept);
      </script></body></html>`,
    });
    const { handle, said } = await mount({
      'index.html': '<!DOCTYPE html><html><body><softn-app src="big.softn"></softn-app></body></html>',
      'big.softn': big,
    });
    await settle(400);
    const line = said.find((text) => text.startsWith('log: kept '));
    expect(line).toBeDefined();
    const kept = Number((line as string).replace('log: kept ', ''));
    // 100,000 characters each (200,000 bytes as counted): a megabyte is five of them, an app's own quota twenty-five.
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThanOrEqual(5);
    expect(Object.keys(localStorage).some((key) => (localStorage.getItem(key) ?? '').length >= 100000)).toBe(false);
    handle.dispose();
  });

  it('has the person asked about a file it saves in the frame of the app they opened, not in its own box', async () => {
    // The bars are in shadow roots nothing on the page reaches: kept here as each is attached.
    const roots: ShadowRoot[] = [];
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
      const made = attach.call(this, init);
      roots.push(made);
      return made;
    };
    const saved: string[] = [];
    const clickLink = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.hasAttribute('download') && this.ownerDocument === document && !this.getRootNode({ composed: false }).toString().includes('ShadowRoot')) saved.push(this.download);
    };
    try {
      const saver = packed({
        'index.html': `<!DOCTYPE html><html><body><button id="save">Save</button><script>
          document.getElementById('save').addEventListener('click', function () {
            var link = document.createElement('a');
            link.href = URL.createObjectURL(new Blob(['a,b'], { type: 'text/csv' }));
            link.download = 'invoice.csv';
            link.click();
          });
        </script></body></html>`,
      });
      const { handle } = await mount({
        // The app around it covers the nested app's box and makes it all but invisible.
        'index.html': '<!DOCTYPE html><html><body><softn-app id="nested" src="saver.softn" style="display:block;height:200px;opacity:0.01"></softn-app></body></html>',
        'saver.softn': saver,
      });
      await settle(300);
      const button = roots.map((root) => root.querySelector('#save')).find(Boolean) as HTMLElement | undefined;
      expect(button).toBeDefined();
      (button as HTMLElement).click();
      const holders = (): Element[] => roots.flatMap((root) => [...root.querySelectorAll('[data-softn-container-save]')]);
      await expect.poll(() => holders().length).toBe(1);
      // In the frame of the app the person opened, above every app's box.
      expect(holders()[0].parentNode).toBe(handle.frameRoot.querySelector('[data-softn-container-save]')?.parentNode);
      expect(handle.frameRoot.querySelector('[data-softn-container-save]')).toBe(holders()[0]);
      const box = handle.shadowRoot.getElementById('nested') as HTMLElement;
      expect(holders().some((holder) => box.contains(holder) || roots.some((root) => root.host === box && root.contains(holder)))).toBe(false);
      const bar = roots.map((root) => root.querySelector('[data-softn-save-bar]')).find(Boolean) as Element;
      expect(bar.textContent).toContain('invoice.csv');
      expect(saved).toEqual([]);
      await settle(450);
      (bar.querySelector('[data-softn-save-allow]') as HTMLElement).click();
      await settle(50);
      expect(saved).toEqual(['invoice.csv']);
      expect(holders()).toHaveLength(0);
      handle.dispose();
    } finally {
      Element.prototype.attachShadow = attach;
      HTMLAnchorElement.prototype.click = clickLink;
    }
  });

  it('is read by its own name: a name that reads as another file’s is not an archive to nest', async () => {
    const archive = await ContainerArchive.open({ 'index.html': '<p>x</p>', 'a.softn': child('a'), '%61.softn': child('other') });
    const named = (value: string) => nestedAppSource(value, { archive, entryPath: 'index.html' });
    expect(named('a.softn')).toBe('/a.softn');
    // `%2561.softn` reads as the file `%61.softn`, which read once more is `a.softn`: checked as one file, it would be run as another.
    for (const value of ['%2561.softn', '%61.softn']) {
      const got = named(value);
      expect(got === null || got === '/a.softn', `${value} → ${got}`).toBe(true);
    }
    expect(isNestedAppFile(archive, 'a.softn')).toBe(true);
    expect(isNestedAppFile(archive, '%61.softn')).toBe(false);
    expect(isNestedAppFile(archive, 'index.html')).toBe(true);
    expect(isNestedAppFile(archive, 'nowhere.softn')).toBe(false);
    archive.dispose();
  });

  it('is told to stop at once while it is still starting, and holds its place until it has gone', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const page = host.attachShadow({ mode: 'open' });
    const docRootEl = document.createElement('div');
    const viewportEl = document.createElement('div');
    docRootEl.append(viewportEl);
    page.appendChild(docRootEl);
    const names = Array.from({ length: 20 }, (_, i) => `n${i}.softn`);
    const archive = await ContainerArchive.open({ 'index.html': '<p>x</p>', ...Object.fromEntries(names.map((name) => [name, child(name)])) });
    const budget = newEmbedBudget();
    const runs: Array<{ source: string; stopped: boolean; end: () => void }> = [];
    const made = new HostDomPatcher({
      viewportEl,
      docRootEl,
      archive,
      entryPath: 'index.html',
      permissions: {},
      netGranted: false,
      embeds: { apps: true },
      embedBudget: budget,
      callbacks: {
        onEvent: () => undefined,
        onSync: () => undefined,
        // A start that takes as long as the test says: nothing has started until `end` is called.
        onNestedApp: (_box, source) => {
          let end: () => void = () => undefined;
          const ended = new Promise<void>((resolve) => {
            end = resolve;
          });
          const run = { source, stopped: false, end };
          runs.push(run);
          return {
            dispose: () => {
              run.stopped = true;
            },
            ended,
          };
        },
      },
    });
    made.nodes.set(0, docRootEl);
    made.nodes.set(1, viewportEl);

    // Eight boxes, each naming an archive: as many as a page nests.
    const ops: ShellOp[] = [];
    for (let i = 0; i < MAX_NESTED_APPS; i++) ops.push(['e', 10 + i, 'softn-app', { src: `n${i}.softn` }]);
    ops.push(['c', 1, Array.from({ length: MAX_NESTED_APPS }, (_, i) => 10 + i)]);
    made.applyOps(ops);
    expect(runs.map((run) => run.source)).toEqual(names.slice(0, MAX_NESTED_APPS).map((name) => `/${name}`));
    expect(budget.apps).toBe(MAX_NESTED_APPS);

    // Every box names another archive while the first eight are still starting. Each of those
    // is told to stop there and then. It used to be left to finish starting, script and all,
    // and was no longer counted: a page that did this on every tick had a Worker for each.
    made.applyOps(Array.from({ length: MAX_NESTED_APPS }, (_, i) => ['a', 10 + i, 'src', `n${MAX_NESTED_APPS + i}.softn`] as ShellOp));
    expect(runs.slice(0, MAX_NESTED_APPS).every((run) => run.stopped)).toBe(true);
    expect(runs).toHaveLength(MAX_NESTED_APPS);
    expect(budget.apps).toBe(MAX_NESTED_APPS);

    // As each has gone, the one that took its box's place is started.
    runs[0].end();
    runs[1].end();
    await settle(20);
    expect(runs).toHaveLength(MAX_NESTED_APPS + 2);
    expect(budget.apps).toBe(MAX_NESTED_APPS);
    expect(runs.slice(MAX_NESTED_APPS).map((run) => run.source)).toEqual([`/n${MAX_NESTED_APPS}.softn`, `/n${MAX_NESTED_APPS + 1}.softn`]);

    // The page ends: every one is told to stop, and the tree's count comes back as each goes.
    made.dispose();
    expect(runs.every((run) => run.stopped)).toBe(true);
    for (const run of runs) run.end();
    await settle(20);
    expect(budget.apps).toBe(0);
    archive.dispose();
  });

  it('is one of no more than an app nests at every depth together', async () => {
    const leaf = child('leaf');
    const eight = (label: string, inner: Uint8Array): Uint8Array =>
      child(label, { 'inner.softn': inner }, Array.from({ length: 8 }, () => '<softn-app src="inner.softn"></softn-app>').join(''));
    const { handle, said } = await mount({
      'index.html': `<!DOCTYPE html><html><body>${Array.from({ length: 8 }, () => '<softn-app src="branch.softn"></softn-app>').join('')}</body></html>`,
      // Eight apps, each nesting eight: seventy-two, by each page's own bound.
      'branch.softn': eight('branch', leaf),
    });
    await settle(2500);
    const ran = said.filter((line) => line.endsWith(' ran')).length;
    expect(ran).toBeGreaterThan(0);
    expect(ran).toBeLessThanOrEqual(MAX_TREE_NESTED_APPS);
    expect(said.some((line) => line.startsWith('warn:') && line.includes(`${MAX_TREE_NESTED_APPS} with those nested in them`))).toBe(true);
    handle.dispose();
  }, 20000);

  it('is started no more often than apps are started', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const page = host.attachShadow({ mode: 'open' });
    const docRootEl = document.createElement('div');
    const viewportEl = document.createElement('div');
    docRootEl.append(viewportEl);
    page.appendChild(docRootEl);
    const names = Array.from({ length: MAX_NESTED_STARTS + 16 }, (_, i) => `n${i}.softn`);
    const archive = await ContainerArchive.open({ 'index.html': '<p>x</p>', ...Object.fromEntries(names.map((name) => [name, child(name)])) });
    const warnings: string[] = [];
    const started: string[] = [];
    const made = new HostDomPatcher({
      viewportEl,
      docRootEl,
      archive,
      entryPath: 'index.html',
      permissions: {},
      netGranted: false,
      embeds: { apps: true },
      callbacks: {
        onEvent: () => undefined,
        onSync: () => undefined,
        onWarning: (text) => warnings.push(text),
        // An app that starts and stops at once: only how often one is started is in question.
        onNestedApp: (_box, source) => {
          started.push(source);
          let end: () => void = () => undefined;
          const ended = new Promise<void>((resolve) => {
            end = resolve;
          });
          return { dispose: () => end(), ended };
        },
      },
    });
    made.nodes.set(0, docRootEl);
    made.nodes.set(1, viewportEl);
    made.applyOps([['e', 10, 'softn-app', { src: names[0] }], ['c', 1, [10]]]);
    // The box names another archive on every tick, as a page that wanted a Worker for each would.
    for (let i = 1; i < names.length; i++) {
      made.applyOps([['a', 10, 'src', names[i]]]);
      await settle(0);
    }
    expect(started).toHaveLength(MAX_NESTED_STARTS);
    expect(warnings.some((text) => text.includes(`${MAX_NESTED_STARTS} nested apps`))).toBe(true);
    made.dispose();
    archive.dispose();
  });

  it('is started by the app’s script too, started again when its box names another archive, and ended with the app', async () => {
    const { handle, said } = await mount({
      'index.html': `<!DOCTYPE html><html><body><div id="root"></div><script>
        const box = document.createElement('softn-app');
        box.id = 'box';
        box.setAttribute('src', 'a.softn');
        document.getElementById('root').appendChild(box);
        setTimeout(() => box.setAttribute('src', 'b.softn'), 700);
      </script></body></html>`,
      'a.softn': child('first'),
      'b.softn': child('second'),
    });
    await settle(200);
    expect(said).toContain('log: first ran');
    expect(said).not.toContain('log: second ran');
    await settle(1000);
    expect(said).toContain('log: second ran');
    expect(handle.shadowRoot.getElementById('box')?.getAttribute('src')).toBe('/b.softn');
    expect(() => handle.dispose()).not.toThrow();
  });

  it('does not start what is not an archive of the app’s, and none where a host wants none', async () => {
    const page = `<!DOCTYPE html><html><body>
      <softn-app id="remote" src="https://evil.example/app.softn"></softn-app>
      <softn-app id="page" src="index.html"></softn-app>
      <softn-app id="missing" src="nowhere.softn"></softn-app>
      <softn-app id="real" src="real.softn"></softn-app>
    </body></html>`;
    const allowed = await mount({ 'index.html': page, 'real.softn': child('real') });
    await settle(250);
    for (const id of ['remote', 'page', 'missing']) expect(allowed.handle.shadowRoot.getElementById(id)?.hasAttribute('src'), id).toBe(false);
    expect(allowed.said.filter((line) => line.endsWith(' ran'))).toEqual(['log: real ran']);
    allowed.handle.dispose();

    const denied = await mount({ 'index.html': page, 'real.softn': child('real') }, { nestedApps: 'deny' });
    await settle(250);
    expect(denied.handle.shadowRoot.querySelector('softn-app')).toBeNull();
    expect(denied.said.filter((line) => line.endsWith(' ran'))).toEqual([]);
    denied.handle.dispose();
  });

  it('nests apps of its own, three deep and no deeper', async () => {
    const level = (n: number, inner?: Uint8Array): Uint8Array =>
      child(`level ${n}`, inner ? { 'inner.softn': inner } : {}, inner ? '<softn-app src="inner.softn"></softn-app>' : '');
    const four = level(4);
    const three = level(3, four);
    const two = level(2, three);
    const one = level(1, two);
    const { handle, said } = await mount({
      'index.html': '<!DOCTYPE html><html><body><softn-app src="one.softn"></softn-app></body></html>',
      'one.softn': one,
    });
    await settle(900);
    const ran = said.filter((line) => line.endsWith(' ran')).sort();
    expect(ran).toEqual(['log: level 1 ran', 'log: level 2 ran', 'log: level 3 ran']);
    handle.dispose();
  });
});
