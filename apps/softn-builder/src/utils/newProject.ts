/**
 * Starting a new app: every store back to empty, then the choices from the
 * New app dialog, then the starter template — written into the entry file.
 *
 * The template used to be added to the canvas only. The workspace reloads the
 * canvas from the active UI file whenever the files change, and resetting the
 * files had just replaced that file with an empty one, so every template was
 * wiped a render later: "Landing page" and "Dashboard" made the same empty
 * page as "Blank".
 */

import { useCanvasStore } from '../stores/canvasStore';
import type { StarterFile } from '@softn/editor-shared/webStarters';
import { useFilesStore } from '../stores/filesStore';
import { useHistoryStore } from '../stores/historyStore';
import { useProjectStore } from '../stores/projectStore';
import { useSchemaStore } from '../stores/schemaStore';
import type { LogicFileState, UIFileState } from '../types/builder';
import { flushCanvasToActiveFile } from './buildProjectBundle';
import { parseBundleFiles } from './bundleExporter';
import { loadBundleContents } from './bundleLoader';
import { prepareProjectSnapshot, commitProjectSnapshot } from './openProject';
import { markUnsaved } from './savedPoint';
import { expressionText } from './starterProps';
import type { NewProjectConfig, NewProjectLanguage, StarterTemplate } from '../components/toolbar/NewProjectDialog';

/** Put a starter template's elements under the canvas root. */
export function applyStarterTemplate(template: StarterTemplate): void {
  // Blank is the root and nothing else: the canvas's empty state says how
  // to start, which placeholder prose to delete first would not.
  if (template === 'blank') return;

  const canvas = useCanvasStore.getState();
  const rootId = canvas.rootId;

  if (template === 'landing') {
    const stack = canvas.addElement('Stack', rootId);
    canvas.updateElementProps(stack, { direction: 'vertical', gap: 'lg', align: 'center', padding: 'xl' });
    const heading = canvas.addElement('Heading', stack);
    canvas.updateElementProps(heading, { level: 1, children: 'Build apps faster with SoftN' });
    const subText = canvas.addElement('Text', stack);
    canvas.updateElementProps(subText, { children: 'Compose UI visually, wire logic quickly, and ship instantly.' });
    const cta = canvas.addElement('Button', stack);
    canvas.updateElementProps(cta, { variant: 'primary', children: 'Get Started' });
    return;
  }

  if (template === 'dashboard') {
    const page = canvas.addElement('Stack', rootId);
    canvas.updateElementProps(page, { direction: 'vertical', gap: 'md', padding: 'lg' });
    const heading = canvas.addElement('Heading', page);
    canvas.updateElementProps(heading, { level: 1, children: 'Dashboard' });
    const stats = canvas.addElement('SmartStats', page);
    canvas.updateElementProps(stats, { stats: 'Open: 12, Done: 30, Overdue: 2', columns: 3 });
    const cards = canvas.addElement('SmartCards', page);
    const projects = rows('data', SAMPLE_PROJECTS);
    canvas.updateElement(cards, { props: { ...projects.props, title: 'title', description: 'description' }, expressionProps: projects.expressionProps });
    const list = canvas.addElement('SmartList', page);
    const tasks = rows('data', SAMPLE_TASKS);
    canvas.updateElement(list, { props: { ...tasks.props, primary: 'title', secondary: 'status' }, expressionProps: tasks.expressionProps });
  }
}

/** What the Dashboard's cards show until they are given the app's own rows. */
const SAMPLE_PROJECTS = [
  { title: 'Website refresh', description: 'New home page and pricing' },
  { title: 'Spring newsletter', description: 'Draft due on Friday' },
  { title: 'Customer survey', description: 'Results are in' },
];

/** What the Dashboard's list shows until it is given the app's own rows. */
const SAMPLE_TASKS = [
  { title: 'Write the brief', status: 'Done' },
  { title: 'Review the designs', status: 'Open' },
  { title: 'Send the invoice', status: 'Overdue' },
];

/**
 * A list of rows as the property `name`, kept the way the source parser
 * keeps an expression (utils/starterProps.ts), so the page reads back as it
 * was written. Nothing when the list cannot be written.
 */
