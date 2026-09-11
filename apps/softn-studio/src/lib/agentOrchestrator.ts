import { sendAIRequest } from './aiProvider';
import { useAIStore } from '../stores/aiStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useVFSStore } from '../stores/vfsStore';
import type { ChatMessage, ToolCallCard, VFSFile } from '../types/studio';

// ---------------------------------------------------------------------------
// File‑block parsing
// ---------------------------------------------------------------------------

interface FileOp {
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

/** Sanitize a VFS path: normalize separators, strip leading slash, reject traversal. */
function sanitizePath(raw: string): string | null {
  // Normalize backslashes and collapse multiple slashes
  let p = raw.replace(/\\/g, '/').replace(/\/+/g, '/');
  // Strip leading slash
  if (p.startsWith('/')) p = p.slice(1);
  // Reject directory traversal
  if (p.includes('..') || p.startsWith('.')) return null;
  // Reject empty paths
  if (p.length === 0) return null;
  return p;
}

/**
 * Parse AI response text for file operation blocks.
 *
 * Supported formats:
 *   <softn-file path="pages/home.html">…content…</softn-file>
 *   <softn-delete path="old/file.html" />
 *   <softn-read path="logic/app.logic" />
 */
export function parseAIResponse(raw: string): ParsedResponse {
  const files: FileOp[] = [];
  const deletes: DeleteOp[] = [];
  const reads: ReadOp[] = [];

  // Extract file blocks
  const fileRegex = /<softn-file\s+path="([^"]+)">([\s\S]*?)<\/softn-file>/g;
  let match: RegExpExecArray | null;
  while ((match = fileRegex.exec(raw)) !== null) {
    const path = sanitizePath(match[1]);
    if (!path) continue;
    const content = match[2].replace(/^\n/, '').replace(/\n$/, '');
    if (content.length === 0) continue; // skip empty files
    files.push({ path, content });
  }

  // Extract delete directives
  const deleteRegex = /<softn-delete\s+path="([^"]+)"\s*\/>/g;
  while ((match = deleteRegex.exec(raw)) !== null) {
    const path = sanitizePath(match[1]);
    if (!path) continue;
    deletes.push({ path });
  }

  // Extract read requests
  const readRegex = /<softn-read\s+path="([^"]+)"\s*\/>/g;
  while ((match = readRegex.exec(raw)) !== null) {
    const path = sanitizePath(match[1]);
    if (!path) continue;
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
  const paths = Array.from(files.keys()).sort();
  if (paths.length === 0) return '(no files yet)';
  return paths.map((p) => `  ${p}`).join('\n');
}

/**
 * What the model was shown of one file, and the version it was shown at.
 *
 * A reply replaces files whole, so a file the model saw only the head of
 * cannot be replaced from that reply without losing its tail: the record
 * of what was supplied is what lets the apply step refuse that. The
 * version is what lets it notice the file changed under the request.
 */
export interface SuppliedFile {
  path: string;
  /** Whether the whole content was in the prompt. */
  complete: boolean;
  /** The VFS version at the time it was supplied. */
  version: number;
  /** Characters shown, of the total. */
  shown: number;
  total: number;
}

export type SuppliedFiles = Map<string, SuppliedFile>;

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
    if (path.startsWith('builder/')) continue;

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

/** The system prompt and the exact record of which files it supplies, and how much of each. */
export function buildSystemPromptWithRecord(complete: ReadonlySet<string> = new Set()): { system: string; supplied: SuppliedFiles } {
  const ws = useWorkspaceStore.getState();
  const vfs = useVFSStore.getState();
  const files = vfs.files;
  const contents = buildFileContents(files, MAX_CHARS_PER_FILE, CONTEXT_CHAR_BUDGET, complete);

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
  return { system, supplied: contents.supplied };
}

// ---------------------------------------------------------------------------
// Agent orchestrator — runs a single user turn
// ---------------------------------------------------------------------------

