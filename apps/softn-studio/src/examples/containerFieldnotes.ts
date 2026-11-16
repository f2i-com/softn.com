import type { ExampleProject } from './index';

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect width="64" height="64" rx="16" fill="#0f766e"/><path d="M20 22h24v4H20zm0 10h24v4H20zm0 10h16v4H20z" fill="#ffffff"/></svg>`;

export const CONTAINER_FIELDNOTES: ExampleProject = {
  id: 'container-fieldnotes',
  name: 'Fieldnotes (example)',
  description: 'A zero-build SoftN v2 Web Container written in TypeScript with hosted Preact, softn:db, and <softn-chart>.',
  files: [
    {
      path: 'manifest.json',
      content: JSON.stringify(
        {
          engine: 2,
          name: 'Fieldnotes',
          version: '2.0.0',
          description: 'Zero-build TypeScript + Preact Web Container example.',
          main: 'index.html',
          icon: 'assets/icon.svg',
          files: {
            ui: ['index.html'],
            logic: ['app.ts'],
            xdb: ['xdb/notes.xdb'],
            assets: ['assets/icon.svg', 'styles.css'],
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
      content: `.header-title {\n  margin: 0;\n}\n`,
    },
    {
      path: 'index.html',
      content: `<!DOCTYPE html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Fieldnotes</title>
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
import { useState } from 'preact/hooks';
import htm from 'htm';
import { db } from 'softn:db';

const html = htm.bind(h);

interface NoteRow {
  id: string;
  title: string;
  points: number;
}

function go(nextTitle: string): NoteRow[] {
  db.create('notes', { title: nextTitle, points: 15 + Math.floor(Math.random() * 35) });
  return db.query('notes') as NoteRow[];
}

function App() {
  const [notes, setNotes] = useState<NoteRow[]>(() => db.query('notes') as NoteRow[]);
  const [draft, setDraft] = useState('');
  const values = JSON.stringify(notes.map((n) => n.points));

  const addNote = () => {
    const clean = draft.trim() || \`Observation #\${notes.length + 1}\`;
    setNotes(go(clean));
    setDraft('');
  };

  return html\`
    <div class="stack gap-md">
      <div class="row between wrap gap-sm">
        <h1 class="header-title">Fieldnotes</h1>
        <span class="badge">\${notes.length} entries</span>
      </div>
      <div class="row gap-xs">
        <input
          value=\${draft}
          onInput=\${(e: Event) => setDraft((e.target as HTMLInputElement).value)}
          placeholder="Add observation..."
        />
        <button class="btn primary" onClick=\${addNote}>Add</button>
      </div>
      <softn-chart type="bar" color="#14b8a6" values=\${values}></softn-chart>
      <softn-datagrid columns="title,points" rows=\${JSON.stringify(notes)}></softn-datagrid>
    </div>
  \`;
}

const root = document.getElementById('app');
if (root) render(html\`<\${App} />\`, root);
`,
    },
    {
      path: 'xdb/notes.xdb',
      content: JSON.stringify(
        {
          collection: 'notes',
          records: [
            { id: 'n1', title: 'Isolated Worker VM', points: 24 },
            { id: 'n2', title: 'Zero-build TypeScript', points: 36 },
            { id: 'n3', title: 'On-demand Web Components', points: 48 },
          ],
        },
        null,
        2
      ),
    },
  ],
};
