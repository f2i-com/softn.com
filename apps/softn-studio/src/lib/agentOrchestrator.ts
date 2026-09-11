import { AIProviderError, sendAIRequest, type AIResponse } from './aiProvider';
import { useAIStore } from '../stores/aiStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useVFSStore } from '../stores/vfsStore';
import type { AIFailure, ChatMessage, ToolCallCard, VFSFile } from '../types/studio';
import { buildChangeset, describeDiff, diffSummary, toStoreRecords, type SuppliedFiles, type TurnBase } from './changeset';
import { isPrivatePath, resolveProjectPath } from './paths';

// The write checks live with the changeset that uses them; they are still
// reachable from here, where they were first written.
export { checkWrite, describeRefusal } from './changeset';
export type { SuppliedFile, SuppliedFiles, TurnBase, WriteRefusal } from './changeset';

// ---------------------------------------------------------------------------
// File‑block parsing
// ---------------------------------------------------------------------------

interface FileOp {
  /** The path as the reply wrote it; the changeset resolves and judges it. */
  path: string;
  content: string;
}

interface DeleteOp {
  path: string;
}

interface ReadOp {
  path: string;
}

export interface ParsedResponse {
  text: string;
  files: FileOp[];
  deletes: DeleteOp[];
  /** Files the model asks to see in full before it edits them. */
  reads: ReadOp[];
}

/**
 * Parse AI response text for file operation blocks.
 *
 * Supported formats:
 *   <softn-file path="pages/home.html">…content…</softn-file>
 *   <softn-delete path="old/file.html" />
 *   <softn-read path="logic/app.logic" />
 *
 * File and delete paths are kept as written: a path that is not a project
 * path is a refused record on the changeset, reported by name, not a block
 * that silently vanished. Read paths are resolved here, since a read is
 * answered from the VFS or not at all.
 */
export function parseAIResponse(raw: string): ParsedResponse {
  const files: FileOp[] = [];
  const deletes: DeleteOp[] = [];
  const reads: ReadOp[] = [];

  // Extract file blocks
  const fileRegex = /<softn-file\s+path="([^"]+)">([\s\S]*?)<\/softn-file>/g;
  let match: RegExpExecArray | null;
  while ((match = fileRegex.exec(raw)) !== null) {
    const path = match[1].trim();
    if (!path) continue;
    const content = match[2].replace(/^\n/, '').replace(/\n$/, '');
    if (content.length === 0) continue; // skip empty files
    files.push({ path, content });
  }

  // Extract delete directives
  const deleteRegex = /<softn-delete\s+path="([^"]+)"\s*\/>/g;
  while ((match = deleteRegex.exec(raw)) !== null) {
    const path = match[1].trim();
    if (!path) continue;
    deletes.push({ path });
  }

  // Extract read requests
  const readRegex = /<softn-read\s+path="([^"]+)"\s*\/>/g;
  while ((match = readRegex.exec(raw)) !== null) {
    const verdict = resolveProjectPath(match[1].trim());
    if (!verdict.ok || verdict.private) continue;
    const path = verdict.path;
    if (!reads.some((r) => r.path === path)) reads.push({ path });
  }

  // Build the user-facing text by stripping the blocks
  let text = raw
    .replace(fileRegex, '')
    .replace(deleteRegex, '')
    .replace(readRegex, '')
    .trim();

  // Clean up excessive blank lines left after stripping
  text = text.replace(/\n{3,}/g, '\n\n');

  return { text, files, deletes, reads };
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildFileTree(files: Map<string, VFSFile>): string {
  // Private editor state is not the model's to see or to write.
  const paths = Array.from(files.keys()).filter((p) => !isPrivatePath(p)).sort();
  if (paths.length === 0) return '(no files yet)';
  return paths.map((p) => `  ${p}`).join('\n');
}

export const MAX_CHARS_PER_FILE = 6000;
export const CONTEXT_CHAR_BUDGET = 80000;

/**
 * The project's text files for the prompt, within a per-file and an overall
 * character budget, and an exact record of what went in. A file over the
 * per-file cap is shown truncated and labelled so; one past the overall
 * budget is listed by name and size but not shown. The limits are not
 * relaxed here: a file the model needs whole is asked for with
 * `<softn-read>`, and supplied complete in the next round.
 */
