import type { StarterFile, WebStarterId } from '../webStarters';
import vanilla from './vanilla.js?raw';
import react from './react.js?raw';
import vue from './vue.js?raw';
import jsx from './App.jsx?raw';
import sfc from './App.vue?raw';
import styles from './styles.css?raw';

const entries = {
  vanilla, react, vue,
  'react-jsx': jsx,
  'vue-sfc': "import { createApp } from 'vue';\nimport App from './App.vue';\n\ncreateApp(App).mount('#app');\n",
};

const componentImports = {
  'react-jsx': { react: '/vendor/react.js', 'react-dom/client': '/vendor/react.js' },
  'vue-sfc': { vue: '/vendor/vue.js' },
};

const icons = {
  vanilla: { color: '#256041', path: 'm9 44 17-24 12 14 6-8 11 18H9Z' },
  react: { color: '#334a96', path: 'M24 16h16a16 16 0 0 1 0 32H24a16 16 0 0 1 0-32Zm0 7h16a9 9 0 0 1 0 18H24a9 9 0 0 1 0-18Zm10-7v7' },
  vue: { color: '#8c3949', path: 'M32 23c-6-5-13-6-21-5v26c8-1 15 0 21 5 6-5 13-6 21-5V18c-8-1-15 0-21 5Zm0 0v26' },
};
const iconPath = 'assets/icon.svg';

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export async function buildStarter(
  id: WebStarterId, name: string, description: string, theme: 'light' | 'dark' | 'system',
): Promise<StarterFile[]> {
  const framework = id === 'react-jsx' ? 'react' : id === 'vue-sfc' ? 'vue' : id;
  const entry = id === 'react-jsx' ? 'App.jsx' : 'app.js';
  const icon = icons[framework];
  const imports = id === 'react-jsx' || id === 'vue-sfc' ? componentImports[id] : null;
  const files: StarterFile[] = [
    { path: 'index.html', content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(name)}</title>
    <link rel="icon" href="./${iconPath}" />
    <link rel="stylesheet" href="./styles.css" />${imports ? '\n    <script type="importmap">' + JSON.stringify({ imports }) + '</script>' : ''}
  </head>
  <body>
    <main class="page ${framework}" data-theme="${theme}">
      <article class="card">
        <header>
          <h1>${escapeHtml(name)}</h1>
          ${description ? `<p>${escapeHtml(description)}</p>` : ''}
        </header>
        <div id="app"></div>
      </article>
    </main>
    <script type="module" src="./${entry}"></script>
  </body>
</html>
` },
    { path: entry, content: entries[id] },
    { path: 'styles.css', content: styles },
    { path: 'permission.json', content: JSON.stringify({ permissions: {} }, null, 2) + '\n' },
    { path: iconPath, content: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="${icon.color}"/>
  <path d="${icon.path}" fill="none" stroke="white" stroke-width="3" stroke-linejoin="round"/>
</svg>
` },
  ];
  const scripts: string[] = [entry];
  if (id === 'vue-sfc') {
    files.push({ path: 'App.vue', content: sfc });
    scripts.push('App.vue');
  }
  if (framework !== 'vanilla') {
    const path = `vendor/${framework}.js`;
    const vendor = framework === 'react' ? await import('virtual:softn-starter/react')
      : id === 'vue-sfc' ? await import('virtual:softn-starter/vue-sfc') : await import('virtual:softn-starter/vue');
    scripts.push(path);
    files.push({ path, content: vendor.default });
  }
  const manifest = {
    engine: 2, name, version: '1.0.0', description, main: 'index.html', icon: iconPath,
    files: { ui: ['index.html'], logic: scripts, assets: ['styles.css', iconPath] },
    config: { theme: { mode: theme } },
  };
  return [{ path: 'manifest.json', content: JSON.stringify(manifest, null, 2) + '\n' }, ...files];
}