interface ActiveAgentTurn {
  controller: AbortController;
}

let activeAgentTurn: ActiveAgentTurn | null = null;

/** How many times one turn may answer a `<softn-read>` before it has to stop asking. */
export const MAX_READ_ROUNDS = 3;

/**
 * Why a file block may not be written. `partial` is the STU-01 case: the
 * model saw a truncated file, or none of it, and a whole-file reply would
 * erase what it did not see. `stale` is the file having changed since it
 * was supplied — a manual edit while the request was in flight — which a
 * replacement built on the old content would overwrite.
 */
export type WriteRefusal =
  | { kind: 'partial'; shown: number; total: number }
  | { kind: 'unseen' }
  | { kind: 'stale'; suppliedVersion: number; currentVersion: number };

/**
 * Whether a whole-file write of `path` may be applied given what the model
 * was supplied and what the VFS holds now. A new file is always allowed:
 * there is nothing to erase.
 */
export function checkWrite(path: string, supplied: SuppliedFiles, current: VFSFile | undefined): WriteRefusal | null {
  if (!current) return null;
  const record = supplied.get(path);
  if (!record) {
    // Exists, but the model was never shown it: a binary, a file past the
    // budget, or one created since the prompt was built.
    return { kind: 'unseen' };
  }
  if (!record.complete) return { kind: 'partial', shown: record.shown, total: record.total };
  if (current.version !== record.version) return { kind: 'stale', suppliedVersion: record.version, currentVersion: current.version };
  return null;
}

export function describeRefusal(path: string, refusal: WriteRefusal): string {
  switch (refusal.kind) {
    case 'partial':
      return `Refused: ${path} was shown truncated (${refusal.shown} of ${refusal.total} characters), so this reply would have erased the rest of it. Nothing was written. Ask for the file whole, or ask for a smaller change.`;
    case 'unseen':
      return `Refused: ${path} exists but was not shown to the model, so this reply could not have preserved its content. Nothing was written.`;
    case 'stale':
      return `Refused: ${path} changed while the request was in flight (v${refusal.suppliedVersion} → v${refusal.currentVersion}), so this reply was built on old content. Nothing was written; ask again.`;
  }
}

export function abortAgentTurn(): void {
  const turn = activeAgentTurn;
  activeAgentTurn = null;
  turn?.controller.abort();
  useAIStore.getState().setAgentState('idle');
  useAIStore.getState().setCurrentStep('');
}

/**
 * Write what a reply asks for, refusing what it cannot safely ask for. A
 * whole-file block for a file the model saw truncated, never saw, or that
 * changed since it was supplied is refused and reported; the rest goes in.
 */