export function buildFileContents(
  files: Map<string, VFSFile>,
  maxPerFile: number = MAX_CHARS_PER_FILE,
  budget: number = CONTEXT_CHAR_BUDGET,
  complete: ReadonlySet<string> = new Set(),
): { text: string; supplied: SuppliedFiles } {
  const parts: string[] = [];
  const supplied: SuppliedFiles = new Map();
  const notShown: string[] = [];
  let totalLen = 0;

  for (const [path, file] of files) {
    if (typeof file.content !== 'string') continue;
    // Skip builder/ internals — the AI can see the blueprint directly
    if (isPrivatePath(path)) continue;

    const total = file.content.length;
    // A file asked for whole is whole, whatever the caps; that is the point of asking.
    const wantWhole = complete.has(path);
    if (!wantWhole && totalLen > budget) {
      notShown.push(`${path} (${total} characters)`);
      continue;
    }
    const isComplete = wantWhole || total <= maxPerFile;
    const shown = isComplete ? total : maxPerFile;
    const content = isComplete ? file.content : file.content.slice(0, maxPerFile);
    const label = isComplete
      ? `--- ${path} (complete, ${total} characters) ---`
      : `--- ${path} (TRUNCATED: first ${maxPerFile} of ${total} characters; not editable as a whole — request it with <softn-read path="${path}" />) ---`;
    parts.push(`${label}\n${content}${isComplete ? '' : '\n... (truncated)'}`);
    supplied.set(path, { path, complete: isComplete, version: file.version, shown, total });
    totalLen += content.length;
  }

  if (notShown.length > 0) {
    parts.push(`--- Files not shown (over the context budget; request one with <softn-read path="…" />) ---\n${notShown.join('\n')}`);
  }

  return { text: parts.length > 0 ? parts.join('\n\n') : '(no text files)', supplied };
}

export function buildSystemPrompt(complete: ReadonlySet<string> = new Set()): string {
  return buildSystemPromptWithRecord(complete).system;
}

/**
 * The system prompt, the exact record of which files it supplies and how
 * much of each, and the version of every project file at this moment — the
 * base any operation in the reply is judged against.
 */
