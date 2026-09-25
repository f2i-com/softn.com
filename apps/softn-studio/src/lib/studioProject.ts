import type {
  AgentTask,
  Blueprint,
  BlueprintCollection,
  BlueprintPage,
  LogicLanguage,
  ProjectBrief,
  VFSFile,
} from '../types/studio';
import { PYTHON_PACKAGES, readPythonPackages } from '@softn/core';
import { isPrivatePath } from './paths';

/**
 * The Python packages a project asks the runtime for (today only `torch`).
 *
 * manifest.json decides, because it is what the composer and the runtime
 * read: `"config": { "python": { "packages": ["torch"] } }`. Only while there
 * is no manifest yet does the brief's choice stand. A manifest that is not
 * JSON, or whose declaration is malformed, declares nothing — the validator
 * and the preview are where that is reported.
 */
export function projectPythonPackages(
  files: ReadonlyMap<string, { content: string | Uint8Array }>,
  brief?: Pick<ProjectBrief, 'pythonPackages'> | null,
): string[] {
  const manifest = files.get('manifest.json');
  if (!manifest) return (brief?.pythonPackages ?? []).filter((name) => PYTHON_PACKAGES.includes(name));
  if (typeof manifest.content !== 'string') return [];
  try {
    return readPythonPackages(JSON.parse(manifest.content)).packages;
  } catch {
    return [];
  }
}

/**
 * manifest.json's text with `name` added to `config.python.packages`, keeping
 * everything else it says; `null` when the text is not a JSON object or the
 * name is not a package the runtime offers. Already declared: the text back
 * unchanged.
 */
export function declarePythonPackage(manifestText: string, name: string): string | null {
  if (!PYTHON_PACKAGES.includes(name)) return null;
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return null;
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  const record = manifest as Record<string, unknown>;
  const config = record.config && typeof record.config === 'object' && !Array.isArray(record.config)
    ? (record.config as Record<string, unknown>)
    : {};
  const python = config.python && typeof config.python === 'object' && !Array.isArray(config.python)
    ? (config.python as Record<string, unknown>)
    : {};
  const packages = Array.isArray(python.packages) ? python.packages.filter((p): p is string => typeof p === 'string') : [];
  if (packages.includes(name)) return manifestText;
  return JSON.stringify({ ...record, config: { ...config, python: { ...python, packages: [...packages, name] } } }, null, 2);
}

/**
 * The package a composer refusal is about, when the refusal is the one for a
 * Python file importing a package manifest.json does not declare — the one
 * refusal a single edit to the manifest fixes. `null` for anything else.
 */
export function undeclaredPythonPackage(message: string): string | null {
  const match = /\bimports (\w+), which an app asks for in manifest\.json/.exec(message);
  return match && PYTHON_PACKAGES.includes(match[1]) ? match[1] : null;
}

/**
 * The language a project's logic is in.
 *
 * The files decide when they can: the runtime reads a logic file's name and
 * nothing else, so a project whose logic is `.py` is Python whatever its
 * brief once said — an imported bundle has only an inferred brief, and a
 * project saved before the choice existed has no language in its brief at
 * all. When the files cannot decide — no logic yet, or both kinds, which the
 * validator refuses — the brief's choice stands, and without one, JavaScript.
 */
export function projectLogicLanguage(
  files: ReadonlyMap<string, unknown>,
  brief?: Pick<ProjectBrief, 'logicLanguage'> | null,
): LogicLanguage {
  let python = false;
  let javascript = false;
  for (const path of files.keys()) {
    if (isPrivatePath(path)) continue;
    const lower = path.toLowerCase();
    if (lower.endsWith('.py')) python = true;
    else if (lower.endsWith('.logic')) javascript = true;
  }
  if (python !== javascript) return python ? 'python' : 'javascript';
  return brief?.logicLanguage ?? 'javascript';
}

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
      files: ['ui/main.ui', ...pageSlugs(blueprint.pages).map((slug) => pageFileCandidates(slug)[0])],
    },
    {
      id: 'task-data',
      title: 'Seed data model',
      description: 'Create starter data files and relationship placeholders.',
      status: blueprint.collections.length > 0 ? 'complete' : 'skipped',
      dependencies: ['task-blueprint'],
      retries: 0,
      files: blueprint.collections.map((collection) => `xdb/${collectionKey(collection.name)}.xdb`),
    },
    {
      id: 'task-export',
      title: 'Prepare export bundle',
      description: 'Validate bundle shape for .softn download.',
      status: 'pending',
      dependencies: ['task-pages'],
      retries: 0,
      files: ['manifest.json', 'permission.json'],
    },
  ];
}

