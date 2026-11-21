import type { ExampleProject } from './index';

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect width="64" height="64" rx="16" fill="#0d9488"/><path d="M18 22h28v4H18zm0 10h20v4H18zm0 10h28v4H18z" fill="#ffffff"/><circle cx="46" cy="34" r="5" fill="#fde047"/></svg>`;

export const CONTAINER_FULLSTACK_NOTES: ExampleProject = {
  id: 'container-fullstack-notes',
  name: 'Full-Stack Notes — PHP + SQLite (example)',
  description:
    'A full-stack SoftN v2 Web Container with a Preact frontend and a sandboxed PHP + SQLite REST API running locally in ZIPP WASM (or multi-user on softn-server).',
  files: [
    {
      path: 'manifest.json',
      content: JSON.stringify(
        {
          engine: 2,
          name: 'Full-Stack Notes',
          version: '2.0.0',
          description: 'Sandboxed PHP + SQLite REST API and Preact frontend inside a single .softn container.',
          main: 'index.html',
          icon: 'assets/icon.svg',
          backend: {
            runtime: 'php',
            entry: 'backend/index.php',
            mode: 'api',
            routes: ['/api/'],
          },
          databases: [
            {
              name: 'notes',
              engine: 'sqlite',
              file: 'notes.db',
              seedSql: 'backend/schema.sql',
              persist: true,
            },
          ],
          files: {
            ui: ['index.html'],
            logic: ['app.ts'],
            xdb: [],
            assets: ['assets/icon.svg', 'styles.css', 'backend/index.php', 'backend/schema.sql'],
          },
          config: {
            execution: 'worker',
            theme: { mode: 'dark' },
          },
        },
        null,
        2
      ),
    },
    {
      path: 'permission.json',
      content: JSON.stringify({ permissions: {} }, null, 2),
    },
    {
      path: 'assets/icon.svg',
      content: ICON_SVG,
    },
    {
      path: 'styles.css',
      content: `.header-title {
  margin: 0;
}
.note-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.note-body {
  flex: 1;
  min-width: 0;
}
.note-done {
  text-decoration: line-through;
  opacity: 0.65;
}
`,
    },
    {
      path: 'index.html',
      content: `<!DOCTYPE html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Full-Stack Notes</title>
    <link rel="icon" href="./assets/icon.svg" />
    <link rel="stylesheet" href="softn:ui.css" />
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <div id="app" class="container stack gap-md"></div>
    <script type="module" src="./app.ts"></script>
  </body>
