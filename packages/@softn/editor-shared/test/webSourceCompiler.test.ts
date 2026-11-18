import { afterEach, expect, it, vi } from 'vitest';
import { checkSourceModules, compiledSourcePath, GENERATED_SOURCE_HEADER, generatedFrameworkPath } from '@softn/bundle-format/source-modules';
import { prepareWebSourceFiles } from '../src/webSourceCompiler';
import { keepSourceCompiler } from '../src/keepSourceCompiler';

vi.mock('../src/keepSourceCompiler', () => ({ keepSourceCompiler: vi.fn(async () => {}) }));
afterEach(() => vi.clearAllMocks());

it('keeps private component source out of generated browser modules, including stale copies from earlier exports', async () => {
  const files = new Map([
    ['private/Inventory.vue', '<template>Internal inventory</template>'],
    ['Server/Internal.jsx', 'export const Internal = () => <i>Internal</i>;'],
    ['__softn_generated__/Server/Internal.jsx.js', GENERATED_SOURCE_HEADER + 'old generated copy'],
  ]);
  expect([...(await prepareWebSourceFiles(files)).keys()]).toEqual(['private/Inventory.vue', 'Server/Internal.jsx']);
  expect(keepSourceCompiler).not.toHaveBeenCalled();
});

it('leaves plain projects alone and removes stale generated modules after a source is deleted', async () => {
  const files = new Map([
    ['index.html', '<script src="app.js"></script>'],
    ['app.js', 'let count = 1;'],
    [compiledSourcePath('Gone.vue')!, GENERATED_SOURCE_HEADER + 'obsolete'],
    [generatedFrameworkPath('vue'), GENERATED_SOURCE_HEADER + 'old library'],
    ['__softn_generated__/notes.txt', 'written by the author'],
  ]);
  const output = await prepareWebSourceFiles(files);
  expect([...output.keys()]).toEqual(['index.html', 'app.js', '__softn_generated__/notes.txt']);
  expect(keepSourceCompiler).not.toHaveBeenCalled();
  expect(files.size).toBe(5);
});

it('compiles nested JSX, fragments and local imports without evaluating or changing the original module', async () => {
  const path = 'src/List.jsx';
  const source = "import Row from './Row.jsx';\nexport default () => <><Row label={'hello'} /></>;";
  const files = new Map([[path, source], ['src/Row.jsx', 'export default ({label}) => <p>{label}</p>;'], ['vendor/react.js', '']]);
  const output = await prepareWebSourceFiles(files);
  const js = output.get(compiledSourcePath(path)!)!;
  expect(js).toContain(GENERATED_SOURCE_HEADER);
  expect(js).toContain('.createElement(');
  expect(js).toContain('.Fragment');
  expect(js).toContain("'./Row.jsx'");
  expect(js).not.toContain('<Row');
  expect(output.get(path)).toBe(source);
  expect(output.has(generatedFrameworkPath('react'))).toBe(false);
  expect(keepSourceCompiler).toHaveBeenCalledExactlyOnceWith('jsx');
});

it.each(['Title.vue', 'Title.jsx'])('detects an edited component beside its old generated module in %s', async path => {
  const source = path.endsWith('.vue') ? '\uFEFF<template>Été</template>' : '\uFEFFexport default () => <p>Été</p>;';
  const prepared = await prepareWebSourceFiles(new Map([[path, source]]));
  await expect(checkSourceModules(prepared)).resolves.toBeUndefined();
  prepared.set(path, source.slice(1));
  await expect(checkSourceModules(prepared)).resolves.toBeUndefined();
  prepared.set(path, source.replace('Été', 'Hiver'));
  await expect(checkSourceModules(prepared)).rejects.toThrow(path + ' has changed');
});

