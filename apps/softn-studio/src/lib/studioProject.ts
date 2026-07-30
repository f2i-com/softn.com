import type {
  AgentTask,
  Blueprint,
  BlueprintCollection,
  BlueprintPage,
  ProjectBrief,
  VFSFile,
} from '../types/studio';

/**
 * Escape text before it goes into generated HTML.
 *
 * Everything interpolated below is untrusted: the app name and description come
 * from whatever the user typed into the brief, and collection and page names can
 * come straight back from the model. Without this, a name of
 * `</title><script>…</script>` closed the title element and injected into the
 * head of every generated page, and a description carrying `<img src=x onerror=…>`
 * landed verbatim in the body.
 *
 * slugify() is not a substitute — it happens to strip to [a-z0-9-] and so is
 * safe for href, but it is not an escaper and must not be relied on as one.
 */
function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'page';
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function buildPages(brief: ProjectBrief): BlueprintPage[] {
  const requestedPages = brief.pages.length > 0
    ? brief.pages
    : ['Home', 'Overview', brief.collections.length > 0 ? 'Data' : 'Workspace'];

  return requestedPages.map((name, index) => {
    const slug = slugify(name);
    return {
      id: `${slug}-page`,
      name: titleCase(name),
      route: index === 0 ? '/' : `/${slug}`,
      layout: brief.target === 'desktop' ? 'stack' : 'responsive-shell',
      components: index === 0
        ? ['hero', 'summary', 'primary-action']
        : ['section-header', 'content-grid'],
    };
  });
}

function buildCollections(brief: ProjectBrief): BlueprintCollection[] {
  return brief.collections.map((name) => ({
    id: `${slugify(name)}-collection`,
    name: titleCase(name),
    fields: [
      { name: 'id', type: 'string', required: true },
      { name: 'title', type: 'string', required: true },
      { name: 'status', type: 'string', required: false, defaultValue: 'draft' },
      { name: 'updatedAt', type: 'date', required: false },
    ],
    relationships: [],
  }));
}

export function generateBlueprintFromBrief(brief: ProjectBrief): Blueprint {
  const pages = buildPages(brief);
  const collections = buildCollections(brief);

  return {
    appName: brief.appName,
    target: brief.target,
    style: brief.style,
    pages,
    collections,
    navigation: {
      type: pages.length > 4 ? 'sidebar' : 'tabs',
      items: pages.map((page) => page.name),
    },
    risks: [
      brief.target === 'dual' ? 'Dual-target apps should avoid target-specific assumptions.' : 'Review generated layouts before export.',
      brief.authNeeded ? 'Authentication flows require provider and session decisions before production.' : 'Data workflows may need collection-specific validation.',
    ],
    assumptions: [
      'The first generated pass prioritizes structure and previewability over dense business logic.',
      'API providers should be configured per role before advanced generation.',
    ],
  };
}

export function generateTaskGraph(blueprint: Blueprint): AgentTask[] {
  return [
    {
      id: 'task-blueprint',
      title: 'Blueprint approved',
      description: 'Lock the structure, target, and data model.',
      status: 'complete',
      dependencies: [],
      retries: 0,
      files: ['builder/blueprint.json', 'builder/data-model.json'],
    },
    {
      id: 'task-pages',
      title: 'Scaffold pages',
      description: 'Create the initial page shells and navigation.',
      status: 'complete',
      dependencies: ['task-blueprint'],
      retries: 0,
      files: blueprint.pages.map((page) => `pages/${slugify(page.name)}.html`),
    },
    {
      id: 'task-data',
      title: 'Seed data model',
      description: 'Create starter data files and relationship placeholders.',
      status: blueprint.collections.length > 0 ? 'complete' : 'skipped',
      dependencies: ['task-blueprint'],
      retries: 0,
      files: blueprint.collections.map((collection) => `data/${slugify(collection.name)}.xdb`),
    },
    {
      id: 'task-export',
      title: 'Prepare export bundle',
      description: 'Validate bundle shape for .softn download.',
      status: 'pending',
      dependencies: ['task-pages'],
      retries: 0,
      files: ['manifest.json'],
    },
  ];
}

