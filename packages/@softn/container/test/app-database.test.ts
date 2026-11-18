import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { mountSoftNContainer, type SoftNContainerOptions } from '../src/index';
import { ContainerArchive } from '../src/archive';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lite = path.join(pkg, 'dist/runtime/engines/zipp-javascript-lite.wasm');

const programs = {
  vanilla: `
    function render() { document.getElementById('list').textContent = titles(); }
    const stop = db.subscribe('notes', render);
    db.subscribe('notes', () => { document.getElementById('writes').textContent = titles(); });
    render();
    document.getElementById('stop').onclick = stop;
  `,
  react: `
    import { createElement, createRoot, useSyncExternalStore } from 'react';
    const subscribe = (notify) => db.subscribe('notes', notify);
    function NoteList() {
      return createElement('span', null, useSyncExternalStore(subscribe, titles));
    }
    createRoot(document.getElementById('list')).render(createElement(NoteList));
  `,
  vue: `
    import { createApp, h, ref, onUnmounted } from 'vue';
    createApp({ setup() {
      const result = ref(titles());
      onUnmounted(db.subscribe('notes', () => { result.value = titles(); }));
      return () => h('span', result.value);
    } }).mount('#list');
  `,
};

const handles: Awaited<ReturnType<typeof mountSoftNContainer>>[] = [];
async function open(source: SoftNContainerOptions['source'], options: Partial<SoftNContainerOptions> = {}) {
  const handle = await mountSoftNContainer(document.createElement('div'), {
    source, isolation: 'inline', permissionMode: 'deny', engineWasm: { lite }, ...options,
  });
  handles.push(handle);
  return handle;
}