it('previews immediately while the worker is still installing offline tooling', async () => {
  vi.mocked(keepSourceCompiler).mockReturnValueOnce(new Promise<void>(() => {}));
  const files = new Map([['App.jsx', 'export default () => <i/>;'], ['vendor/react.js', '']]);
  const output = await prepareWebSourceFiles(files);
  expect(output.get(compiledSourcePath('App.jsx')!)).toContain('.createElement(');
});

it('compiles Vue script setup, nested components and scoped CSS without loading JSX tools', async () => {
  const path = 'views/Reading.vue';
  const source = `<script setup>
import { ref } from 'vue'
import Book from './Book.vue'
const count = ref(1)
</script>
<template><Book @click="count++" :count="count" /></template>
<style scoped>.page { color: seagreen }</style>`;
  const output = await prepareWebSourceFiles(new Map([[path, source], ['vendor/vue.js', '']]));
  const js = output.get(compiledSourcePath(path)!)!;
  expect(js).toContain("import Book from './Book.vue'");
  expect(js).toContain('from "vue"');
  expect(js).toContain('count.value');
  expect(js).toMatch(/\.page\[data-v-[a-f0-9]+\]/);
  expect(js).toContain('__scopeId');
  expect(output.get(path)).toBe(source);
  expect(output.has(generatedFrameworkPath('vue'))).toBe(false);
  expect(keepSourceCompiler).toHaveBeenCalledExactlyOnceWith('vue');
});

it('renders a template-only or Options API component and keeps its asset URLs relative to the source', async () => {
  const files = new Map([
    ['views/Card.vue', '<template><img src="./cover.jpg"><b>Card</b></template>'],
    ['views/List.vue', '<script>export default { data() { return { name: "Hello" } } }</script><template><p>{{ name }}</p></template>'],
  ]);
  const output = await prepareWebSourceFiles(files);
  expect(output.get(compiledSourcePath('views/Card.vue')!)).toContain('/views/cover.jpg');
  expect(output.get(compiledSourcePath('views/List.vue')!)).toContain('.render =');
  expect(output.get(generatedFrameworkPath('vue'))).toContain('Permission is hereby granted');
  expect(output.has(generatedFrameworkPath('react'))).toBe(false);
});

it('reports the filename for invalid syntax, unsupported blocks and a conflicting user file', async () => {
  await expect(prepareWebSourceFiles(new Map([['src/Count.jsx', 'export default () => <b>unfinished']]))).rejects.toThrow(/src\/Count.jsx/);
  await expect(prepareWebSourceFiles(new Map([['src/Count.vue', '<template><button></template>']]))).rejects.toThrow(/src\/Count.vue/);
  await expect(prepareWebSourceFiles(new Map([['src/Count.vue', '<style lang="scss">div { color: red }</style><template><b/></template>']]))).rejects.toThrow(/lang="css"/);
  const collision = new Map([['Card.vue', '<template><i/></template>'], [compiledSourcePath('Card.vue')!, 'authored JS']]);
  await expect(prepareWebSourceFiles(collision)).rejects.toThrow(/Rename/);
  expect(collision.get(compiledSourcePath('Card.vue')!)).toBe('authored JS');
  const vendorPath = generatedFrameworkPath('react');
  await expect(prepareWebSourceFiles(new Map([[vendorPath, 'user data'], ['src/App.jsx', 'export default () => <p/>']]))).rejects.toThrow(/Rename/);
});

it('honors custom framework imports on every page and keeps the React DOM fallback for partial mappings', async () => {
  const files = new Map([
    ['manifest.json', JSON.stringify({ imports: { react: '/lib/react.js' } })],
    ['index.html', '<script type="importmap">{"imports":{"react-dom/":"/lib/dom/"}}</script>'],
    ['src/App.jsx', 'export default () => <p>hello</p>'],
  ]);
  const vendor = generatedFrameworkPath('react');
  expect((await prepareWebSourceFiles(files)).has(vendor)).toBe(false);
  files.set('other.html', '<h1>Home</h1>');
  expect((await prepareWebSourceFiles(files)).get(vendor)).toContain(GENERATED_SOURCE_HEADER);
});
