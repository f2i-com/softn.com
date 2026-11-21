import { componentGroupChunks, featureChunks } from './on-demand-chunks.mjs';

const editorShared = '../../packages/@softn/editor-shared/src/';
const dispatch = editorShared + 'webSourceCompiler.ts';
const sourceCompilerRoots = {
  jsx: [dispatch, editorShared + 'sourceCompilers/jsx.ts'],
  vue: [dispatch, editorShared + 'sourceCompilers/vue.ts', 'virtual:softn-starter/vue-sfc'],
};

function filesFrom(manifest, roots) {
  const files = new Set();
  const visited = new Set();
  function visit(key) {
    if (visited.has(key)) return;
    visited.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new Error(`Missing chunk in the Vite manifest: ${key}`);
    files.add(chunk.file);
    for (const css of chunk.css ?? []) files.add(css);
    for (const dependency of chunk.imports ?? []) visit(dependency);
  }
  for (const key of roots) visit(key);
  return files;
}

/** Plain projects still need any helpers their own entries share with a source compiler. */
export function sourceCompilerAssets(manifest, classicGroups) {
  const toolRoots = new Set(Object.values(sourceCompilerRoots).flat());
  const ordinaryRoots = Object.keys(manifest).filter((key) =>
    !toolRoots.has(key) && (manifest[key].isEntry || manifest[key].isDynamicEntry));
  const precached = filesFrom(manifest, ordinaryRoots);
  for (const file of Object.values(classicGroups).flat()) precached.delete(file);
  return Object.fromEntries(Object.entries(sourceCompilerRoots).map(([format, roots]) =>
    [format, [...filesFrom(manifest, roots)].filter(file => !precached.has(file)).sort()]));
}

/** Include hashed helpers and CSS split out by Vite, even if their names change on the next build. */
export function classicAssetGroups(manifest, classicRoots, sharedRoots = [], runtime = false) {
  // A helper imported by both a classic preview and a web source compiler
  // belongs in the editor shell so either project can use it offline.
  const compilerRoots = Object.values(sourceCompilerRoots).flat().filter(key => manifest[key]);
  const shared = filesFrom(manifest, ['index.html', ...sharedRoots, ...compilerRoots]);
  const unique = (roots) => [...filesFrom(manifest, roots)].filter((file) => !shared.has(file)).sort();
  const groups = { renderer: unique(classicRoots) };
  if (runtime) {
    const keys = Object.keys(manifest);
    // The classic renderer asks for these later, e.g. CSS scoping when a document
    // contributes styles and the guest document APIs when a page runs a script.
    const core = (name) => keys.filter((key) => key.includes('/core/dist/') && name.test(key.split('/').pop()));
    groups.renderer = unique([...classicRoots, ...core(/^(scope-css|xdb)-[^-]+\.js$/), ...keys.filter((key) => /\/container\/dist\/legacy-ui-/.test(key))]);
    groups.script = unique([...core(/^(accel-host|local-speech|python-logic-adapter|script-worker-runtime|shell-source|state-carry|host)-/),
      ...keys.filter((key) => /\/acorn\/dist\/acorn\.mjs$/.test(key))]);
  }
  for (const name of [...componentGroupChunks, ...featureChunks]) {
    const entry = Object.keys(manifest).find((key) => key.endsWith(`/components/dist/${name}.js`));
    groups[name] = entry ? unique([entry]) : [];
  }
  // Every install includes the renderer. Keep the worker's group table small.
  const renderer = new Set(groups.renderer);
  for (const name of Object.keys(groups)) {
    if (name !== 'renderer') groups[name] = groups[name].filter((file) => !renderer.has(file));
  }
  return groups;
}