function applyFileOperations(
  parsed: ParsedResponse,
  supplied: SuppliedFiles,
  ai: ReturnType<typeof useAIStore.getState>,
  ws: ReturnType<typeof useWorkspaceStore.getState>,
): { toolCalls: ToolCallCard[]; written: string[] } {
  const toolCalls: ToolCallCard[] = [];
  const written: string[] = [];

  for (const fileOp of parsed.files) {
    // Re-read VFS state each iteration so we see files created by earlier iterations
    const currentVfs = useVFSStore.getState();
    const current = currentVfs.files.get(fileOp.path);
    const existing = current !== undefined;
    const tool = existing ? 'updateFile' : 'createFile';
    const refusal = checkWrite(fileOp.path, supplied, current);
    if (refusal) {
      const result = describeRefusal(fileOp.path, refusal);
      toolCalls.push({ tool, args: { path: fileOp.path }, result, status: 'error' });
      ws.addConsoleOutput(`[AI] ${result}`);
      continue;
    }
    try {
      if (existing) {
        currentVfs.updateFile(fileOp.path, fileOp.content, 'ai');
      } else {
        currentVfs.createFile(fileOp.path, fileOp.content, 'ai');
      }
      ai.incrementFilesChanged();
      written.push(fileOp.path);
      toolCalls.push({
        tool,
        args: { path: fileOp.path },
        result: `${existing ? 'Updated' : 'Created'} ${fileOp.path} (${fileOp.content.length} chars)`,
        status: 'success',
      });
      ws.addConsoleOutput(`[AI] ${existing ? 'Updated' : 'Created'} ${fileOp.path}`);
    } catch (err) {
      toolCalls.push({ tool, args: { path: fileOp.path }, result: `Failed: ${err}`, status: 'error' });
      ws.addConsoleOutput(`[AI] Error writing ${fileOp.path}: ${err}`);
    }
  }

  for (const del of parsed.deletes) {
    const current = useVFSStore.getState().files.get(del.path);
    // A deletion is as whole-file as a replacement: a file that changed
    // since it was supplied is not deleted on the strength of old content.
    const record = supplied.get(del.path);
    if (current && record && current.version !== record.version) {
      const result = describeRefusal(del.path, { kind: 'stale', suppliedVersion: record.version, currentVersion: current.version });
      toolCalls.push({ tool: 'deleteFile', args: { path: del.path }, result, status: 'error' });
      ws.addConsoleOutput(`[AI] ${result}`);
      continue;
    }
    try {
      useVFSStore.getState().deleteFile(del.path, 'ai');
      toolCalls.push({
        tool: 'deleteFile',
        args: { path: del.path },
        result: `Deleted ${del.path}`,
        status: 'success',
      });
      ws.addConsoleOutput(`[AI] Deleted ${del.path}`);
    } catch (err) {
      toolCalls.push({
        tool: 'deleteFile',
        args: { path: del.path },
        result: `Failed: ${err}`,
        status: 'error',
      });
    }
  }

  return { toolCalls, written };
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

  const turn: ActiveAgentTurn = { controller: new AbortController() };
  activeAgentTurn = turn;

  try {
    const builderModel = ai.modelProfile.builder || undefined;
    const toolCalls: ToolCallCard[] = [];
    const texts: string[] = [];
    let usage = { input: 0, output: 0 };
    let writtenPaths: string[] = [];
    let rawFallback = '';

    // Files the model has asked to see whole. Each round rebuilds the prompt
    // with those supplied complete, so the record of what it saw is exact.
    const complete = new Set<string>();
    const conversation = [...recentMessages];

    for (let round = 0; ; round++) {
      const { system, supplied } = buildSystemPromptWithRecord(complete);
      const response = await sendAIRequest(provider, {
        messages: conversation,
        system,
        signal: turn.controller.signal,
        modelOverride: builderModel,
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

      const applied = applyFileOperations(parsed, supplied, ai, ws);
      toolCalls.push(...applied.toolCalls);
      writtenPaths = [...writtenPaths, ...applied.written];

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

    // If files were changed, auto-navigate to the first changed file
    if (writtenPaths.length > 0) {
      ws.setActiveFilePath(writtenPaths[0]);
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
      content: text || (writtenPaths.length > 0 ? `Updated ${writtenPaths.length} file(s).` : rawFallback),
      timestamp: Date.now(),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      tokens: usage,
    };
    ai.addMessage(assistantMsg);
    ai.setAgentState('idle');
    ai.setCurrentStep('');

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const superseded = activeAgentTurn !== turn;

    // Don't let a cancelled turn overwrite the state of the turn that
    // replaced it. Fetch implementations differ in the exact AbortError text,
    // so the signal/ownership checks are authoritative.
    if (turn.controller.signal.aborted || superseded || /abort/i.test(errorMessage)) {
      if (!superseded) {
        ai.setAgentState('idle');
        ai.setCurrentStep('');
      }
      return;
    }

    ai.setAgentState('error');
    ai.setCurrentStep('');
    ai.addMessage({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: `Error: ${errorMessage}\n\nCheck your API key and provider settings.`,
      timestamp: Date.now(),
    });
    ws.addConsoleOutput(`[AI] Error: ${errorMessage}`);

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