function buildPalette(style: ProjectBrief['style']): {
  background: string;
  panel: string;
  accent: string;
  accentSoft: string;
  text: string;
  muted: string;
} {
  switch (style) {
    case 'bold':
      return {
        background: '#140c0c',
        panel: '#221515',
        accent: '#f97316',
        accentSoft: 'rgba(249,115,22,0.16)',
        text: '#fff7ed',
        muted: '#fdba74',
      };
    case 'minimal':
      return {
        background: '#f6f6f4',
        panel: '#ffffff',
        accent: '#0f172a',
        accentSoft: 'rgba(15,23,42,0.08)',
        text: '#111827',
        muted: '#64748b',
      };
    case 'playful':
      return {
        background: '#0f1020',
        panel: '#17192c',
        accent: '#f59e0b',
        accentSoft: 'rgba(245,158,11,0.14)',
        text: '#fff7ed',
        muted: '#fcd34d',
      };
    case 'dark':
      return {
        background: '#070b14',
        panel: '#101826',
        accent: '#38bdf8',
        accentSoft: 'rgba(56,189,248,0.14)',
        text: '#e0f2fe',
        muted: '#94a3b8',
      };
    case 'clean':
    default:
      return {
        background: '#08131d',
        panel: '#101b28',
        accent: '#14b8a6',
        accentSoft: 'rgba(20,184,166,0.14)',
        text: '#ecfeff',
        muted: '#99f6e4',
      };
  }
}

function buildPageHtml(brief: ProjectBrief, blueprint: Blueprint, page: BlueprintPage, index: number): string {
  const palette = buildPalette(brief.style);
  const links = blueprint.pages.map((entry) => {
    const slug = slugify(entry.name);
    return `<a class="nav-link ${entry.id === page.id ? 'active' : ''}" href="${slug}.html">${esc(entry.name)}</a>`;
  }).join('');

  const dataCards = blueprint.collections.length > 0
    ? blueprint.collections.map((collection) => `
      <article class="card">
        <span class="eyebrow">Collection</span>
        <h3>${esc(collection.name)}</h3>
        <p>${collection.fields.length} starter fields ready for schema editing.</p>
      </article>`).join('')
    : `
      <article class="card wide">
        <span class="eyebrow">Starter flow</span>
        <h3>Describe, refine, and export.</h3>
        <p>Add data collections to unlock schema-driven generation and richer previews.</p>
      </article>`;

  const authCard = brief.authNeeded
    ? `<article class="card"><span class="eyebrow">Access</span><h3>Authentication enabled</h3><p>Plan for sign-in, permissions, and session-aware pages.</p></article>`
    : `<article class="card"><span class="eyebrow">Access</span><h3>Open workflow</h3><p>This starter uses lightweight navigation with no auth wall.</p></article>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(brief.appName)} - ${esc(page.name)}</title>
  <style>
    :root {
      --bg: ${palette.background};
      --panel: ${palette.panel};
      --accent: ${palette.accent};
      --accent-soft: ${palette.accentSoft};
      --text: ${palette.text};
      --muted: ${palette.muted};
      --line: rgba(148, 163, 184, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Segoe UI", "Helvetica Neue", sans-serif;
      background:
        radial-gradient(circle at top left, rgba(255,255,255,0.08), transparent 25%),
        radial-gradient(circle at top right, var(--accent-soft), transparent 26%),
        var(--bg);
      color: var(--text);
    }
    .shell {
      max-width: 1160px;
      margin: 0 auto;
      padding: 32px 20px 48px;
    }
    .hero {
      padding: 28px;
      border-radius: 28px;
      background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02));
      border: 1px solid var(--line);
      box-shadow: 0 30px 60px rgba(2, 6, 23, 0.24);
    }
    .eyebrow {
      display: inline-block;
      margin-bottom: 12px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--muted);
    }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: clamp(2.4rem, 5vw, 4.6rem); line-height: 0.96; margin-bottom: 14px; }
    .hero p {
      max-width: 760px;
      color: rgba(255,255,255,0.72);
      font-size: 16px;
      line-height: 1.65;
    }
    .hero-grid {
      display: grid;
      grid-template-columns: 1.5fr 1fr;
      gap: 18px;
      margin-top: 22px;
    }
    .panel {
      padding: 18px;
      border-radius: 20px;
      background: rgba(2,6,23,0.24);
      border: 1px solid var(--line);
    }
    .nav {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 18px;
    }
    .nav-link {
      display: inline-flex;
      align-items: center;
      padding: 10px 14px;
      border-radius: 999px;
      text-decoration: none;
      color: rgba(255,255,255,0.72);
      background: rgba(255,255,255,0.04);
      border: 1px solid transparent;
      font-weight: 600;
    }
    .nav-link.active {
      color: white;
      border-color: rgba(255,255,255,0.12);
      background: var(--accent-soft);
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 14px;
      margin-top: 24px;
    }
    .stat {
      padding: 18px;
      border-radius: 20px;
      background: rgba(255,255,255,0.04);
      border: 1px solid var(--line);
    }
    .stat strong {
      display: block;
      font-size: 28px;
      margin-top: 10px;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-top: 24px;
    }
    .card {
      padding: 20px;
      border-radius: 22px;
      background: var(--panel);
      border: 1px solid var(--line);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
    }
    .card.wide { grid-column: span 2; }
    .card h3 { margin-bottom: 8px; }
    .card p { color: rgba(255,255,255,0.68); line-height: 1.6; }
    @media (max-width: 760px) {
      .shell { padding: 20px 14px 32px; }
      .hero { padding: 20px; border-radius: 22px; }
      .hero-grid { grid-template-columns: 1fr; }
      .card.wide { grid-column: span 1; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <span class="eyebrow">${esc(brief.target)} target / ${esc(page.name)}</span>
      <h1>${esc(brief.appName)}</h1>
      <p>${esc(brief.description)}</p>
      <div class="nav">${links}</div>
      <div class="hero-grid">
        <div class="panel">
          <span class="eyebrow">AI blueprint</span>
          <h2>${esc(page.name)} experience</h2>
          <p>This starter page is generated from the current SoftN Studio brief so the bundle has a live, navigable preview from the first pass.</p>
        </div>
        <div class="panel">
          <span class="eyebrow">Current focus</span>
          <h2>${index === 0 ? 'Primary entry page' : `Step ${index + 1} in navigation`}</h2>
          <p>${brief.authNeeded ? 'Authentication-aware flow is expected for production.' : 'Open access flow is currently assumed.'}</p>
        </div>
      </div>
      <div class="stats">
        <div class="stat"><span class="eyebrow">Pages</span><strong>${blueprint.pages.length}</strong></div>
        <div class="stat"><span class="eyebrow">Collections</span><strong>${blueprint.collections.length}</strong></div>
        <div class="stat"><span class="eyebrow">AI</span><strong>Configured</strong></div>
      </div>
      <div class="cards">
        ${dataCards}
        ${authCard}
      </div>
    </section>
  </main>
</body>
</html>`;
}

