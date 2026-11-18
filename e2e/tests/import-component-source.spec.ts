import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { containerBundle } from '../helpers/bundle';
import { clickIn, keepShadowRoots, openBundle, seeIn, textIn } from '../helpers/container';
import { BUILDER_EXPORT_DIALOG } from '../helpers/editors';

// These are ordinary source projects. Their .js entry imports a component, which
// imports another component. No manifest, import map or framework vendor is supplied.
const html = '<!doctype html><title>Reading notes</title><div id="app"></div><script type="module" src="./src/boot.js"></script>';
const projects: { editor: string; framework: string; files: Record<string, string> }[] = [
  {
    editor: 'builder', framework: 'react',
    files: {
      'index.html': html,
      'src/boot.js': "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\ncreateRoot(document.getElementById('app')).render(React.createElement(App));",
      'src/App.jsx': "import Counter from './parts/Counter.jsx';\nexport default function App() { return <main><h1>Reading notes</h1><Counter /></main>; }",
      'src/parts/Counter.jsx': `import { useState } from 'react';
export default function Counter() {
  const [count, setCount] = useState(2);
  return <><output id="count">{count}</output><button id="add" onClick={() => setCount(count + 3)}>Add notes</button></>;
}`,
    },
  },
  {
    editor: 'studio', framework: 'vue',
    files: {
      'index.html': html,
      'src/boot.js': "import { createApp } from 'vue';\nimport App from './App.vue';\ncreateApp(App).mount('#app');",
      'src/App.vue': '<script setup>\nimport Counter from "./parts/Counter.vue";\n</script>\n<template><main><h1>Reading notes</h1><Counter /></main></template>',
      'src/parts/Counter.vue': `<script setup>
import { ref } from 'vue';
const count = ref(2);
</script>
<template>
  <output id="count" :class="{ marked: count > 2 }">{{ count }}</output>
  <button id="add" @click="count += 3">Add notes</button>
</template>
<style scoped>.marked { color: rgb(96, 44, 137); }</style>`,
    },
  },
];

async function useCounter(page: Page, framework: string) {
  await expect.poll(() => textIn(page, '#count'), { timeout: 60_000 }).toBe('2');
  await clickIn(page, '#add');
  await expect.poll(() => textIn(page, '#count')).toBe('5');
  if (framework === 'vue') {
    await expect.poll(() => seeIn(page, '#count').then(el => el?.color)).toBe('rgb(96, 44, 137)');
  }
}

for (const { editor, framework, files } of projects) {
  test(`${editor} imports a nested ${framework} source project and exports it for Runtime`, async ({ page, browser, baseURL }, info) => {
    test.setTimeout(120_000);
    const archive = containerBundle(files);
    await keepShadowRoots(page);
    await page.goto(`/${editor}/`);
    if (editor === 'studio') await page.getByRole('button', { name: 'Explore examples without AI' }).click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: editor === 'builder' ? 'Open' : 'Import a bundle', exact: true }).click(),
    ]);
    await chooser.setFiles({ name: `Original-${framework}.zip`, mimeType: 'application/zip', buffer: archive });
    // Builder opens imported web app files in Code. Switch to their running preview.
    if (editor === 'builder') {
      await expect(page.getByRole('tab', { name: /index\.html/ })).toBeVisible();
      await page.getByRole('button', { name: 'Preview', exact: true }).click();
    }
    await useCounter(page, framework);

    if (editor === 'builder') await page.getByRole('button', { name: 'Export', exact: true }).click();
    const exportButton = editor === 'studio' ? page.getByRole('button', { name: 'Export bundle', exact: true })
      : page.getByRole('dialog', { name: BUILDER_EXPORT_DIALOG }).getByRole('button', { name: 'Export .softn', exact: true });
    const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
    const file = info.outputPath('original-source.softn');
    await download.saveAs(file);
    const bytes = await readFile(file);
    const exported = unzipSync(new Uint8Array(bytes));
    for (const [path, source] of Object.entries(files)) {
      expect(Buffer.from(exported[path]).toString('utf8'), path).toBe(source);
      if (/\.(jsx|vue)$/.test(path)) expect(exported['__softn_generated__/' + path + '.js']?.length).toBeGreaterThan(0);
    }
    expect(Object.keys(exported).filter(path => path.startsWith('__softn_generated__/vendor/')))
      .toEqual([`__softn_generated__/vendor/${framework}.js`]);

    const recipient = await browser.newContext({ baseURL });
    try {
      const runtime = await recipient.newPage();
      await keepShadowRoots(runtime);
      await openBundle(runtime, download.suggestedFilename(), bytes);
      await useCounter(runtime, framework);
    } finally {
      await recipient.close();
    }
  });
}