afterEach(() => {
  for (const handle of handles.splice(0)) handle.dispose();
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe('app databases and hosted API routes on the lite engine', () => {
  for (const framework of ['vanilla', 'react', 'vue'] as const) {
    it(`${framework} observes local CRUD and reopens its saved collection offline`, async () => {
      const network = vi.fn(() => Promise.reject(new Error('Offline')));
      vi.stubGlobal('fetch', network);
      const libraries: Record<string, string> = {};
      if (framework === 'react') {
        libraries['vendor/react.js'] = (await import('virtual:softn-starter/react')).default;
      } else if (framework === 'vue') {
        libraries['vendor/vue.js'] = (await import('virtual:softn-starter/vue')).default;
      }
      const source = {
        ...libraries,
        'index.html': '<div id="list"></div><div id="writes"></div><button id="write">Write</button><button id="stop">Stop</button>' +
          '<script type="module" src="app.js"></script>',
        'notes.xdb': JSON.stringify({collection: 'notes', records: [{id: 'seed', data: {title: 'Seed', open: true}}]}),
        'app.js': `
          import { db } from 'softn:db';
          const titles = () => db.query('notes', {open: true}).map(row => row.data.title).join(', ');
          ${programs[framework]}
          document.getElementById('write').onclick = () => {
            const row = db.create('notes', {title: 'Draft', open: true});
            db.update(row.id, {title: 'Saved'});
            db.create('notes', {title: 'Hidden', open: false});
            db.hardDelete('notes', 'seed');
          };
        `,
      };
      const options = { appId: framework, storage: sessionStorage };
      const handle = await open(source, options);
      const titles = () => handle.shadowRoot.querySelector('#list')?.textContent;
      expect(handle.engineTier).toBe('lite');
      await expect.poll(titles).toBe('Seed');
      handle.shadowRoot.querySelector<HTMLButtonElement>('#write')!.click();
      await expect.poll(titles).toBe('Saved');
      expect(localStorage.length).toBe(0);
      handle.dispose();
      const reopened = await open(source, options);
      await expect.poll(() => reopened.shadowRoot.querySelector('#list')?.textContent).toBe('Saved');

      if (framework === 'vanilla') {
        reopened.shadowRoot.querySelector<HTMLButtonElement>('#stop')!.click();
        reopened.shadowRoot.querySelector<HTMLButtonElement>('#write')!.click();
        await expect.poll(() => JSON.parse(sessionStorage.getItem('softn-v2:vanilla:db')!).notes.length).toBe(4);
        await expect.poll(() => reopened.shadowRoot.querySelector('#writes')?.textContent).toBe('Saved, Saved');
        expect(reopened.shadowRoot.querySelector('#list')?.textContent).toBe('Saved');
        const other = await open(source, { appId: 'other', storage: sessionStorage });
        await expect.poll(() => other.shadowRoot.querySelector('#list')?.textContent).toBe('Seed');
      }
      expect(network).not.toHaveBeenCalled();
    });
  }

  it('keeps a small user edit when another seeded collection is larger than the storage quota', async () => {
    const app = await open({
      'index.html': '<output></output><script>db.create("notes", {title: "Saved"}); document.querySelector("output").textContent = db.query("notes")[0].data.title;</script>',
      'catalog.xdb': JSON.stringify([{ id: 'bundled', description: 'x'.repeat(20_000) }]),
    }, { appId: 'catalog', limits: { storageQuotaBytes: 3000 } });
    await expect.poll(() => app.shadowRoot.querySelector('output')?.textContent).toBe('Saved');
    expect(Object.keys(JSON.parse(localStorage.getItem('softn-v2:catalog:db')!))).toEqual(['notes']);
  });

  it('uses an app-scoped host callback for named actions and JSON routes', async () => {
    const backendCall = vi.fn(async (action, input) => action === 'nativeRequest'
      ? { result: { status: 201, body: { title: input.options.body.title } } }
      : { result: action });
    const source = {
      'index.html': '<output id="result"></output><script type="module" src="app.js"></script>',
      'app.js': `
        import { backend } from 'softn:backend';
        import { api } from 'softn:api';
        const output = document.getElementById('result');
        const reply = await backend.call('listNotes', {});
        if (reply.error) output.textContent = reply.error;
        else {
          const response = await api.fetch('/api/notes', {
            method: 'post', headers: {'Content-Type':'application/json'}, body: JSON.stringify({title:'New note'})
          });
          output.textContent = [reply.result, response.status, (await response.json()).title].join(' ');
        }
      `,
    };
    const app = await open(source, { backendCall });
    await expect.poll(() => app.shadowRoot.querySelector('output')?.textContent).toBe('listNotes 201 New note');
    expect(backendCall.mock.calls[1]).toEqual(['nativeRequest', {
      url: '/api/notes', options: { method: 'POST', headers: { 'content-type': 'application/json' }, body: { title: 'New note' } },
    }]);
    const offline = await open(source);
    await expect.poll(() => offline.shadowRoot.querySelector('output')?.textContent).toBe('This app has no connected backend.');
  });

  it('drops late backend replies and database writes after the host switches apps', async () => {
    const element = document.createElement('div');
    let finish!: (reply: unknown) => void;
    const first = await mountSoftNContainer(element, {
      appId: 'first', isolation: 'inline', engineWasm: { lite }, storage: sessionStorage,
      backendCall: () => new Promise(resolve => { finish = resolve; }),
      source: {
        'index.html': '<script type="module" src="app.js"></script>',
        'app.js': `
          import { db } from 'softn:db';
          import { backend } from 'softn:backend';
          const answer = await backend.call('load', {});
          db.create('notes', answer);
        `,
      },
    });
    handles.push(first);
    await expect.poll(() => typeof finish).toBe('function');
    const second = await mountSoftNContainer(element, {
      appId: 'second', isolation: 'inline', engineWasm: { lite }, storage: sessionStorage,
      source: { 'index.html': '<script>db.create("notes", {title: "Second"});</script>' },
    });
    handles.push(second);
    finish({ result: 'belongs to first' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(sessionStorage.getItem('softn-v2:first:db')).toBeNull();
    expect(JSON.parse(sessionStorage.getItem('softn-v2:second:db')!).notes).toHaveLength(1);
  });

  it.each(['files', 'archive'])('only mounts the client projection of owner %s', async (format) => {
    const manifest = { name: 'Notebook', main: 'index.html', server: { entry: 'server/main.logic' } };
    const files = {
      'manifest.json': JSON.stringify(manifest), 'index.html': '<main>Notebook</main>',
      'server/main.logic': 'handler', 'backend/data.xdb': 'private records',
      '__softn_generated__/backend/Panel.vue.js': 'private compiled module',
      'private/key.bin': 'private data', 'assets/migration.sql': 'schema', 'assets/logo.png': 'logo',
    };
    const source = format === 'files' ? files : zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
    const archive = await ContainerArchive.open(source);
    try {
      expect(archive.names().sort()).toEqual(['assets/logo.png', 'index.html', 'manifest.json']);
      expect(archive.manifest.raw).toEqual({ name: 'Notebook', main: 'index.html' });
      expect(JSON.parse(archive.exportWorkerVfs().textFiles['manifest.json'])).toEqual(archive.manifest.raw);
      expect(archive.readBytes('server/main.logic')).toBeNull();
    } finally {
      archive.dispose();
    }
    expect(JSON.parse(files['manifest.json']).server).toEqual(manifest.server);
  });
});
