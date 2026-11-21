/**
 * What the app's side of the container does that the page does not see directly: it stops
 * when the app is not on screen, and it reads the app's own files.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountSoftNContainer } from '../src/index';
import { ContainerArchive } from '../src/archive';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LITE_WASM = path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-javascript-lite.wasm');

function settle(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mount(source: Record<string, string | Uint8Array>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const handle = await mountSoftNContainer(host, { isolation: 'inline', engineWasm: { lite: LITE_WASM }, permissionMode: 'deny', source });
  await settle();
  const number = (id: string): number => Number(handle.shadowRoot.querySelector(`#${id}`)?.textContent);
  return { handle, number };
}

describe('hosted page navigation', () => {
  it('waits for a startup redirect and tells its host which HTML file actually opened', async () => {
    const pages: string[] = [];
    const handle = await mountSoftNContainer(document.createElement('div'), {
      isolation: 'inline', engineWasm: { lite: LITE_WASM },
      source: {
        'index.html': '<p>Home</p>',
        'start.html': '<script>location.href = "pages/dashboard.html";</script>',
        'pages/dashboard.html': '<main id="dashboard">Dashboard</main>',
      },
      initialPage: 'start.html',
      onPageChange: path => pages.push(path),
    });
    try {
      expect(handle.shadowRoot.querySelector('#dashboard')?.textContent).toBe('Dashboard');
      expect(pages).toEqual(['pages/dashboard.html']);
      await handle.navigate('index.html');
      expect(pages).toEqual(['pages/dashboard.html', 'index.html']);
    } finally { handle.dispose(); }
  });
});

describe('HTML event attributes', () => {
  it('installs nested handlers in the guest before the first app script runs', async () => {
    const { handle, number } = await mount({
      'index.html': `<!doctype html><main><section><button id="add" onclick="this.textContent = String(Number(this.textContent) + 1)">0</button></section></main>
        <script>document.getElementById('add').click();</script>`,
    });
    try {
      const button = handle.shadowRoot.querySelector<HTMLButtonElement>('#add')!;
      expect(button.hasAttribute('onclick')).toBe(false);
      expect(number('add')).toBe(1);
      button.click();
      await settle();
      expect(number('add')).toBe(2);
    } finally {
      handle.dispose();
    }
  });
});

describe('an app that is not on screen', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('runs no timers and draws no frames until it is shown again', async () => {
    const { handle, number } = await mount({
      'index.html': `<!doctype html><html><body><p id="ticks">0</p><p id="frames">0</p><script>
        var ticks = 0, frames = 0;
        setInterval(function () { ticks += 1; document.getElementById('ticks').textContent = String(ticks); }, 10);
        function frame() { frames += 1; document.getElementById('frames').textContent = String(frames); requestAnimationFrame(frame); }
        requestAnimationFrame(frame);
      </script></body></html>`,
    });
    await settle(150);
    expect(number('ticks')).toBeGreaterThan(2);
    expect(number('frames')).toBeGreaterThan(2);

    // Behind another tab: a timer that was already due may run once more, and then nothing.
    handle.setActive(false);
    await settle(60);
    const ticks = number('ticks');
    const frames = number('frames');
    await settle(300);
    expect(number('ticks')).toBe(ticks);
    expect(number('frames')).toBe(frames);

    // In front again: the timer that came due runs, once, and both go on from there.
    handle.setActive(true);
    await settle(150);
    expect(number('ticks')).toBeGreaterThan(ticks + 2);
    expect(number('frames')).toBeGreaterThan(frames + 2);
    // Thirty ticks' worth of time passed unseen; they were not all run on the way back.
    expect(number('ticks')).toBeLessThan(ticks + 25);
    handle.dispose();
  });

  it('says so again to the app’s next page, and a timer cleared meanwhile does not run', async () => {
    const { handle, number } = await mount({
      'index.html': `<!doctype html><html><body><p id="ran">0</p><script>
        var once = setTimeout(function () { document.getElementById('ran').textContent = '1'; }, 40);
        setTimeout(function () { clearTimeout(once); }, 0);
      </script></body></html>`,
      'second.html': `<!doctype html><html><body><p id="ticks">0</p><script>
        var ticks = 0;
        setInterval(function () { ticks += 1; document.getElementById('ticks').textContent = String(ticks); }, 10);
      </script></body></html>`,
    });
    await settle(120);
    expect(number('ran')).toBe(0);
    handle.setActive(false);
    // Asked twice, it is still one state.
    handle.setActive(false);
    await handle.navigate('second.html');
    await settle(200);
    // The new page's script ran (its timers are set), and none of them fired: it started as the last page was left.
    expect(number('ticks')).toBeLessThanOrEqual(1);
    handle.setActive(true);
    await settle(120);
    expect(number('ticks')).toBeGreaterThan(2);
    handle.dispose();
  });
});

describe('what an app prints', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  // The engine gives each line with the stream it was written to. The container read a
  // `level` the engine never gave, so every line reached the host as a plain log.
  it('reaches the host at the level it was printed at: an error as an error, a warning as a warning', async () => {
    const lines: string[] = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      engineWasm: { lite: LITE_WASM },
      permissionMode: 'deny',
      onConsole: (level, text) => lines.push(`${level}: ${text}`),
      source: {
        'index.html': `<!doctype html><html><body><script>
          console.log('started');
          console.info('for information');
          console.warn('deprecated', 'thing');
          console.error('failed to load', 42);
          setTimeout(function () { console.error('later failure'); console.warn('later warning'); }, 20);
          Promise.reject(new Error('lost')).then(undefined, function (e) { console.error('caught: ' + e.message); });
        </script></body></html>`,
      },
    });
    await settle(150);
    expect(lines).toEqual([
      'log: started',
      'log: for information',
      'warn: deprecated thing',
      'error: failed to load 42',
      'error: caught: lost',
      'error: later failure',
      'warn: later warning',
    ]);
    handle.dispose();
  });

  it('says a script that does not start as an error', async () => {
    const lines: string[] = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      engineWasm: { lite: LITE_WASM },
      permissionMode: 'deny',
      onConsole: (level, text) => lines.push(`${level}: ${text}`),
      source: { 'index.html': `<!doctype html><html><body><script>throw new Error('boom at start');</script></body></html>` },
    });
    await settle(100);
    expect(lines.some((line) => /^error: \[SoftN\] Script startup error:.*boom at start/.test(line)), JSON.stringify(lines)).toBe(true);
    handle.dispose();
  });
});

describe('the app’s own files, as its script reads them', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('are handed over as bytes, and read out by a script that asks for one', async () => {
    const data = new Uint8Array(256).map((_, i) => i);
    const archive = await ContainerArchive.open({ 'index.html': '<!doctype html><p>x</p>', 'data.bin': data, 'notes.txt': 'hello' });
    const vfs = archive.exportWorkerVfs();
    // Text as text; everything else as its bytes, not as base64 written out for every page.
    expect(vfs.textFiles['notes.txt']).toBe('hello');
    expect(vfs.binaryFiles['data.bin']).toBeInstanceOf(Uint8Array);
    expect([...vfs.binaryFiles['data.bin']]).toEqual([...data]);
    expect((vfs as unknown as Record<string, unknown>).binaryFilesBase64).toBeUndefined();
    // A name that is a property of every object is not a file.
    expect('constructor' in vfs.textFiles).toBe(false);
    expect('constructor' in vfs.binaryFiles).toBe(false);
    archive.dispose();

    const { handle } = await mount({
      'index.html': `<!doctype html><html><body><pre id="o">…</pre><script type="module">
        const out = [];
        const bin = await fetch('./data.bin');
        const bytes = new Uint8Array(await bin.arrayBuffer());
        out.push(bin.status, bytes.length, bytes[0], bytes[255]);
        out.push(await (await fetch('./notes.txt')).text());
        // Not files of the app's, though every object has properties by these names.
        out.push((await fetch('./constructor')).status, (await fetch('./__proto__')).status, (await fetch('./toString')).status);
        document.getElementById('o').textContent = out.join('|');
      </script></body></html>`,
      'data.bin': data,
      'notes.txt': 'hello',
    });
    await settle(200);
    expect(handle.shadowRoot.querySelector('#o')?.textContent).toBe('200|256|0|255|hello|404|404|404');
    handle.dispose();
  });
});