export function scaffoldProjectFiles(brief: ProjectBrief, blueprint: Blueprint): Array<{ path: string; content: string }> {
  const firstPage = blueprint.pages[0];
  const requirements = [
    `# ${brief.appName}`,
    '',
    brief.description,
    '',
    `- Target: ${brief.target}`,
    `- AI: bring your own API key`,
    `- Style: ${brief.style}`,
    `- Authentication: ${brief.authNeeded ? 'required' : 'not required'}`,
  ].join('\n');

  const files: Array<{ path: string; content: string }> = [
    {
      path: 'manifest.json',
      content: JSON.stringify({
        name: brief.appName,
        version: '1.0.0',
        entry: `pages/${slugify(firstPage.name)}.html`,
        target: brief.target,
        pages: blueprint.pages.map((page) => ({
          id: page.id,
          name: page.name,
          path: `pages/${slugify(page.name)}.html`,
          route: page.route,
        })),
      }, null, 2),
    },
    {
      path: 'builder/blueprint.json',
      content: JSON.stringify(blueprint, null, 2),
    },
    {
      path: 'builder/data-model.json',
      content: JSON.stringify({ collections: blueprint.collections }, null, 2),
    },
    {
      path: 'builder/requirements.md',
      content: requirements,
    },
    {
      path: 'builder/task-graph.json',
      content: JSON.stringify(generateTaskGraph(blueprint), null, 2),
    },
    {
      path: 'builder/component-map.json',
      content: JSON.stringify({
        pages: blueprint.pages.map((page) => ({
          id: page.id,
          path: `pages/${slugify(page.name)}.html`,
          components: page.components,
        })),
      }, null, 2),
    },
    {
      path: 'builder/generation-log.json',
      content: JSON.stringify([
        {
          type: 'architect',
          timestamp: new Date().toISOString(),
          message: 'Generated initial starter blueprint from the guided brief.',
        },
      ], null, 2),
    },
    {
      path: 'builder/provider-config.json',
      content: JSON.stringify({ perRoleModels: 'configured in settings' }, null, 2),
    },
    {
      // JSON.stringify, not a hand-quoted "..." — this interpolation lands
      // inside a JavaScript string literal in generated source, where an HTML
      // escaper is no help. An app name containing a quote closed the literal:
      // `x"); evil(); //` produced a logic file that ran evil(), and a name with
      // a newline in it produced one that would not parse at all.
      path: 'logic/app.logic',
      content: `function _init() {\n  console.log(${JSON.stringify(`${brief.appName} initialized`)});\n}\n`,
    },
  ];

  for (const [index, page] of blueprint.pages.entries()) {
    files.push({
      path: `pages/${slugify(page.name)}.html`,
      content: buildPageHtml(brief, blueprint, page, index),
    });
  }

  for (const collection of blueprint.collections) {
    files.push({
      path: `data/${slugify(collection.name)}.xdb`,
      content: JSON.stringify({
        collection: collection.name.toLowerCase(),
        records: collection.fields.length > 0
          ? [{
              id: '1',
              ...Object.fromEntries(collection.fields.filter((f) => f.name !== 'id').map((f) => [
                f.name,
                f.defaultValue ?? (f.type === 'number' ? 0 : f.type === 'boolean' ? false : f.type === 'date' ? new Date().toISOString().slice(0, 10) : ''),
              ])),
            }]
          : [],
      }, null, 2),
    });
  }

  return files;
}