/** The App theme for a brief's style; the minimal style is the light one. */
function themeFor(style: ProjectBrief['style']): 'light' | 'dark' {
  return style === 'minimal' ? 'light' : 'dark';
}

/** The accent a style's headings wear. */
function accentFor(style: ProjectBrief['style']): string {
  switch (style) {
    case 'bold': return '#f97316';
    case 'minimal': return '#0f172a';
    case 'playful': return '#f59e0b';
    case 'dark': return '#38bdf8';
    case 'clean':
    default: return '#14b8a6';
  }
}

/**
 * A collection name as the directory's storage and a `<data>` alias both
 * accept: a letter, then letters, digits and underscores, at most 32.
 */
export function collectionKey(value: string): string {
  const key = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
  if (!key) return 'items';
  return /^[a-z]/.test(key) ? key : `c_${key}`.slice(0, 32);
}

/** A field name usable as `item.<name>` in a template; others are left out of the scaffold. */
const FIELD_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Text that goes into a .ui template as text: escaped like markup, and with
 * braces removed, since `{…}` in a template is an expression. Names the app
 * shows come through logic as data instead (see buildMainLogic); this is for
 * the few labels a page states in place.
 */
function uiText(value: unknown): string {
  return esc(String(value).replace(/[{}]/g, ''));
}

/**
 * Each page's slug, made unique when two names collapse to one.
 *
 * This is the one page-path rule. The scaffold writes `ui/pages/<slug>.ui`
 * with it; the pages panel and the validator find a page's file with it. They
 * used to have three copies that disagreed — the panel looked only in
 * `pages/` and `ui/`, so clicking a page of a project Studio had just created
 * found nothing and did nothing.
 */