export function buildSystemPromptWithRecord(complete: ReadonlySet<string> = new Set()): { system: string } & TurnBase {
  const ws = useWorkspaceStore.getState();
  const vfs = useVFSStore.getState();
  const files = vfs.files;
  const contents = buildFileContents(files, MAX_CHARS_PER_FILE, CONTEXT_CHAR_BUDGET, complete);
  const versions = new Map<string, number>();
  for (const [path, file] of files) versions.set(path, file.version);

  const briefSection = ws.brief
    ? `## Current Brief
- App name: ${ws.brief.appName}
- Description: ${ws.brief.description}
- Target: ${ws.brief.target}
- Style: ${ws.brief.style}
- Pages: ${ws.brief.pages.join(', ') || 'none specified'}
- Collections: ${ws.brief.collections.join(', ') || 'none specified'}
- Auth: ${ws.brief.authNeeded ? 'required' : 'not required'}`
    : '## No brief loaded yet.';

  const blueprintSection = ws.blueprint
    ? `## Blueprint
- App: ${ws.blueprint.appName}
- Pages: ${ws.blueprint.pages.map((p) => `${p.name} (${p.route || '/'})`).join(', ')}
- Collections: ${ws.blueprint.collections.map((c) => `${c.name} [${c.fields.map((f) => f.name).join(', ')}]`).join('; ') || 'none'}
- Navigation: ${ws.blueprint.navigation.type}
- Style: ${ws.blueprint.style}`
    : '';

  const system = `You are the SoftN Studio AI — a code-generation assistant embedded in a visual app builder.

Your job is to create, edit, and improve files in the user's virtual file system (VFS). The user describes what they want in natural language, and you respond with explanations and file blocks.

## File Formats
SoftN Studio supports two page formats. Use **.ui** for component-driven apps (recommended) and **.html** for standalone pages.

- **.ui** — SoftN UI markup. XML-like component tree rendered by @softn/core. The preferred format.
- **.html** — Standard HTML with inline CSS and JS. Good for simple or self-contained pages.
- **.logic** — JavaScript, run in a sandboxed VM. Imported by .ui files for shared logic.
- **.xdb** — Data collections. JSON with \`{ "collection": "name", "records": [...] }\`.
- **manifest.json** — The bundle's manifest: \`name\`, \`version\`, \`description\`, \`main\` (the entry .ui file), and \`files\` listing every file by group (\`ui\`, \`logic\`, \`xdb\`, \`assets\`). The runtime resolves files by these groups.
- **permission.json** — What the app may use: \`{ "permissions": { "net": { "enabled": true }, "storage": { "enabled": true } } }\`. Capabilities: net, camera, mic, files, qr, ai, gpu, sync, storage, accel. An app declares only what it calls; nothing declared is nothing granted.
- **.json** — Other config and data files.
- **.css / .js / .ts / .tsx** — Standard web files, used alongside .html pages.

## How to Create or Update Files
Wrap file content in \`<softn-file>\` blocks. Every block creates or overwrites the file at the given path.

<softn-file path="ui/main.ui">
...file content...
</softn-file>

Include multiple file blocks in one response when needed. To delete a file:

<softn-delete path="old/page.html" />

A file block replaces the whole file, so only write one for a file you have seen **complete**. A file shown TRUNCATED, or listed as not shown, cannot be replaced from what you have: ask for it first and it is supplied whole in the next message —

<softn-read path="logic/app.logic" />

A file block for a truncated or unseen file is refused and nothing is written.

---

## SoftN UI (.ui) Syntax Reference

A .ui file has these sections in order: imports, component declaration, data, logic, template, style.

### Document Structure

\`\`\`xml
<!-- 1. Imports (optional) -->
<import TodoItem from="./components/TodoItem.ui" />
<import { formatDate } from="./utils.logic" />

<!-- 2. Component declaration (optional — only for reusable components) -->
<component name="MyComponent">
  <prop name="title" propType="string" required={true} />
  <prop name="onSave" propType="function" />
  <slot name="default" />
</component>

<!-- 3. Data block — bind to XDB collections (optional) -->
<data>
  <collection name="tasks" as="tasks" sort="createdAt:desc" />
</data>

<!-- 4. Logic block — JavaScript (optional) -->
<logic>
  let count = 0
  function increment() {
    count = count + 1
  }
</logic>

<!-- 5. Template — the component tree (required) -->
<App theme="dark">
  <Stack direction="vertical" gap="md">
    <Heading level={1}>My App</Heading>
    <Text>Count: {count}</Text>
    <Button @click={increment}>Add one</Button>
  </Stack>
</App>

<!-- 6. Scoped styles (optional) -->
<style>
  .custom { color: blue; }
</style>
\`\`\`

### Props and Values

\`\`\`xml
<Button label="Click me" />             <!-- string -->
<Slider min={0} max={100} />            <!-- number -->
<Input disabled />                       <!-- boolean true -->
<Button label={myVar} />                 <!-- variable -->
<Box color={dark ? "#fff" : "#000"} />   <!-- expression -->
<Stack style={{ padding: "1rem" }} />    <!-- object -->
\`\`\`

### Data Binding (two-way with colon prefix)

\`\`\`xml
<Input :value={username} />
<Checkbox :checked={isActive} />
<Select :value={selectedOption} />
\`\`\`

### Event Handlers (@ prefix)

\`\`\`xml
<Button @click={handleClick} />
<Button @click={() => count = count + 1} />
<Form @submit={handleSubmit} />
<Input @change={(e) => name = e.target.value} />
\`\`\`

### Control Flow

\`\`\`xml
<!-- Conditionals -->
#if (items.length > 0)
  <List>
    ...
  </List>
#else
  <EmptyState title="No items yet" />
#end

<!-- Loops -->
#each (item in items)
  <Card>
    <Heading level={3}>{item.title}</Heading>
    <Text>{item.description}</Text>
  </Card>
#empty
  <Text>Nothing here</Text>
#end

<!-- Loop with index -->
#each (task in tasks; let i)
  <Text>{i + 1}. {task.name}</Text>
#end
\`\`\`

### Inline Conditionals and Loops

\`\`\`xml
<Box if={showPanel}>Only visible when showPanel is true</Box>
<Card each={items} as="item">{item.name}</Card>
\`\`\`

### Expression Interpolation

\`\`\`xml
<Text>Hello {name}</Text>
<Text>{user.firstName} {user.lastName}</Text>
<Badge>{isActive ? "Active" : "Inactive"}</Badge>
<Text>{formatDate(createdAt)}</Text>
\`\`\`

### Class Binding

\`\`\`xml
<div class="container" />
<div class:active={isActive} />
<div class="box" class:highlighted={selected} class:disabled={!enabled} />
\`\`\`

### Slots (for reusable components)

\`\`\`xml
<!-- In component definition: -->
<slot />                              <!-- default slot -->
<slot name="header" />                <!-- named slot -->
<slot name="footer">Fallback</slot>   <!-- with fallback -->

<!-- When using the component: -->
<MyComponent>
  <template slot="header">Header content</template>
  Default slot content here
  <template slot="footer">Footer content</template>
</MyComponent>
\`\`\`

### External Logic

\`\`\`xml
<!-- Reference a .logic file instead of inline -->
<logic src="./app.logic" />
\`\`\`

### Built-in Components

**Layout:** App, Stack, Box, Card, Grid, Container, Divider, Spacer, Center, Sidebar, Split, Layout, Header, Content, Section
**Form:** Button, Input, Form, TextArea, Select, Checkbox, Switch, Radio, Slider, DatePicker, ColorPicker, FileChooser
**Display:** Text, Heading, Badge, Tag, Avatar, Progress, Spinner, Image, Icon
**Feedback:** Alert, Modal, Toast, Drawer, Popover, EmptyState
**Data:** List, ListItem, Table, TreeView, Pagination, DataGrid
**Navigation:** Tabs, Breadcrumb, Menu, NavItem
**Utility:** Accordion, Collapse, Tooltip, Loop, PixelGrid, PixelCanvas, DPad
**Charts:** LineChart, BarChart, PieChart, AreaChart, RadarChart, GaugeChart
**Animation:** AnimatedBox, AnimatedNumber, Marquee, Typewriter, Draggable, SortableList, PanView, Sprite, TileMap
**Editors:** CodeEditor, MarkdownEditor, RichTextEditor
**3D & Games:** Scene3D (Three.js with box, sphere, cylinder, capsule, prism, torus, cone, plane, group, particles, instanced, model)
**Smart:** SmartGrid, SmartView, SmartForm, SmartStats, SmartCards, SmartList, SmartTimeline

### 3D Graphics and Game Development (<Scene3D>)

Use \`<Scene3D>\` to build 3D scenes, dioramas, and games:
- **Shapes:** \`box\`, \`sphere\`, \`cylinder\`, \`capsule\`, \`prism\` (triangular roof/wedge), \`cone\`, \`torus\`, \`plane\`.
- **Hierarchical Groups (\`type: 'group'\`):** Define composite models with \`children: [...]\`. Child transforms are local to parent group. Moving the parent moves all parts together seamlessly with zero trigonometry or clipping!
- **Particles (\`type: 'particles'\`):** \`particlePositions: [x, y, z, ...]\`, \`particleSize: 0.3\`, \`color: "#fff"\`, \`opacity: 0.8\`. High-speed steam, smoke, rain, sparks.
- **Materials:** \`color\`, \`emissive\`, \`emissiveIntensity\`, \`roughness\`, \`metalness\`, \`opacity\`, \`wireframe\`, \`flatShading\` (for crisp low-poly diorama aesthetic).
- **Interactive Cursor:** Set \`cursor: "pointer"\` or \`interactive: true\` on interactive objects (levers, switches, buttons).
- **Local Animations:** \`animate: { rotateY: 0.05, floatAmplitude: 0.2 }\` runs smoothly in the Three.js loop.
- **Game Loops:** \`<Loop interval={33} running={true} @tick={gameStep} />\` drives 30/60fps simulation updates.

### Common Component Props

\`\`\`xml
<App theme="dark" title="My App">           <!-- App wrapper with theme -->
<Stack direction="vertical" gap="md">        <!-- vertical | horizontal; gap: xs sm md lg xl -->
<Box padding="lg" rounded shadow>            <!-- layout box -->
<Grid columns={3} gap="md">                  <!-- CSS grid -->
<Card title="Section" subtitle="Info">       <!-- card with header -->
<Heading level={1}>Title</Heading>           <!-- h1-h6 -->
<Text size="sm" color="muted">Note</Text>    <!-- text with sizing -->
<Button variant="primary" size="lg">Go</Button>  <!-- primary | secondary | ghost | danger -->
<Input label="Email" placeholder="you@example.com" type="email" />
<Select label="Role" options={["Admin","User"]} />
<Badge variant="success">Active</Badge>      <!-- success | warning | danger | info -->
<Alert type="info" title="Note">Message</Alert>
<Modal open={showModal} title="Confirm" @close={() => showModal = false}>Content</Modal>
<Tabs items={["Tab 1","Tab 2"]} :activeIndex={activeTab} />
<Table columns={["Name","Email"]} rows={users} />
<EmptyState title="No data" description="Get started by adding items" icon="inbox" />
<Progress value={75} max={100} />
<Image src="photo.jpg" alt="Photo" width={200} />
\`\`\`

---

## .logic Syntax

.logic is JavaScript, executed by a sandboxed engine — no \`eval\`, no \`new Function\`, and no host
access beyond the modules listed below. Used inside \`<logic>\` blocks or standalone \`.logic\` files.

\`\`\`javascript
// Variables
let count = 0
const name = "John"

// Functions
function greet(who) {
  return "Hello " + who
}

// Arrow functions
const double = (x) => x * 2

// Objects and arrays
let user = { name: "Alice", age: 30 }
let items = [1, 2, 3]

// Array methods: map, filter, forEach, find, reduce, includes, push, pop, splice, sort
let names = users.map((u) => u.name)
let active = users.filter((u) => u.active)

// String methods: split, trim, includes, startsWith, endsWith, replace, toLowerCase, toUpperCase
let parts = "hello world".split(" ")

// Conditionals
if (count > 10) {
  status = "high"
} else if (count > 0) {
  status = "low"
} else {
  status = "zero"
}

// Loops
for (let i = 0; i < items.length; i = i + 1) {
  total = total + items[i]
}
for (let item of items) {
  process(item)
}

// Template literals
let msg = \\\`Hello \\\${name}, you have \\\${count} items\\\`

// JSON
let data = JSON.parse(text)
let text = JSON.stringify(obj)

// Math: Math.floor, Math.ceil, Math.round, Math.random, Math.max, Math.min, Math.abs
let id = Math.floor(Math.random() * 10000)

// Date
let now = Date.now()
let d = new Date()

// console.log for debugging
console.log("debug:", value)
\`\`\`

---

## XDB Data Files (.xdb)

\`\`\`json
{
  "collection": "tasks",
  "records": [
    { "id": "1", "title": "Buy groceries", "status": "pending", "updatedAt": "2025-01-15" },
    { "id": "2", "title": "Clean house", "status": "done", "updatedAt": "2025-01-14" }
  ]
}
\`\`\`

Bind to collections in .ui files with \`<data><collection name="tasks" as="tasks" /></data>\`.
A record bound from a collection carries its fields under \`data\` — \`{item.data.title}\`, not \`{item.title}\` — with \`id\`, \`created_at\` and \`updated_at\` beside it. Records the logic pushes itself are whatever shape it pushed.

---

## Complete .ui App Example

Here is a minimal but complete todo app in .ui format:

\`\`\`xml
<data>
  <collection name="tasks" as="tasks" />
</data>

<logic>
  let newTask = ""
  let filter = "all"

  function addTask() {
    if (newTask.trim() === "") return
    tasks.push({
      id: String(Date.now()),
      title: newTask,
      done: false
    })
    newTask = ""
  }

  function toggleTask(id) {
    let task = tasks.find((t) => t.id === id)
    if (task) task.done = !task.done
  }

  function deleteTask(id) {
    tasks = tasks.filter((t) => t.id !== id)
  }

  function filtered() {
    if (filter === "active") return tasks.filter((t) => !t.done)
    if (filter === "done") return tasks.filter((t) => t.done)
    return tasks
  }
</logic>

<App theme="dark" title="Tasks">
  <Container maxWidth="600px">
    <Stack direction="vertical" gap="lg" padding="xl">
      <Heading level={1}>Tasks</Heading>

      <Stack direction="horizontal" gap="sm">
        <Input :value={newTask} placeholder="What needs to be done?" @keydown={(e) => { if (e.key === "Enter") addTask() }} />
        <Button @click={addTask} variant="primary">Add</Button>
      </Stack>

      <Tabs items={["All", "Active", "Done"]} @change={(tab) => { filter = tab.toLowerCase() }} />

      #each (task in filtered())
        <Card>
          <Stack direction="horizontal" gap="md" align="center">
            <Checkbox :checked={task.done} @change={() => toggleTask(task.id)} />
            <Text style={{ flex: 1, textDecoration: task.done ? "line-through" : "none" }}>{task.title}</Text>
            <Button variant="ghost" size="sm" @click={() => deleteTask(task.id)}>Delete</Button>
          </Stack>
        </Card>
      #empty
        <EmptyState title="No tasks" description="Add a task to get started" />
      #end

      <Text size="sm" color="muted">{tasks.filter((t) => !t.done).length} remaining</Text>
    </Stack>
  </Container>
</App>

<style>
  .container { min-height: 100vh; }
</style>
\`\`\`

---

## Guidelines
- **Prefer .ui format** for new apps. Use .html only when the user specifically asks for it or for simple standalone pages.
- Always produce complete, self-contained file content (not diffs or fragments).
- Match the visual style from the brief: ${ws.brief?.style || 'clean'}.
- Pages should be responsive and polished — production quality, not placeholder wireframes.
- When editing an existing file, reproduce the full file with your changes applied.
- Keep explanations concise. Focus on what you changed and why.
- If the user asks about the project without requesting changes, respond conversationally — no file blocks needed.
- Keep manifest.json true: \`"main"\` names the entry .ui file (e.g. \`"main": "ui/main.ui"\`), and \`"files"\` lists every .ui, .logic, .xdb and asset you create, by group. Never write an \`entry\` field; the runtime does not read it.
- When logic calls \`softn.net\`, \`softn.storage\`, the camera, the microphone or another capability, declare it in permission.json in the same response; an undeclared call fails.
- Create reusable components in separate .ui files and import them.
- Use \`<data>\` blocks to bind XDB collections so the app has live data.

${briefSection}

${blueprintSection}

## Current File Tree
${buildFileTree(files)}

## Current File Contents
${contents.text}
`;
  return { system, supplied: contents.supplied, versions };
}