export function resolveManifest(files: Map<string, VFSFile>): Record<string, unknown> | null {
  const manifestFile = files.get('manifest.json');
  if (!manifestFile || typeof manifestFile.content !== 'string') return null;

  try {
    return JSON.parse(manifestFile.content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function getPreviewablePaths(files: Map<string, VFSFile>): string[] {
  return Array.from(files.keys()).filter((path) => /\.(html|htm|md|txt|json|svg|png|jpg|jpeg|gif|webp|ui)$/i.test(path));
}

export function getBundleEntryPath(files: Map<string, VFSFile>): string | null {
  const manifest = resolveManifest(files);
  const manifestEntry = typeof manifest?.entry === 'string'
    ? manifest.entry
    : typeof manifest?.main === 'string'
      ? manifest.main
      : null;
  if (manifestEntry && files.has(manifestEntry)) return manifestEntry;

  if (files.has('ui/main.ui')) return 'ui/main.ui';
  if (files.has('pages/home.html')) return 'pages/home.html';

  const previewable = getPreviewablePaths(files);
  if (previewable.length === 0) return null;

  const uiFile = previewable.find((path) => /\.ui$/i.test(path));
  if (uiFile) return uiFile;

  const htmlFile = previewable.find((path) => /\.(html|htm)$/i.test(path));
  return htmlFile ?? previewable[0];
}

export function inferBlueprintFromFiles(projectName: string, files: Map<string, VFSFile>): Blueprint {
  const manifest = resolveManifest(files);
  const previewable = getPreviewablePaths(files);
  const pages = previewable
    .filter((path) => /\.(html|htm|ui)$/i.test(path))
    .map((path, index) => {
      const fileName = path.split('/').pop()?.replace(/\.(html|htm|ui)$/i, '') ?? `page-${index + 1}`;
      const slug = slugify(fileName);
      return {
        id: `${slug}-page`,
        name: titleCase(fileName),
        route: index === 0 ? '/' : `/${slug}`,
        layout: 'imported',
        components: ['imported-file'],
      };
    });

  const dataFiles = Array.from(files.keys())
    .filter((path) => /\.(xdb|json)$/i.test(path) && path !== 'manifest.json' && !path.startsWith('builder/'))
    .map((path) => ({
      id: `${slugify(path)}-collection`,
      name: titleCase(path.split('/').pop()?.replace(/\.(xdb|json)$/i, '') ?? path),
      fields: [],
      relationships: [],
    }));

  return {
    appName: typeof manifest?.name === 'string' ? manifest.name : projectName,
    target: manifest?.target === 'desktop' || manifest?.target === 'dual' ? manifest.target : 'web',
    style: 'clean',
    pages,
    collections: dataFiles,
    navigation: {
      type: pages.length > 4 ? 'sidebar' : 'tabs',
      items: pages.map((page) => page.name),
    },
    risks: ['Imported projects may not include builder metadata.'],
    assumptions: ['Preview is reconstructed from the bundle contents and manifest when available.'],
  };
}

export function inferBriefFromBlueprint(blueprint: Blueprint): ProjectBrief {
  return {
    appName: blueprint.appName,
    description: `Imported SoftN bundle for ${blueprint.appName}. Use AI to inspect, improve, and regenerate parts of the app without rewriting it from scratch.`,
    target: blueprint.target,
    pages: blueprint.pages.map((page) => page.name),
    collections: blueprint.collections.map((collection) => collection.name),
    authNeeded: blueprint.assumptions.some((item) => /auth/i.test(item)),
    style: blueprint.style,
    referenceImages: [],
  };
}