export function pageSlugs(pages: readonly Pick<BlueprintPage, 'name'>[]): string[] {
  const seen = new Map<string, number>();
  return pages.map((page) => {
    const base = slugify(page.name);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n + 1}`;
  });
}

/**
 * The files a page with this slug may live in, in the order they are looked
 * for: where the scaffold writes it first, then the shapes an imported or
 * hand-made project uses.
 */
export function pageFileCandidates(slug: string): string[] {
  return [`ui/pages/${slug}.ui`, `ui/${slug}.ui`, `pages/${slug}.ui`, `pages/${slug}.html`, `pages/${slug}.htm`];
}

/** The file blueprint page `index` lives in, or null when the project has none of its candidates. */
export function findPageFile(
  files: ReadonlyMap<string, unknown>,
  pages: readonly Pick<BlueprintPage, 'name'>[],
  index: number,
): string | null {
  const slug = pageSlugs(pages)[index];
  if (slug === undefined) return null;
  return pageFileCandidates(slug).find((path) => files.has(path)) ?? null;
}

/** The component name a page file declares: an identifier, starting with a letter. */
function pageComponentName(slug: string): string {
  const base = titleCase(slug).replace(/[^A-Za-z0-9]/g, '');
  return /^[A-Za-z]/.test(base) ? `${base}Page` : `Page${base}`;
}

/** The `<data>` block binding every collection, the same on the shell and every page. */
function buildDataBlock(blueprint: Blueprint): string {
  if (blueprint.collections.length === 0) return '';
  const lines = blueprint.collections.map((c) => `  <collection name="${collectionKey(c.name)}" as="${collectionKey(c.name)}" />`);
  return `<data>\n${lines.join('\n')}\n</data>\n\n`;
}

/**
 * The app's shell: nav across the pages, and the page that is showing.
 *
 * What the user typed — the name, the description, the page labels — is not
 * written into the template at all. It is data in main.logic, and the
 * template reads it; a name that closes a tag or opens an expression is then
 * only ever a string.
 */
function buildMainUi(brief: ProjectBrief, blueprint: Blueprint, slugs: string[], logicPath: string): string {
  const imports = slugs.map((slug) => `<import ${pageComponentName(slug)} from="./pages/${slug}.ui" />`).join('\n');
  const switches = slugs
    .map((slug) => `      #if (page === ${JSON.stringify(slug)})\n        <${pageComponentName(slug)} />\n      #end`)
    .join('\n');
  return `${imports}

${buildDataBlock(blueprint)}<logic src="../${logicPath}" />

<App theme="${themeFor(brief.style)}" title={appName}>
  <Container size="lg">
    <Stack direction="vertical" gap="lg" padding="xl">
      <Stack direction="horizontal" gap="md" align="center" wrap>
        <Heading level={1} class="brand">{appName}</Heading>
        <Spacer />
        #each (item in pages)
          <Button variant={page === item.id ? "primary" : "ghost"} size="sm" @click={() => go(item.id)}>{item.label}</Button>
        #end
      </Stack>
      <Text variant="muted">{appDescription}</Text>
${switches}
    </Stack>
  </Container>
</App>

<style>
  .brand { color: ${accentFor(brief.style)}; }
</style>
`;
}

/**
 * One page: a component the shell imports. The first page lists every
 * collection.
 *
 * A bare template, nothing else: the runtime's composer replaces `<HomePage />`
 * in the shell with the imported file's text as it stands, so a `<component>`
 * declaration or a `<data>` block here would land inside the shell's tree and
 * fail to parse. The shell binds the collections; an inlined page sees them.
 */
function buildPageUi(blueprint: Blueprint, page: BlueprintPage, index: number): string {
  const label = uiText(page.name);
  const parts: string[] = [];
  parts.push(`<Stack direction="vertical" gap="md">\n  <Heading level={2}>${label}</Heading>`);
  if (index === 0) {
    parts.push(`  <Text variant="muted">The first page of the app. Describe to the AI what belongs here and it will build it out.</Text>`);
    for (const collection of blueprint.collections) {
      const key = collectionKey(collection.name);
      const fields = collection.fields.filter((f) => f.name !== 'id' && FIELD_IDENT.test(f.name)).slice(0, 4);
      // A record bound from a collection carries its fields under `data`;
      // `id` and the timestamps sit beside it.
      const cells = fields.length > 0
        ? fields.map((f) => `          <Text>{item.data.${f.name}}</Text>`).join('\n')
        : `          <Text>{JSON.stringify(item.data)}</Text>`;
      parts.push(`  <Card title="${uiText(collection.name)}">
    #each (item in ${key})
      <Stack direction="horizontal" gap="md" align="center" wrap>
${cells}
      </Stack>
    #empty
      <EmptyState title="Nothing here yet" description="Records in this collection will appear here." />
    #end
  </Card>`);
    }
  } else {
    parts.push(`  <Text variant="muted">A starting point. Describe to the AI what this page does and it will build it out.</Text>`);
    if (page.components.length > 0) {
      const items = page.components.map((c) => `      <ListItem>${uiText(c)}</ListItem>`).join('\n');
      parts.push(`  <Card title="Planned for this page">\n    <List>\n${items}\n    </List>\n  </Card>`);
    }
  }
  parts.push(`</Stack>\n`);
  return parts.join('\n');
}

/**
 * The app's state and the names it shows. Everything from the brief goes in
 * through JSON.stringify: this is generated JavaScript, where an HTML escaper
 * is no help, and a name carrying a quote once closed the literal it sat in.
 */
function buildMainLogic(brief: ProjectBrief, blueprint: Blueprint, slugs: string[]): string {
  const pages = blueprint.pages.map((page, i) => ({ id: slugs[i], label: page.name }));
  return [
    '// The app shell: which page is showing, and the names the shell displays.',
    `let appName = ${JSON.stringify(brief.appName)}`,
    `let appDescription = ${JSON.stringify(brief.description)}`,
    `let pages = ${JSON.stringify(pages)}`,
    `let page = ${JSON.stringify(slugs[0] ?? 'home')}`,
    '',
    'function go(id) {',
    '  page = id',
    '}',
    '',
    'function _init() {',
    '  console.log(appName + " initialized")',
    '}',
    '',
  ].join('\n');
}

/**
 * buildMainLogic in Python: the same state under the same names, so the one
 * shell template reads either, and `go` with the `global` a Python function
 * needs to assign module state.
 *
 * The brief's text goes in through JSON.stringify here too. That is valid
 * Python only because every value is a string, or a list of objects whose
 * values are strings: JSON's string escapes are Python's, and its `[…]` and
 * `{"k": …}` are Python's list and dict. A `true`, `false` or `null` would not
 * be — Python spells them `True`, `False` and `None` — so nothing else may be
 * written this way.
 */
function buildMainPython(brief: ProjectBrief, blueprint: Blueprint, slugs: string[]): string {
  const pages = blueprint.pages.map((page, i) => ({ id: slugs[i], label: page.name }));
  return [
    '# The app shell: which page is showing, and the names the shell displays.',
    '# Every top-level name is state the template reads; every def is a',
    '# function it can call.',
    `appName = ${JSON.stringify(brief.appName)}`,
    `appDescription = ${JSON.stringify(brief.description)}`,
    `pages = ${JSON.stringify(pages)}`,
    `page = ${JSON.stringify(slugs[0] ?? 'home')}`,
    '',
    '',
    'def go(page_id):',
    '    # Assigning a module-level name needs `global`, or Python makes a local.',
    '    global page',
    '    page = page_id',
    '',
  ].join('\n');
}

/**
 * A seed record per collection, in the flat form the runtime reads, with a
 * value in every field so the first page shows a row rather than a blank one.
 */
function buildXdb(collection: BlueprintCollection): string {
  const key = collectionKey(collection.name);
  const sample = (f: BlueprintCollection['fields'][number]): unknown => {
    if (f.defaultValue !== undefined) return f.defaultValue;
    if (f.type === 'number') return 1;
    if (f.type === 'boolean') return false;
    if (f.type === 'date') return new Date().toISOString().slice(0, 10);
    return `Sample ${f.name}`;
  };
  return JSON.stringify({
    collection: key,
    records: collection.fields.length > 0
      ? [{
          id: '1',
          ...Object.fromEntries(collection.fields.filter((f) => f.name !== 'id').map((f) => [f.name, sample(f)])),
        }]
      : [],
  }, null, 2);
}

/**
 * The starter project: a bundle the runtime opens and the directory takes,
 * plus Studio's own notes under builder/.
 *
 * It used to be HTML pages behind a manifest `entry` field — a shape nothing
 * else in SoftN read. The runtime and the directory read `main`, resolve
 * files by the manifest's groups, and run .ui; so that is what is written.
 *
 * The logic is `logic/main.logic` or, when the brief chose Python,
 * `logic/main.py`; the file's name is what tells the runtime which it is.
 */
export function scaffoldProjectFiles(brief: ProjectBrief, blueprint: Blueprint): Array<{ path: string; content: string }> {
  const slugs = pageSlugs(blueprint.pages);
  const pagePaths = slugs.map((slug) => pageFileCandidates(slug)[0]);
  const python = brief.logicLanguage === 'python';
  const logicPath = python ? 'logic/main.py' : 'logic/main.logic';
  const packages = python ? (brief.pythonPackages ?? []).filter((name) => PYTHON_PACKAGES.includes(name)) : [];
  const xdbPaths = blueprint.collections.map((c) => `xdb/${collectionKey(c.name)}.xdb`);
  const requirements = [
    `# ${brief.appName}`,
    '',
    brief.description,
    '',
    `- Target: ${brief.target}`,
    `- AI: bring your own API key`,
    `- Style: ${brief.style}`,
    `- Authentication: ${brief.authNeeded ? 'required' : 'not required'}`,
    `- Logic: ${python ? 'Python' : 'JavaScript'}`,
    ...(packages.length > 0 ? [`- Python packages: ${packages.join(', ')}`] : []),
  ].join('\n');

  const files: Array<{ path: string; content: string }> = [
    {
      path: 'manifest.json',
      content: JSON.stringify({
        name: brief.appName,
        version: '1.0.0',
        description: brief.description,
        main: 'ui/main.ui',
        target: brief.target,
        files: {
          ui: ['ui/main.ui', ...pagePaths],
          logic: [logicPath],
          xdb: xdbPaths,
          assets: [],
        },
        config: {
          theme: { mode: themeFor(brief.style) },
          // Declared only for Python: a JavaScript app cannot import a Python
          // package, and a declaration it cannot use would say otherwise.
          ...(packages.length > 0 ? { python: { packages } } : {}),
        },
        pages: blueprint.pages.map((page, i) => ({
          id: page.id,
          name: page.name,
          path: pagePaths[i],
          route: page.route,
        })),
      }, null, 2),
    },
    {
      // Nothing declared: the app gets no capability until this says
      // otherwise. The file is here so there is somewhere to say it.
      path: 'permission.json',
      content: JSON.stringify({ permissions: {} }, null, 2),
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
        pages: blueprint.pages.map((page, i) => ({
          id: page.id,
          path: pagePaths[i],
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
      path: logicPath,
      content: python ? buildMainPython(brief, blueprint, slugs) : buildMainLogic(brief, blueprint, slugs),
    },
    {
      path: 'ui/main.ui',
      content: buildMainUi(brief, blueprint, slugs, logicPath),
    },
  ];

  for (const [index, page] of blueprint.pages.entries()) {
    files.push({
      path: pagePaths[index],
      content: buildPageUi(blueprint, page, index),
    });
  }

  for (const [index, collection] of blueprint.collections.entries()) {
    files.push({ path: xdbPaths[index], content: buildXdb(collection) });
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

function getPreviewablePaths(files: Map<string, VFSFile>): string[] {
  return Array.from(files.keys()).filter((path) => /\.(html|htm|md|txt|json|svg|png|jpg|jpeg|gif|webp|ui)$/i.test(path));
}

export function getBundleEntryPath(files: Map<string, VFSFile>): string | null {
  const manifest = resolveManifest(files);
  // `main` is the runtime's field; `entry` is what Studio wrote before it
  // emitted runnable bundles, and is still honoured for projects saved then.
  const manifestEntry = typeof manifest?.main === 'string'
    ? manifest.main
    : typeof manifest?.entry === 'string'
      ? manifest.entry
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

/** Keep a local preview selection only while it still belongs to this VFS. */
export function resolveActivePreviewPath(
  files: Map<string, VFSFile>,
  currentPath: string | null,
  workspacePath: string | null
): string | null {
  if (workspacePath && files.has(workspacePath)) return workspacePath;
  if (currentPath && files.has(currentPath)) return currentPath;
  return getBundleEntryPath(files);
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
    .filter((path) => /\.(xdb|json)$/i.test(path) && path !== 'manifest.json' && path !== 'permission.json' && !path.startsWith('builder/'))
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

/**
 * A brief for a project that arrived without one. The language is the
 * project's own — pass `projectLogicLanguage(files)` — so a Python bundle is
 * edited in Python from the first turn.
 */
export function inferBriefFromBlueprint(blueprint: Blueprint, logicLanguage: LogicLanguage = 'javascript'): ProjectBrief {
  return {
    logicLanguage,
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