// ---------------------------------------------------------------------------
// Agent orchestrator — runs a single user turn
// ---------------------------------------------------------------------------

interface ActiveAgentTurn {
  controller: AbortController;
  /** The transaction id every commit of this turn is recorded under. */
  id: string;
}

let activeAgentTurn: ActiveAgentTurn | null = null;

/** How many times one turn may answer a `<softn-read>` before it has to stop asking. */
export const MAX_READ_ROUNDS = 3;

export function abortAgentTurn(): void {
  const turn = activeAgentTurn;
  activeAgentTurn = null;
  turn?.controller.abort();
  useAIStore.getState().setAgentState('idle');
  useAIStore.getState().setCurrentStep('');
}

/** A rough token count for the budget check: four characters per token, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

type AIStoreState = ReturnType<typeof useAIStore.getState>;
type WorkspaceState = ReturnType<typeof useWorkspaceStore.getState>;

/**
 * Stage a reply's operations, judge them, and commit them as one VFS
 * transaction under the turn's id — or, if any record is refused, commit
 * nothing and report every record's verdict, so the person can see what
 * was held back and why. Nothing is written by halves.
 */
function applyChangeset(
  parsed: ParsedResponse,
  base: TurnBase,
  turnId: string,
  ai: AIStoreState,
  ws: WorkspaceState,
): { toolCalls: ToolCallCard[]; committed: string[]; deleted: string[] } {
  const toolCalls: ToolCallCard[] = [];
  if (parsed.files.length === 0 && parsed.deletes.length === 0) return { toolCalls, committed: [], deleted: [] };

  const vfs = useVFSStore.getState();
  const changeset = buildChangeset(turnId, parsed, base, vfs.files);
  const toolFor = (op: 'create' | 'update' | 'delete') => (op === 'delete' ? 'deleteFile' : op === 'update' ? 'updateFile' : 'createFile');
  const argsFor = (record: (typeof changeset.records)[number]) => ({
    path: record.path,
    requestedPath: record.requestedPath,
    op: record.op,
    baseVersion: record.baseVersion,
  });

  if (!changeset.ok) {
    const refused = changeset.records.filter((r) => !r.verdict.ok).length;
    for (const record of changeset.records) {
      const result = record.verdict.ok
        ? `Held back: this operation was valid, but ${refused === 1 ? 'another operation' : `${refused} other operations`} in the same reply ${refused === 1 ? 'was' : 'were'} refused, and a reply is applied whole or not at all. Nothing was written.`
        : record.verdict.reason;
      toolCalls.push({ tool: toolFor(record.op), args: argsFor(record), result, status: 'error' });
      ws.addConsoleOutput(`[AI] ${result}`);
    }
    return { toolCalls, committed: [], deleted: [] };
  }

  // Before-images for the cards, read before the commit.
  const before = new Map(changeset.records.map((r) => [r.path, vfs.files.get(r.path)?.content ?? null]));
  try {
    vfs.applyTransaction(toStoreRecords(changeset), 'ai', changeset.id);
  } catch (err) {
    // The store's own check disagreed with the changeset's; it wrote nothing.
    const result = `Failed: ${err instanceof Error ? err.message : String(err)}. Nothing was written.`;
    for (const record of changeset.records) toolCalls.push({ tool: toolFor(record.op), args: argsFor(record), result, status: 'error' });
    ws.addConsoleOutput(`[AI] ${result}`);
    return { toolCalls, committed: [], deleted: [] };
  }

  const committed: string[] = [];
  const deleted: string[] = [];
  for (const record of changeset.records) {
    ai.incrementFilesChanged();
    if (record.op === 'delete') {
      deleted.push(record.path);
      const summary = describeDiff(diffSummary(before.get(record.path), null));
      toolCalls.push({ tool: 'deleteFile', args: argsFor(record), result: `Deleted ${record.path} (${summary})`, status: 'success' });
      ws.addConsoleOutput(`[AI] Deleted ${record.path}`);
      continue;
    }
    committed.push(record.path);
    const summary = describeDiff(diffSummary(before.get(record.path), record.content ?? ''));
    const verb = record.op === 'update' ? 'Updated' : 'Created';
    toolCalls.push({
      tool: toolFor(record.op),
      args: argsFor(record),
      result: `${verb} ${record.path} (${summary}, ${record.content?.length ?? 0} chars)`,
      status: 'success',
    });
    ws.addConsoleOutput(`[AI] ${verb} ${record.path}`);
  }
  return { toolCalls, committed, deleted };
}

