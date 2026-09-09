// After `vite build`: turn dist/webroot/index.html into the server-rendered
// shell template in dist/private, and give dist/private the sample bundle,
// the sample configuration and its own deny-all .htaccess. Never replaces an
// operator's bundle or configuration.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetTags, privateHtaccess, sampleBundle, sampleConfig, shellTemplate } from './shell.mjs';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webroot = path.join(app, 'dist/webroot');
const priv = path.join(app, 'dist/private');
const built = path.join(webroot, 'index.html');
if (!fs.existsSync(built)) throw Error('Run vite build first.');
fs.mkdirSync(priv, { recursive: true });

fs.writeFileSync(
  path.join(priv, 'shell.html'),
  shellTemplate(assetTags(fs.readFileSync(built, 'utf8')))
);
// The built page must not stay in webroot: DirectoryIndex prefers index.php,
// but a static index.html beside it is a page with no boot configuration.
fs.rmSync(built);
fs.rmSync(path.join(webroot, '.vite'), { recursive: true, force: true });
fs.writeFileSync(path.join(priv, '.htaccess'), privateHtaccess);
if (!fs.existsSync(path.join(priv, 'app.softn')))
  fs.writeFileSync(path.join(priv, 'app.softn'), sampleBundle());
if (!fs.existsSync(path.join(priv, 'serve.config.php')))
  fs.writeFileSync(path.join(priv, 'serve.config.php'), sampleConfig);
for (const name of ['index.php', 'softn-serve.php', '.htaccess'])
  if (!fs.existsSync(path.join(webroot, name)))
    throw Error('Missing ' + name + ' in dist/webroot; check public/.');
console.log('dist/webroot and dist/private assembled');
