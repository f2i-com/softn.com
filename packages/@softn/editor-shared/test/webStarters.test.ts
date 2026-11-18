import { describe, expect, it, vi } from 'vitest';
import { COMPONENT_STARTERS, WEB_STARTERS, createWebStarter } from '../src/webStarters';

describe('editable web starters', () => {
  for (const { id, name } of WEB_STARTERS) {
    it(`${id} writes a self-contained project using its own local dependencies`, async () => {
      const files = new Map((await createWebStarter(id)).map((file) => [file.path, file.content]));
      const manifest = JSON.parse(files.get('manifest.json')!);
      expect(manifest).toMatchObject({ engine: 2, main: 'index.html', name });
      const declared = [...manifest.files.ui, ...manifest.files.logic, ...manifest.files.assets];
      expect([...declared, 'manifest.json', 'permission.json'].sort()).toEqual([...files.keys()].sort());
      expect(JSON.parse(files.get('permission.json')!)).toEqual({ permissions: {} });
      expect(files.get(manifest.icon)).toContain('<svg');
      expect(files.get('index.html')).toContain('src="./app.js"');
      expect(files.get('styles.css')).toBeTruthy();
      const vendorPath = `vendor/${id}.js`;
      if (id === 'vanilla') {
        expect(files.has(vendorPath)).toBe(false);
      } else {
        expect(files.get('app.js')).toContain(`from './${vendorPath}'`);
        expect(files.get(vendorPath)).toContain('Permission is hereby granted');
        expect(files.get(vendorPath)).toMatch(/\bexport\s*\{/);
      }
    });
  }

  for (const [framework, starter] of Object.entries(COMPONENT_STARTERS)) {
    it(`${starter.label} stores the editable component and resolves framework imports locally`, async () => {
      const files = new Map((await createWebStarter(starter.id)).map(({ path, content }) => [path, content]));
      const html = new DOMParser().parseFromString(files.get('index.html')!, 'text/html');
      const imports = JSON.parse(html.querySelector('script[type=importmap]')!.textContent!).imports;
      const vendor = files.get(`vendor/${framework}.js`)!;
      expect(imports[framework]).toBe(`/vendor/${framework}.js`);
      const declared = Object.values<string[]>(JSON.parse(files.get('manifest.json')!).files).flat();
      expect([...declared, 'manifest.json', 'permission.json'].sort()).toEqual([...files.keys()].sort());
      expect(vendor).toContain('Permission is hereby granted');
      const original = files.get(starter.sourceFile)!;
      if (starter.id === 'react-jsx') {
        expect(imports['react-dom/client']).toBe('/vendor/react.js');
        expect(html.querySelector('script[type=module]')?.getAttribute('src')).toBe('./App.jsx');
        expect(original).toContain('render(<PracticeCounter />)');
        expect(vendor).toMatch(/\bas useState\b/);
      } else {
        expect(files.get('app.js')).toContain("import App from './App.vue'");
        expect(original).toContain('<script setup>');
        expect(original).toContain('<style scoped>');
        expect(vendor).toMatch(/\bas createElementBlock\b/);
      }
    });
  }

  it('keeps a custom project name and description as text in the HTML and manifest', async () => {
    const name = 'A & B <friends>';
    const description = 'Look at <this> & that';
    const files = new Map((await createWebStarter('react', { name, description, theme: 'dark' })).map((file) => [file.path, file.content]));
    expect(JSON.parse(files.get('manifest.json')!)).toMatchObject({ name, description, config: { theme: { mode: 'dark' } } });
    const html = new DOMParser().parseFromString(files.get('index.html')!, 'text/html');
    expect(html.querySelector('h1')?.textContent).toBe(name);
    expect(html.querySelector('header p')?.textContent).toBe(description);
    expect(html.title).toBe(name);
  });

  it('explains missing starter downloads and preserves other errors', async () => {
    const build = vi.spyOn(await import('../src/starters/buildStarter'), 'buildStarter');
    try {
      for (const message of ['Failed to fetch dynamically imported module: /app.js', 'error loading dynamically imported module: /app.js', 'Importing a module script failed.']) {
        const cause = new TypeError(message);
        build.mockRejectedValueOnce(cause);
        await expect(createWebStarter('vue')).rejects.toMatchObject({ message: expect.stringContaining('reload the editor while online'), cause });
      }
      const cause = new Error('Unknown project field');
      build.mockRejectedValueOnce(cause);
      await expect(createWebStarter('vue')).rejects.toBe(cause);
    } finally {
      build.mockRestore();
    }
  });
});