/**
 * A reply that is not complete is not applied, whatever it contains: a
 * reply cut at the output limit ends wherever the limit fell, and the last
 * file block in it may be any fraction of a file that looks whole.
 */
function describeIncomplete(response: AIResponse, parsed: ParsedResponse, maxOutputTokens: number): { failure: AIFailure; card: ToolCallCard | null } {
  const paths = [...parsed.files.map((f) => f.path), ...parsed.deletes.map((d) => d.path)];
  const at = Date.now();
  switch (response.status) {
    case 'truncated': {
      const message = `The reply was cut off at the output limit (${maxOutputTokens.toLocaleString()} tokens) before it finished${paths.length > 0 ? `, so its ${paths.length} file operation(s) may be incomplete` : ''}. Nothing was written. Ask for a smaller change, or split the work across turns.`;
      return {
        failure: { kind: 'truncated', message, at },
        card: paths.length > 0 ? { tool: 'changeset', args: { paths, stopReason: response.stopReason }, result: `Not applied: ${message}`, status: 'error' } : null,
      };
    }
    case 'refused':
      return { failure: { kind: 'refused', message: 'The model declined this request. Nothing was written.', at }, card: null };
    case 'empty':
    default:
      return { failure: { kind: 'empty', message: 'The provider returned no text. Nothing was written.', at }, card: null };
  }
}