</html>
`,
    },
    {
      path: 'app.ts',
      content: `import { h, render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

const html = htm.bind(h);

interface Note {
  id: number;
  title: string;
  tag: string;
  done: number;
}

function App() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [title, setTitle] = useState('');
  const [tag, setTag] = useState('Work');
  const [runtime, setRuntime] = useState('Booting PHP + SQLite...');

  async function loadNotes() {
    const res = await fetch('/api/notes');
    const data = await res.json();
    setNotes(Array.isArray(data.notes) ? data.notes : []);
    setRuntime(data.runtime ? \`Sandboxed \${data.runtime} + SQLite\` : 'PHP + SQLite');
  }

  useEffect(() => {
    void loadNotes();
  }, []);

  async function addNote(e: Event) {
    e.preventDefault();
    const clean = title.trim();
    if (!clean) return;
    await fetch('/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: clean, tag }),
    });
    setTitle('');
    await loadNotes();
  }

  async function toggleNote(id: number) {
    await fetch(\`/api/notes/\${id}\`, { method: 'PATCH' });
    await loadNotes();
  }

  async function deleteNote(id: number) {
    await fetch(\`/api/notes/\${id}\`, { method: 'DELETE' });
    await loadNotes();
  }

  return html\`
    <div class="stack gap-md">
      <div class="row between wrap gap-sm">
        <h1 class="header-title">Full-Stack Notes</h1>
        <span class="badge">\${runtime}</span>
      </div>
      <p class="muted">
        Every request hits <code>backend/index.php</code> and SQLite inside the ZIPP sandbox — locally in your browser or multi-user on softn-server.
      </p>
      <form class="row wrap gap-xs" onSubmit=\${addNote}>
        <input
          value=\${title}
          onInput=\${(e: Event) => setTitle((e.target as HTMLInputElement).value)}
          placeholder="Write a note..."
          style="flex: 1; min-width: 180px"
        />
        <select
          value=\${tag}
          onChange=\${(e: Event) => setTag((e.target as HTMLSelectElement).value)}
        >
          <option value="Work">Work</option>
          <option value="Ops">Ops</option>
          <option value="Ideas">Ideas</option>
        </select>
        <button type="submit" class="btn primary">Save to SQLite</button>
      </form>
      <div class="stack gap-xs">
        \${notes.map(
          (note) => html\`
            <article key=\${note.id} class="card note-row">
              <div class="note-body">
                <div class=\${note.done ? 'note-done' : ''}>\${note.title}</div>
                <span class="badge">\${note.tag}</span>
              </div>
              <div class="row gap-xs">
                <button type="button" class="btn" onClick=\${() => toggleNote(note.id)}>
                  \${note.done ? 'Reopen' : 'Done'}
                </button>
                <button type="button" class="btn danger" onClick=\${() => deleteNote(note.id)}>
                  Delete
                </button>
              </div>
            </article>
          \`
        )}
      </div>
    </div>
  \`;
}

const root = document.getElementById('app');
if (root) render(html\`<\${App} />\`, root);
`,
    },
    {
      path: 'backend/schema.sql',
      content: `CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  tag TEXT NOT NULL DEFAULT 'Work',
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO notes (title, tag, done) VALUES ('PHP PDO running inside ZIPP WebAssembly sandbox', 'Ops', 0);
INSERT INTO notes (title, tag, done) VALUES ('Same .softn bundle runs multi-user on softn-server', 'Work', 0);
INSERT INTO notes (title, tag, done) VALUES ('Try adding or toggling a note above', 'Ideas', 1);
`,
    },
    {
      path: 'backend/index.php',
      content: `<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

$pdo = new PDO('sqlite:notes.db');
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/api/notes', PHP_URL_PATH) ?: '/api/notes';

if ($method === 'GET' && $path === '/api/notes') {
    $rows = $pdo->query('SELECT id, title, tag, done FROM notes ORDER BY id DESC')->fetchAll();
    echo json_encode(['runtime' => 'PHP ' . PHP_VERSION, 'notes' => $rows]);
    exit;
}

if ($method === 'POST' && $path === '/api/notes') {
    $payload = json_decode(file_get_contents('php://input') ?: '{}', true);
    $title = trim((string)($payload['title'] ?? ''));
    $tag = trim((string)($payload['tag'] ?? 'Work')) ?: 'Work';
    if ($title === '') {
        http_response_code(422);
        echo json_encode(['error' => 'Title is required']);
        exit;
    }
    $stmt = $pdo->prepare('INSERT INTO notes (title, tag, done) VALUES (?, ?, 0)');
    $stmt->execute([$title, $tag]);
    $id = (int)$pdo->lastInsertId();
    $row = $pdo->query('SELECT id, title, tag, done FROM notes WHERE id = ' . $id)->fetch();
    http_response_code(201);
    echo json_encode(['note' => $row]);
    exit;
}

if ($method === 'PATCH' && preg_match('#^/api/notes/(\\d+)$#', $path, $m)) {
    $id = (int)$m[1];
    $stmt = $pdo->prepare('UPDATE notes SET done = CASE WHEN done = 0 THEN 1 ELSE 0 END WHERE id = ?');
    $stmt->execute([$id]);
    $row = $pdo->query('SELECT id, title, tag, done FROM notes WHERE id = ' . $id)->fetch();
    echo json_encode(['note' => $row]);
    exit;
}

if ($method === 'DELETE' && preg_match('#^/api/notes/(\\d+)$#', $path, $m)) {
    $id = (int)$m[1];
    $stmt = $pdo->prepare('DELETE FROM notes WHERE id = ?');
    $stmt->execute([$id]);
    echo json_encode(['deleted' => $id]);
    exit;
}

http_response_code(404);
echo json_encode(['error' => 'Not found', 'path' => $path]);
`,
    },
  ],
};
