import { describe, it, expect, beforeEach } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountSoftNContainer } from '../src/index';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINES_DIR = path.join(PKG_ROOT, 'dist', 'runtime', 'engines');
const LITE_WASM = path.join(ENGINES_DIR, 'zipp-javascript-lite.wasm');
const PHP_WASM = path.join(ENGINES_DIR, 'zipp-php.wasm');
const XDB_WASM = path.join(ENGINES_DIR, 'xdb-wasm.wasm');
const XDB_GLUE = path.join(ENGINES_DIR, 'xdb-wasm.glue.js');

const SNGINE_ROOT =
  'E:\\social_networking_site\\codecanyon-da0suLD6-sngine-the-ultimate-social-network-platform\\Version 5.0\\Script';

function flushAsync(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Full-Stack PHP 8.x Applications in SoftN Containers (zipp-php.wasm + xdb-wasm)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('runs a complete multi-file PHP app from a single .zip with .htaccess rewrites, XDB JSON seed, PDO + mysqli, sessions, forms, frontend fetch(), virtual nav, and strict VFS isolation', async () => {
    const phpAppZip = zipSync({
      '.htaccess': strToU8(`
        Options -Indexes
        <FilesMatch "\\.(env|sql|db)$">
          Deny from all
        </FilesMatch>
        RewriteEngine On
        RewriteCond %{REQUEST_FILENAME} -f [OR]
        RewriteCond %{REQUEST_FILENAME} -d
        RewriteRule .* - [L,QSA]
        RewriteRule ^signin/?$ modules/sign.php?do=in [L,QSA]
        RewriteRule ^profile/([a-z0-9_]+)/?$ modules/profile.php?user=$1 [L,QSA]
      `),
      '.env': strToU8('DB_SECRET=top-secret-never-exposed-to-frontend'),
      'db/seed.json': strToU8(
        JSON.stringify({
          users: [
            { id: 1, username: 'alice', display_name: 'Alice Admin', password: 'secret' },
            { id: 2, username: 'bob', display_name: 'Bob Builder', password: 'pw' },
          ],
          posts: [
            { id: 1, author: 'alice', body: 'Hello from XDB SQLite!' },
            { id: 2, author: 'bob', body: 'Running PHP + SQLite inside browser WASM' },
          ],
        })
      ),
      'includes/db.php': strToU8(`<?php
        function get_pdo() {
          return new PDO('sqlite:app.db');
        }
        function get_mysqli() {
          return new mysqli('localhost', 'root', '', 'app.db');
        }
      `),
      'index.php': strToU8(`<?php
        session_start();
        require_once __DIR__ . '/includes/db.php';
        $pdo = get_pdo();
        $count = $pdo->query('SELECT COUNT(*) FROM posts')->fetchColumn();
        $who = isset($_SESSION['user']) ? $_SESSION['user'] : 'guest';
      ?><!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>SoftN PHP Forum</title>
        <script type="module" src="/assets/app.js"></script>
      </head>
      <body>
        <h1 id="heading">PHP Forum</h1>
        <p id="whoami">Signed in as: <?php echo htmlspecialchars($who, ENT_QUOTES, 'UTF-8'); ?></p>
        <p id="post-count">Posts in DB: <?php echo $count; ?></p>
        <a id="signin-link" href="/signin">Sign In</a>
        <div id="api-posts">loading...</div>
        <div id="leak-check">pending</div>
      </body>
      </html>`),
      'modules/sign.php': strToU8(`<?php
        session_start();
        require_once __DIR__ . '/../includes/db.php';
        $do = isset($_GET['do']) ? $_GET['do'] : 'in';
        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
          $u = isset($_POST['username']) ? $_POST['username'] : '';
          $p = isset($_POST['password']) ? $_POST['password'] : '';
          $db = get_mysqli();
          $stmt = $db->prepare('SELECT username, display_name FROM users WHERE username = ? AND password = ?');
          $stmt->bind_param('ss', $u, $p);
          $stmt->execute();
          $res = $stmt->get_result();
          $row = $res->fetch_assoc();
          if ($row) {
            $_SESSION['user'] = $row['username'];
            $_SESSION['display_name'] = $row['display_name'];
            header('Location: /profile/' . $row['username'], true, 302);
            exit;
          }
          http_response_code(401);
          echo '<!DOCTYPE html><html><body><p id="err">Invalid credentials</p></body></html>';
          exit;
        }
      ?><!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"><title>Sign In</title></head>
      <body>
        <h1 id="sign-title">Sign In (mode=<?php echo htmlspecialchars($do, ENT_QUOTES, 'UTF-8'); ?>)</h1>
        <form id="login-form" action="/signin" method="POST">
          <input name="username" value="alice" />
          <input name="password" value="secret" />
          <button id="submit-btn" type="submit">Log In</button>
        </form>
      </body>
      </html>`),
      'modules/profile.php': strToU8(`<?php
        session_start();
        require_once __DIR__ . '/../includes/db.php';
        $user = isset($_GET['user']) ? $_GET['user'] : '';
        $logged = isset($_SESSION['user']) ? $_SESSION['user'] : 'none';
        $display = isset($_SESSION['display_name']) ? $_SESSION['display_name'] : 'Unknown';
        $pdo = get_pdo();
        $stmt = $pdo->prepare('SELECT body FROM posts WHERE author = ?');
        $stmt->execute([$user]);
        $posts = $stmt->fetchAll(PDO::FETCH_COLUMN);
      ?><!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"><title>Profile: <?php echo htmlspecialchars($user, ENT_QUOTES, 'UTF-8'); ?></title></head>
      <body>
        <h1 id="profile-name"><?php echo htmlspecialchars($display, ENT_QUOTES, 'UTF-8'); ?></h1>
        <p id="session-user">session=<?php echo htmlspecialchars($logged, ENT_QUOTES, 'UTF-8'); ?></p>
        <p id="first-post"><?php echo htmlspecialchars(isset($posts[0]) ? $posts[0] : '', ENT_QUOTES, 'UTF-8'); ?></p>
        <a id="home-link" href="/index.php">Home</a>
      </body>
      </html>`),
      'api/posts.php': strToU8(`<?php
        require_once __DIR__ . '/../includes/db.php';
        header('Content-Type: application/json');
        $pdo = get_pdo();
        $rows = $pdo->query('SELECT id, author, body FROM posts ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
        echo json_encode(['ok' => true, 'posts' => $rows]);
      `),
      'assets/app.js': strToU8(`
        async function load() {
          const resp = await fetch('/api/posts.php');
          const data = await resp.json();
          document.getElementById('api-posts').textContent = data.posts.map(p => p.author + ':' + p.body).join(' | ');
          // Verify strict VFS isolation: frontend CANNOT fetch .env or includes/db.php
          const envResp = await fetch('/.env');
          document.getElementById('leak-check').textContent = 'env_status=' + envResp.status;
        }
        load();
      `),
    });

    const host = document.createElement('div');
    document.body.appendChild(host);

    const handle = await mountSoftNContainer(host, {
      source: phpAppZip,
      appId: 'test-php-forum',
      isolation: 'inline',
      permissionMode: 'deny', // ZERO external `net` permission — local backend still works!
      virtualNav: true,
      engineWasm: { lite: LITE_WASM, php: PHP_WASM },
      xdbWasm: XDB_WASM,
      xdbGlueUrl: XDB_GLUE,
    });

    await flushAsync(100);

    // 1. Initial SSR render of index.php with PDO query against JSON-seeded XDB SQLite
    expect(handle.shadowRoot.querySelector('#heading')?.textContent).toBe('PHP Forum');
    expect(handle.shadowRoot.querySelector('#whoami')?.textContent).toBe('Signed in as: guest');
    expect(handle.shadowRoot.querySelector('#post-count')?.textContent).toBe('Posts in DB: 2');

    // 2. Frontend JS fetched `/api/posts.php` with ZERO `net` permission!
    expect(handle.shadowRoot.querySelector('#api-posts')?.textContent).toBe(
      'alice:Hello from XDB SQLite! | bob:Running PHP + SQLite inside browser WASM'
    );

    // 3. Strict sandbox isolation: `/.env` blocked by `.htaccess` `<FilesMatch>` -> 403!
    expect(handle.shadowRoot.querySelector('#leak-check')?.textContent).toBe('env_status=403');

    // 4. Virtual nav bar is mounted in trusted frameRoot (outside guest shadowRoot)
    const navHolder = handle.frameRoot.querySelector('[data-softn-virtual-nav]');
    expect(navHolder).not.toBeNull();
    expect(handle.shadowRoot.querySelector('[data-softn-virtual-nav]')).toBeNull();

    // 5. Virtual directory listing via handle API
    const modScripts = handle.listVirtualDirectory('modules');
    expect(modScripts.map((e) => e.path)).toEqual(['modules/profile.php', 'modules/sign.php']);

    // 6. Click `<a href="/signin">` -> `.htaccess` rewrites `/signin` to `modules/sign.php?do=in`!
    const signinLink = handle.shadowRoot.querySelector('#signin-link') as HTMLAnchorElement;
    expect(signinLink.getAttribute('href')).toBe('/signin');
    signinLink.click();
    await flushAsync(100);

    expect(handle.currentPath).toBe('/signin');
    expect(handle.shadowRoot.querySelector('#sign-title')?.textContent).toBe('Sign In (mode=in)');

    // 7. Submit `<form action="/signin" method="POST">` -> mysqli checks XDB SQLite,
    //    sets $_SESSION, returns 302 Location: /profile/alice -> followed with PHPSESSID cookie!
    const form = handle.shadowRoot.querySelector('#login-form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushAsync(150);

    expect(handle.currentPath).toBe('/profile/alice');
    expect(handle.shadowRoot.querySelector('#profile-name')?.textContent).toBe('Alice Admin');
    expect(handle.shadowRoot.querySelector('#session-user')?.textContent).toBe('session=alice');
    expect(handle.shadowRoot.querySelector('#first-post')?.textContent).toBe('Hello from XDB SQLite!');

    // 8. Navigate back to `/` via `handle.navigate()` -> session persists!
    await handle.navigate('/');
    await flushAsync(100);
    expect(handle.shadowRoot.querySelector('#whoami')?.textContent).toBe('Signed in as: alice');

    handle.dispose();
  }, 30_000);

  it('executes real Sngine 5.0 PHP core files (sys_ver.php, exceptions.php, functions.php + mysqli) inside a single .zip SoftN container with XDB JSON seed', async () => {
    const incDir = path.join(SNGINE_ROOT, 'includes');
    const sysVerPath = path.join(incDir, 'sys_ver.php');
    const excPath = path.join(incDir, 'exceptions.php');
    const fnPath = path.join(incDir, 'functions.php');
    const htPath = path.join(SNGINE_ROOT, '.htaccess');
    if (!fs.existsSync(sysVerPath) || !fs.existsSync(fnPath)) return;

    const sngineFiles: Record<string, Uint8Array> = {
      '.htaccess': fs.readFileSync(htPath),
      'includes/sys_ver.php': fs.readFileSync(sysVerPath),
      'includes/exceptions.php': fs.readFileSync(excPath),
    };
    for (const f of fs.readdirSync(incDir)) {
      if (/^functions.*\.php$/i.test(f)) {
        sngineFiles[`includes/${f}`] = fs.readFileSync(path.join(incDir, f));
      }
    }

    const sngineZip = zipSync({
      ...sngineFiles,
      'db/seed.json': strToU8(
        JSON.stringify({
          system_options: [
            { option_id: 1, option_name: 'system_title', option_value: 'Sngine 5.0 on SoftN' },
            { option_id: 2, option_name: 'system_live', option_value: '1' },
          ],
        })
      ),
      'index.php': strToU8(`<?php
        define('ABSPATH', __DIR__ . '/');
        define('DB_HOST', 'localhost');
        define('DB_USER', 'root');
        define('DB_PASSWORD', '');
        define('DB_NAME', 'app.db');
        define('DB_PORT', 3306);
        require_once ABSPATH . 'includes/sys_ver.php';
        require_once ABSPATH . 'includes/exceptions.php';
        require_once ABSPATH . 'includes/functions.php';
        $db = init_db_connection();
        $opts = [];
        $res = $db->query('SELECT option_name, option_value FROM system_options');
        while ($row = $res->fetch_assoc()) {
          $opts[$row['option_name']] = $row['option_value'];
        }
        $sanitized = secure("hello 'world'");
      ?><!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"><title><?php echo htmlspecialchars($opts['system_title'], ENT_QUOTES, 'UTF-8'); ?></title></head>
      <body>
        <h1 id="sngine-title"><?php echo htmlspecialchars($opts['system_title'], ENT_QUOTES, 'UTF-8'); ?></h1>
        <p id="sngine-ver"><?php echo SYS_NAME . ' ' . SYS_VER; ?></p>
        <p id="sngine-secure"><?php echo htmlspecialchars($sanitized, ENT_QUOTES, 'UTF-8'); ?></p>
      </body>
      </html>`),
    });

    const host = document.createElement('div');
    document.body.appendChild(host);

    const handle = await mountSoftNContainer(host, {
      source: sngineZip,
      appId: 'test-sngine-real',
      isolation: 'inline',
      permissionMode: 'deny',
      engineWasm: { lite: LITE_WASM, php: PHP_WASM },
      xdbWasm: XDB_WASM,
      xdbGlueUrl: XDB_GLUE,
    });

    await flushAsync(80);
    expect(handle.shadowRoot.querySelector('#sngine-title')?.textContent).toBe('Sngine 5.0 on SoftN');
    expect(handle.shadowRoot.querySelector('#sngine-ver')?.textContent).toBe('Sngine 5.0');
    expect(handle.shadowRoot.querySelector('#sngine-secure')?.textContent).toBe("'hello &#039;world&#039;'");

    handle.dispose();
  }, 30_000);
});