/** A thrown request failure as something the person can act on. */
function describeFailure(err: unknown): AIFailure {
  const at = Date.now();
  if (err instanceof AIProviderError) {
    switch (err.kind) {
      case 'timeout':
        return { kind: 'timeout', message: `${err.message} Nothing was changed. Try again; a slower provider may need a longer request timeout.`, at };
      case 'rate-limited':
        return {
          kind: 'rate-limited',
          message: `${err.message} Nothing was changed.${err.retryAfterMs !== undefined ? ` Try again in ${Math.ceil(err.retryAfterMs / 1000)} s.` : ' Try again in a moment.'}`,
          retryAfterMs: err.retryAfterMs,
          at,
        };
      case 'network':
        return { kind: 'network', message: `${err.message} Nothing was changed. Check the connection and the provider URL in Settings.`, at };
      case 'invalid-response':
        return { kind: 'invalid-response', message: `${err.message}. Nothing was changed.`, at };
      case 'cancelled':
        return { kind: 'cancelled', message: err.message, at };
      case 'http':
      default:
        return { kind: 'provider', message: `${err.message}\n\nCheck your API key and provider settings.`, at };
    }
  }
  const text = err instanceof Error ? err.message : String(err);
  return { kind: 'provider', message: `Error: ${text}\n\nCheck your API key and provider settings.`, at };
}