function rows(name: string, list: readonly Record<string, string>[]): { props: Record<string, unknown>; expressionProps: string[] } {
  const text = expressionText(JSON.stringify(list));
  return text === null ? { props: {}, expressionProps: [] } : { props: { [name]: text }, expressionProps: [name] };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildWebContainerStarter(
  name: string,
  description: string,
  template: StarterTemplate,
  language: NewProjectLanguage
): { html: string; css: string; scriptPath: string; scriptContent: string } {
  const safeName = escapeHtml(name || 'Untitled App');
  const safeDesc = escapeHtml(description || 'Running inside a sandboxed SoftN v2 Web Container.');
  const scriptPath = language === 'python' ? 'main.py' : language === 'typescript' ? 'app.ts' : 'app.js';
  const scriptTag =
    language === 'python'
      ? `<script type="text/python" src="./${scriptPath}"></script>`
      : `<script type="module" src="./${scriptPath}"></script>`;

  const bodyInner =
    template === 'dashboard'
      ? `  <main class="shell">
    <header class="hero">
      <div>
        <h1>${safeName}</h1>
        <p class="muted">${safeDesc}</p>
      </div>
      <button id="add-task-btn" class="btn">+ Add Item</button>
    </header>
    <section class="stats" id="stats-grid">
      <div class="card"><span class="label">Active</span><strong id="stat-active">3</strong></div>
      <div class="card"><span class="label">Completed</span><strong id="stat-done">1</strong></div>
    </section>
    <section class="card">
      <h2>Tasks</h2>
      <ul id="task-list" class="list"></ul>
    </section>
  </main>`
      : template === 'landing'
        ? `  <main class="shell centered">
    <h1>${safeName}</h1>
    <p class="muted">${safeDesc}</p>
    <button id="cta-btn" class="btn">Get started (<span id="clicks">0</span>)</button>
  </main>`
        : `  <main class="shell">
    <h1>${safeName}</h1>
    <p class="muted">${safeDesc}</p>
    <div id="app"></div>
  </main>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeName}</title>
  <link rel="stylesheet" href="softn:ui.css" />
  <link rel="stylesheet" href="./style.css" />
</head>
<body>
${bodyInner}
  ${scriptTag}
</body>
</html>
`;

  const css = `:root {
  font-family: Inter, system-ui, -apple-system, sans-serif;
  color: var(--softn-fg, #f8fafc);
  background: var(--softn-bg, #0f172a);
}

body {
  margin: 0;
  padding: 24px;
}

.shell {
  max-width: 760px;
  margin: 0 auto;
  display: grid;
  gap: 16px;
}

.shell.centered {
  text-align: center;
  justify-items: center;
  padding-top: 48px;
}

.hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.muted {
  opacity: 0.72;
  margin: 4px 0 0;
}

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
}

.card {
  padding: 16px;
  border-radius: 12px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  background: rgba(148, 163, 184, 0.06);
}

.card .label {
  display: block;
  font-size: 12px;
  opacity: 0.7;
}

.card strong {
  font-size: 24px;
}

.btn {
  padding: 9px 16px;
  border-radius: 8px;
  border: none;
  background: #6366f1;
  color: #ffffff;
  font-weight: 600;
  cursor: pointer;
}

.list {
  list-style: none;
  padding: 0;
  margin: 8px 0 0;
  display: grid;
  gap: 8px;
}

.list li {
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(148, 163, 184, 0.08);
  display: flex;
  justify-content: space-between;
}
`;

  let scriptContent: string;
  if (language === 'python') {
    if (template === 'dashboard') {
      scriptContent = `# ${scriptPath} — runs inside SoftN's isolated ZIPP Python Worker
from js import document

tasks = [
    {"title": "Write container spec", "done": True},
    {"title": "Preview in SoftN Builder", "done": False},
]


def render():
    task_list = document.getElementById("task-list")
    if not task_list:
        return
    task_list.innerHTML = ""
    for item in tasks:
        li = document.createElement("li")
        mark = "✓" if item["done"] else "○"
        li.textContent = f"{mark} {item['title']}"
        task_list.appendChild(li)
    active = document.getElementById("stat-active")
    done = document.getElementById("stat-done")
    if active:
        active.textContent = str(sum(1 for t in tasks if not t["done"]))
    if done:
        done.textContent = str(sum(1 for t in tasks if t["done"]))


def add_task(_event=None):
    tasks.append({"title": f"Task #{len(tasks) + 1}", "done": False})
    render()


btn = document.getElementById("add-task-btn")
if btn:
    btn.addEventListener("click", add_task)

render()
`;
    } else if (template === 'landing') {
      scriptContent = `# ${scriptPath} — runs inside SoftN's isolated ZIPP Python Worker
from js import document

clicks = 0


def on_cta(_event=None):
    global clicks
    clicks += 1
    badge = document.getElementById("clicks")
    if badge:
        badge.textContent = str(clicks)


btn = document.getElementById("cta-btn")
if btn:
    btn.addEventListener("click", on_cta)
`;
    } else {
      scriptContent = `# ${scriptPath} — runs inside SoftN's isolated ZIPP Python Worker
from js import document

app = document.getElementById("app")
if app:
    app.textContent = "Python Web Container ready."
`;
    }
  } else if (template === 'dashboard') {
    const typeDecl = language === 'typescript' ? `\ninterface TaskItem {\n  title: string;\n  done: boolean;\n}\n` : '';
    const listType = language === 'typescript' ? ': TaskItem[]' : '';
    scriptContent = `// ${scriptPath} — runs inside SoftN's isolated ZIPP Worker${typeDecl}
const tasks${listType} = [
  { title: 'Write container spec', done: true },
  { title: 'Preview in SoftN Builder', done: false },
];

function render() {
  const list = document.getElementById('task-list');
  if (!list) return;
  list.innerHTML = '';
  for (const item of tasks) {
    const li = document.createElement('li');
    li.textContent = \`\${item.done ? '✓' : '○'} \${item.title}\`;
    list.appendChild(li);
  }
  const active = document.getElementById('stat-active');
  const done = document.getElementById('stat-done');
  if (active) active.textContent = String(tasks.filter((t) => !t.done).length);
  if (done) done.textContent = String(tasks.filter((t) => t.done).length);
}

document.getElementById('add-task-btn')?.addEventListener('click', () => {
  tasks.push({ title: \`Task #\${tasks.length + 1}\`, done: false });
  render();
});

render();
`;
  } else if (template === 'landing') {
    const countType = language === 'typescript' ? ': number' : '';
    scriptContent = `// ${scriptPath} — runs inside SoftN's isolated ZIPP Worker
let clicks${countType} = 0;

document.getElementById('cta-btn')?.addEventListener('click', () => {
  clicks += 1;
  const badge = document.getElementById('clicks');
  if (badge) badge.textContent = String(clicks);
});
`;
  } else {
    const msgType = language === 'typescript' ? ': string' : '';
    scriptContent = `// ${scriptPath} — runs inside SoftN's isolated ZIPP Worker
const root = document.getElementById('app');
const message${msgType} = 'Web Container ready.';
if (root) {
  root.textContent = message;
}
`;
  }

  return { html, css, scriptPath, scriptContent };
}

/** Replace the workspace with a new app made from the dialog's choices. */
export function startNewProject(config: NewProjectConfig, starterFiles?: StarterFile[]): void {
  if (starterFiles) {
    const encoder = new TextEncoder();
    const entries = new Map(starterFiles.map(({ path, content }) => [path, encoder.encode(content)]));
    const snapshot = prepareProjectSnapshot(loadBundleContents(parseBundleFiles(entries)));
    commitProjectSnapshot(snapshot);
    // Keep the app's own three files available above the editor. Preview still
    // runs the HTML entry, whichever file is selected for editing.
    const files = useFilesStore.getState();
    if (files.activeFileId === snapshot.project.source.mainFileId) {
      for (const path of ['styles.css', 'app.js']) {
        const file = [...files.logicFiles.values()].find((entry) => entry.path === path);
        if (file) files.openFile(file.id);
      }
    }
    markUnsaved();
    return;
  }
  const isWeb = config.format === 'web' || config.language === 'typescript';
  const baseLanguage = config.language === 'python' ? 'python' : 'javascript';

  useCanvasStore.getState().reset();
  useProjectStore.getState().reset(baseLanguage);
  useHistoryStore.getState().clear();
  useSchemaStore.getState().reset();

  if (isWeb) {
    const project = useProjectStore.getState();
    project.setProjectFormat('web');
    project.setName(config.name);
    project.setDescription(config.description);
    project.setThemeMode(config.theme);
    project.setVersion('1.0.0');
    project.setPythonPackages(config.pythonPackages);

    const starter = buildWebContainerStarter(config.name, config.description, config.template, config.language);
    const htmlId = 'web_index_html';
    const rootId = `root_${htmlId}`;
    const uiFiles = new Map<string, UIFileState>([
      [
        htmlId,
        {
          id: htmlId,
          path: 'index.html',
          elements: new Map([
            [
              rootId,
              {
                id: rootId,
                componentType: 'App',
                props: { theme: config.theme },
                children: [],
                parentId: null,
              },
            ],
          ]),
          rootId,
          imports: [],
          originalSource: starter.html,
        },
      ],
    ]);
    const logicFiles = new Map<string, LogicFileState>([
      ['web_style_css', { id: 'web_style_css', path: 'style.css', content: starter.css }],
      ['web_entry_script', { id: 'web_entry_script', path: starter.scriptPath, content: starter.scriptContent }],
    ]);

    useFilesStore.getState().loadFromBundle(uiFiles, logicFiles, new Map(), htmlId);
    useProjectStore.getState().setSource({
      ...useProjectStore.getState().source,
      mainFileId: htmlId,
    });
    useProjectStore.getState().markDirty();
    return;
  }

  useFilesStore.getState().reset(baseLanguage);

  const project = useProjectStore.getState();
  project.setName(config.name);
  project.setDescription(config.description);
  project.setThemeMode(config.theme);
  project.setVersion('1.0.0');
  project.setPythonPackages(config.pythonPackages);

  const canvas = useCanvasStore.getState();
  const root = canvas.getElement(canvas.rootId);
  if (root) canvas.updateElementProps(root.id, { theme: config.theme });

  applyStarterTemplate(config.template);
  // Into the file, or the next reload of the canvas from it throws it away.
  flushCanvasToActiveFile();

  // The new project has not been saved anywhere yet, including its name,
  // chosen template and theme. Keep navigation/New/Open guards active.
  useProjectStore.getState().markDirty();
}
