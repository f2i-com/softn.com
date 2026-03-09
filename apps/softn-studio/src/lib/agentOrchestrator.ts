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

interface ParsedResponse {
  text: string;
  files: FileOp[];
  deletes: DeleteOp[];
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
 */
export function parseAIResponse(raw: string): ParsedResponse {
  const files: FileOp[] = [];
  const deletes: DeleteOp[] = [];

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

  // Build the user-facing text by stripping the blocks
  let text = raw
    .replace(fileRegex, '')
    .replace(deleteRegex, '')
    .trim();

  // Clean up excessive blank lines left after stripping
  text = text.replace(/\n{3,}/g, '\n\n');

  return { text, files, deletes };
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildFileTree(files: Map<string, VFSFile>): string {
  const paths = Array.from(files.keys()).sort();
  if (paths.length === 0) return '(no files yet)';
  return paths.map((p) => `  ${p}`).join('\n');
}

function buildFileContents(files: Map<string, VFSFile>, maxPerFile: number = 6000): string {
  const parts: string[] = [];
  let totalLen = 0;
  const budget = 80000; // rough character budget for context

  for (const [path, file] of files) {
    if (totalLen > budget) break;
    if (typeof file.content !== 'string') continue;
    // Skip builder/ internals — the AI can see the blueprint directly
    if (path.startsWith('builder/')) continue;

    const content = file.content.length > maxPerFile
      ? file.content.slice(0, maxPerFile) + '\n... (truncated)'
      : file.content;
    parts.push(`--- ${path} ---\n${content}`);
    totalLen += content.length;
  }

  return parts.length > 0 ? parts.join('\n\n') : '(no text files)';
}

export function buildSystemPrompt(): string {
  const ws = useWorkspaceStore.getState();
  const vfs = useVFSStore.getState();
  const files = vfs.files;

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

  return `You are the SoftN Studio AI — a code-generation assistant embedded in a visual app builder.

Your job is to create, edit, and improve files in the user's virtual file system (VFS). The user describes what they want in natural language, and you respond with explanations and file blocks.

## File Formats
SoftN Studio supports two page formats. Use **.ui** for component-driven apps (recommended) and **.html** for standalone pages.

- **.ui** — SoftN UI markup. XML-like component tree rendered by @softn/core. The preferred format.
- **.html** — Standard HTML with inline CSS and JS. Good for simple or self-contained pages.
- **.logic** — FormLogic scripting (JavaScript-like). Imported by .ui files for shared logic.
- **.xdb** — Data collections. JSON with \`{ "collection": "name", "records": [...] }\`.
- **.json** — Config and data files. manifest.json defines the app entry point.
- **.css / .js / .ts / .tsx** — Standard web files, used alongside .html pages.

## How to Create or Update Files
Wrap file content in \`<softn-file>\` blocks. Every block creates or overwrites the file at the given path.

<softn-file path="ui/main.ui">
...file content...
</softn-file>

Include multiple file blocks in one response when needed. To delete a file:

<softn-delete path="old/page.html" />

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

<!-- 4. Logic block — FormLogic code (optional) -->
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
**Utility:** Accordion, Collapse, Tooltip, Loop
**Charts:** LineChart, BarChart, PieChart, AreaChart, RadarChart, GaugeChart
**Animation:** AnimatedBox, AnimatedNumber, Marquee, Typewriter, Draggable, SortableList
**Editors:** CodeEditor, MarkdownEditor, RichTextEditor
**Smart:** SmartGrid, SmartView, SmartForm, SmartStats, SmartCards, SmartList, SmartTimeline

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

## FormLogic (.logic) Syntax

FormLogic is a JavaScript-like scripting language. Used inside \`<logic>\` blocks or standalone \`.logic\` files.

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
- If the manifest.json entry path changes, update manifest.json too.
- For .ui apps, set manifest.json entry to the main .ui file (e.g. \`"entry": "ui/main.ui"\`).
- Create reusable components in separate .ui files and import them.
- Use \`<data>\` blocks to bind XDB collections so the app has live data.

${briefSection}

${blueprintSection}

## Current File Tree
${buildFileTree(files)}

## Current File Contents
${buildFileContents(files)}
`;
}

// ---------------------------------------------------------------------------
// Agent orchestrator — runs a single user turn
// ---------------------------------------------------------------------------

let abortController: AbortController | null = null;

export function abortAgentTurn(): void {
  abortController?.abort();
  abortController = null;
  useAIStore.getState().setAgentState('idle');
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

  abortController = new AbortController();

  try {
    const system = buildSystemPrompt();
    const builderModel = ai.modelProfile.builder || undefined;
    const response = await sendAIRequest(provider, {
      messages: recentMessages,
      system,
      signal: abortController?.signal,
      modelOverride: builderModel,
    });

    // Track tokens
    ai.addTokens(response.usage.inputTokens + response.usage.outputTokens);

    // Parse the response for file operations
    const parsed = parseAIResponse(response.content);

    // Apply file operations
    const toolCalls: ToolCallCard[] = [];

    for (const fileOp of parsed.files) {
      // Re-read VFS state each iteration so we see files created by earlier iterations
      const currentVfs = useVFSStore.getState();
      const existing = currentVfs.files.has(fileOp.path);
      try {
        if (existing) {
          currentVfs.updateFile(fileOp.path, fileOp.content, 'ai');
        } else {
          currentVfs.createFile(fileOp.path, fileOp.content, 'ai');
        }
        ai.incrementFilesChanged();
        toolCalls.push({
          tool: existing ? 'updateFile' : 'createFile',
          args: { path: fileOp.path },
          result: `${existing ? 'Updated' : 'Created'} ${fileOp.path} (${fileOp.content.length} chars)`,
          status: 'success',
        });
        ws.addConsoleOutput(`[AI] ${existing ? 'Updated' : 'Created'} ${fileOp.path}`);
      } catch (err) {
        toolCalls.push({
          tool: existing ? 'updateFile' : 'createFile',
          args: { path: fileOp.path },
          result: `Failed: ${err}`,
          status: 'error',
        });
        ws.addConsoleOutput(`[AI] Error writing ${fileOp.path}: ${err}`);
      }
    }

    for (const del of parsed.deletes) {
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

    // If files were changed, auto-navigate to the first changed file
    if (parsed.files.length > 0) {
      const firstPath = parsed.files[0].path;
      ws.setActiveFilePath(firstPath);
      ws.setDirty(true);
      if (ws.mode === 'describe') {
        ws.setMode('design');
      }
    }

    // Add the AI response message
    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: parsed.text || (parsed.files.length > 0 ? `Updated ${parsed.files.length} file(s).` : response.content),
      timestamp: Date.now(),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      tokens: { input: response.usage.inputTokens, output: response.usage.outputTokens },
    };
    ai.addMessage(assistantMsg);
    ai.setAgentState('idle');
    ai.setCurrentStep('');

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Don't show error for user-initiated abort
    if (errorMessage.includes('abort')) {
      ai.setAgentState('idle');
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
    abortController = null;
  }
}