export async function runAgentTurn(): Promise<void> {
  const ai = useAIStore.getState();

  // Guard against concurrent calls (React state may not have propagated yet)
  if (ai.agentState !== 'idle') return;

  const ws = useWorkspaceStore.getState();

  // Resolve provider
  const provider = ai.providers.find((p) => p.id === ai.activeProviderId) ?? ai.providers[0];
  if (!provider) {
    ai.addMessage({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: 'No AI provider configured. Open Settings to add your API key.',
      timestamp: Date.now(),
    });
    return;
  }

  // Budget checks
  if (ai.iterationsUsed >= ai.maxIterations) {
    ai.addMessage({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: `Iteration limit reached (${ai.maxIterations}). Reset the budget in Settings to continue.`,
      timestamp: Date.now(),
    });
    return;
  }
  if (ai.tokensUsed >= ai.tokenBudget) {
    ai.addMessage({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: `Token budget exhausted (${ai.tokenBudget.toLocaleString()} tokens). Reset the budget in Settings to continue.`,
      timestamp: Date.now(),
    });
    return;
  }

  // Set agent state
  ai.setLastFailure(null);
  ai.setAgentState('building');
  ai.setCurrentStep('Generating response...');
  ai.incrementIteration();

  // Build conversation history for the API (last N messages for context window)
  // Note: the caller (AIChat) already added the user message to the store before
  // invoking runAgentTurn, so ai.messages already includes it — no need to push again.
  const recentMessages = ai.messages.slice(-20).map((m) => ({
    id: m.id,
    role: m.role as 'user' | 'assistant',
    content: m.content,
    timestamp: m.timestamp,
  }));

  const turn: ActiveAgentTurn = { controller: new AbortController(), id: crypto.randomUUID() };
  activeAgentTurn = turn;

  try {
    const builderModel = ai.modelProfile.builder || undefined;
    const toolCalls: ToolCallCard[] = [];
    const texts: string[] = [];
    let usage = { input: 0, output: 0 };
    let committedCount = 0;
    let firstWritten: string | null = null;
    let rawFallback = '';

    // Files the model has asked to see whole. Each round rebuilds the prompt
    // with those supplied complete, so the record of what it saw is exact.
    const complete = new Set<string>();
    const conversation = [...recentMessages];

    for (let round = 0; ; round++) {
      const base = buildSystemPromptWithRecord(complete);

      // Reserve the reply before sending. The budget is a local guardrail:
      // it counts what providers report, and refuses a request that the
      // remainder cannot cover at the size a reply may reach. It is not a
      // billing cap — the provider bills what it bills.
      const settings = useAIStore.getState();
      const estimatedInput = estimateTokens(base.system) + conversation.reduce((n, m) => n + estimateTokens(m.content), 0);
      const reserved = settings.maxOutputTokens;
      const remaining = settings.tokenBudget - settings.tokensUsed;
      if (estimatedInput + reserved > remaining) {
        const message =
          `Not sent: this request needs roughly ${(estimatedInput + reserved).toLocaleString()} tokens (about ${estimatedInput.toLocaleString()} in, up to ${reserved.toLocaleString()} reserved for the reply), and ${Math.max(0, remaining).toLocaleString()} of the ${settings.tokenBudget.toLocaleString()}-token session budget remain. ` +
          'The budget is a local guardrail, not a billing cap: raise or reset it in Settings.' +
          (round > 0 ? ' The files the model asked for could not be supplied.' : '');
        ai.setLastFailure({ kind: 'budget', message, at: Date.now() });
        texts.push(message);
        ws.addConsoleOutput(`[AI] ${message}`);
        break;
      }

      const response = await sendAIRequest(provider, {
        messages: conversation,
        system: base.system,
        signal: turn.controller.signal,
        modelOverride: builderModel,
        timeoutMs: settings.requestTimeoutMs,
        maxOutputTokens: settings.maxOutputTokens,
      });

      // A provider or test double is not required to honour AbortSignal. The
      // response still belongs to the project/turn that initiated it, so never
      // apply it after that turn has been cancelled or replaced.
      if (activeAgentTurn !== turn || turn.controller.signal.aborted) return;

      // Track tokens
      ai.addTokens(response.usage.inputTokens + response.usage.outputTokens);
      usage = { input: usage.input + response.usage.inputTokens, output: usage.output + response.usage.outputTokens };
      rawFallback = response.content;

      // Parse the response for file operations
      const parsed = parseAIResponse(response.content);
      if (parsed.text) texts.push(parsed.text);

      // Only a complete reply is applied. A truncated one is reported and the
      // turn stops here: its file blocks are not trusted, and a read round on
      // top of a cut reply would be built on the same cut.
      if (response.status !== 'complete') {
        const { failure, card } = describeIncomplete(response, parsed, settings.maxOutputTokens);
        if (card) toolCalls.push(card);
        ai.setLastFailure(failure);
        if (!parsed.text) texts.push(failure.message);
        ws.addConsoleOutput(`[AI] ${failure.message}`);
        break;
      }

      const applied = applyChangeset(parsed, base, turn.id, ai, ws);
      toolCalls.push(...applied.toolCalls);
      committedCount += applied.committed.length + applied.deleted.length;
      if (firstWritten === null && applied.committed.length > 0) firstWritten = applied.committed[0];

      // The model asked to see files whole. Answer with them and go again,
      // a bounded number of times; a reply that only asks is not the end of
      // the turn, and a reply that asks after writing gets its answer too.
      const wanted = parsed.reads.map((r) => r.path).filter((p) => !complete.has(p));
      if (wanted.length === 0 || round >= MAX_READ_ROUNDS - 1) {
        if (wanted.length > 0) {
          toolCalls.push({ tool: 'readFile', args: { paths: wanted }, result: `Not supplied: this turn has already answered ${MAX_READ_ROUNDS} read requests. Ask again in a new message.`, status: 'error' });
        }
        break;
      }
      const vfsNow = useVFSStore.getState().files;
      const answers: string[] = [];
      for (const path of wanted) {
        const file = vfsNow.get(path);
        if (!file || typeof file.content !== 'string') {
          answers.push(`--- ${path} ---\n(no such text file)`);
          toolCalls.push({ tool: 'readFile', args: { path }, result: `No such text file: ${path}`, status: 'error' });
          continue;
        }
        complete.add(path);
        answers.push(`--- ${path} (complete, ${file.content.length} characters) ---\n${file.content}`);
        toolCalls.push({ tool: 'readFile', args: { path }, result: `Supplied ${path} whole (${file.content.length} chars)`, status: 'success' });
      }
      ai.setCurrentStep(`Reading ${wanted.join(', ')}…`);
      conversation.push({ id: crypto.randomUUID(), role: 'assistant', content: response.content, timestamp: Date.now() });
      conversation.push({
        id: crypto.randomUUID(),
        role: 'user',
        content: `Here are the files you asked for, complete. They are also in the system prompt now, marked complete. Continue with the original request.\n\n${answers.join('\n\n')}`,
        timestamp: Date.now(),
      });
    }

    // Anything committed — a deletion as much as a write — is unsaved work.
    if (committedCount > 0) {
      if (firstWritten !== null) ws.setActiveFilePath(firstWritten);
      ws.setDirty(true);
      if (ws.mode === 'describe') {
        ws.setMode('design');
      }
    }

    // Add the AI response message
    const text = texts.join('\n\n');
    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: text || (committedCount > 0 ? `Changed ${committedCount} file(s).` : rawFallback),
      timestamp: Date.now(),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      tokens: usage,
      transactionId: committedCount > 0 ? turn.id : undefined,
    };
    ai.addMessage(assistantMsg);
    ai.setAgentState('idle');
    ai.setCurrentStep('');

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const superseded = activeAgentTurn !== turn;
    const cancelled = err instanceof AIProviderError && err.kind === 'cancelled';

    // Don't let a cancelled turn overwrite the state of the turn that
    // replaced it. Fetch implementations differ in the exact AbortError text,
    // so the signal/ownership checks are authoritative.
    if (turn.controller.signal.aborted || superseded || cancelled || /abort/i.test(errorMessage)) {
      if (!superseded) {
        ai.setAgentState('idle');
        ai.setCurrentStep('');
      }
      return;
    }

    const failure = describeFailure(err);
    ai.setAgentState('error');
    ai.setCurrentStep('');
    ai.setLastFailure(failure);
    ai.addMessage({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: failure.message,
      timestamp: Date.now(),
    });
    ws.addConsoleOutput(`[AI] ${failure.kind}: ${errorMessage}`);

    // Auto-recover to idle after error (only if still in error state)
    setTimeout(() => {
      if (useAIStore.getState().agentState === 'error') {
        useAIStore.getState().setAgentState('idle');
      }
    }, 2000);
  } finally {
    if (activeAgentTurn === turn) activeAgentTurn = null;
  }
}
