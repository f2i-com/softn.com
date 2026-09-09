// Serve dist/webroot with PHP's built-in server, the way the deployment runs
// under Apache minus .htaccess. Requires `php` on PATH (8.1+ with ext-zip).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webroot = path.join(app, 'dist/webroot');
if (
  !fs.existsSync(path.join(webroot, 'index.php')) ||
  !fs.existsSync(path.join(app, 'dist/private/shell.html'))
)
  throw Error('Run npm run build first.');
const php = process.env.PHP || 'php';
const probe = spawnSync(php, ['--version'], { encoding: 'utf8' });
if (probe.status !== 0) throw Error('PHP was not found. Install PHP 8.1+ or set PHP=/path/to/php.');
const port = Number(process.env.PORT || 1456);
console.log(`softn-single-php-serve preview: http://127.0.0.1:${port}/`);
const child = spawn(php, ['-S', `127.0.0.1:${port}`, '-t', webroot], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill());
