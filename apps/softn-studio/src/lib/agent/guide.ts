/**
 * "How to build a SoftN app": the part of the agent's system prompt that
 * teaches the language. Every statement here was checked against core's
 * parser, renderer and composer (packages/@softn/core/src/parser/,
 * renderer/render.tsx, loader/SoftNRenderer.tsx, bundle/source-composer.ts)
 * rather than written from memory, and the guide the single-shot prompt used
 * had real errors this one corrects: `:value` is one-way (only `:bind` writes
 * back), `#each (x in xs; let i)` is a parse error, a block-bodied arrow
 * `() => { … }` in a template never runs, `<data>` collections are not visible
 * to logic, `<import>` of a .ui file drops its props and children, `<style>`
 * is global, and `<App title>` does nothing.
 *
 * test/agentGuide.test.tsx keeps it honest: every component it names exists
 * in the component manifest, and every example composes with the runtime's
 * composer and renders with the real renderer without errors — the Python one
 * on the real Python engine.
 *
 * A JavaScript project's guide says nothing about Python, and a Python
 * project's says nothing of .logic syntax: each is taught the one language it
 * writes (test/logicLanguage.test.tsx).
 */

import { SOFTN_PY_STDLIB_IMPORTS } from '@softn/core';

// ---------------------------------------------------------------------------
// Python material (core's contract: docs/engineering/ZIPP_LANGUAGES.md)
// ---------------------------------------------------------------------------

const PYTHON_RESERVED = ['`softn`', 'any name starting `__softn`', ...SOFTN_PY_STDLIB_IMPORTS.map((name) => `\`${name}\``), '`torch`'].join(', ');

export const PYTHON_LOGIC_SECTION = `## Python logic (.py)

This project's logic is **Python**. The runtime decides a logic file's language from its name and nothing else: \`.py\` is Python, \`.logic\` is JavaScript.

- **Only .py files, referenced with \`<logic src>\`.** Put all logic in .py files (e.g. \`logic/main.py\`) and reference the entry from the .ui file with \`<logic src="../logic/main.py" />\`; the path is relative to the .ui file.
- **No inline Python.** Never write logic inside a \`<logic>\` block. \`<logic lang="python">\` is refused, because Python's indentation is the program and markup indentation is not reliable; an inline block without it is JavaScript.
- **One language per app.** Do not create \`.logic\` files or inline JavaScript logic. A bundle whose logic is partly each is refused.
- **Each file is a module named after its file.** \`logic/helpers.py\` is \`helpers\`: reach it with \`import helpers\` or \`from helpers import double\`. List helper modules in manifest.json's \`files.logic\` before the entry. A module name is letters, digits and underscores, not starting with a digit, and no two .py files may share one, even in different folders. Reserved, and refused as file names: ${PYTHON_RESERVED}.
- **Every top-level name is state.** A module-level \`count = 0\` is state the template reads as \`{count}\`. A name starting with \`_\` is private and not exposed (except \`_init\`). State must be JSON data — \`dict\`, \`list\`, \`str\`, \`int\`, \`float\`, \`bool\`, \`None\`; a class instance is not offered as state. Keep it shallow.
- **Handlers use \`global\`.** A function that assigns a module-level name must declare it \`global\`, or Python makes a local and the state never changes.
- **Functions are the app's API.** Every top-level \`def\` can be called from the template — \`@click={() => add_task()}\`, \`@click={() => remove(item.id)}\`, \`{remaining()}\`. \`_init()\`, if defined, runs once after the app loads. A function called inside \`{…}\` must only read state: changes it makes there do not reach the page.
- **Call handlers with an arrow.** Never hand an event a function by name (\`@click={add_task}\`): it is called with the event as an argument, and a \`def\` with no parameter for it raises \`TypeError\`. Write \`@click={() => add_task()}\`, or give the \`def\` a parameter for the event.
- **Templates are unchanged.** \`{…}\` and \`@event={…}\` are evaluated by the host with the syntax above. Keep them to reading state and calling your functions; compute anything more in a function.
- **\`softn.*\` takes a callback.** \`import softn\`. Capabilities are asynchronous and hand their answer to a callback rather than returning it: \`softn.backend.call("save", {"id": 1}, on_saved)\`, \`softn.net.fetch(url, {"method": "GET"}, on_response)\`. Each has its Python name and its JavaScript one (\`softn.camera.capture_photo\` / \`softn.camera.capturePhoto\`). \`softn.on("keydown", handler)\` registers an event listener. Declare every capability in permission.json.
- **Not available in Python:** \`db.*\`, \`localStorage\` and \`navigator.clipboard\` (use \`softn.storage.*\` for storage), \`$:\` computed declarations (define a function instead), and \`async\`/\`await\`. Collections bound with \`<data>\` are for the template to read.`;

// torch, for a Python project that declares it in manifest.json, and a
// one-line rule for one that does not. The composer refuses an undeclared
// `import torch`, naming the line to add.
export const PYTHON_TORCH_SECTION = `### Machine learning with torch

This project declares torch in manifest.json (\`"config": { "python": { "packages": ["torch"] } }\`), so its .py files may \`import torch\` and \`import torch.nn as nn\`. Keep that declaration whenever you rewrite manifest.json; without it the import is refused.

- **Tensors and models stay in Python.** A tensor, model or optimizer is an object, not state the template can read. Keep them in module-level names starting with \`_\` (private), and keep what the markup shows as plain floats, ints and lists: \`loss = float(current)\`, \`weights = _model.weight.tolist()\`.
- **Train in short calls.** A training step runs on the page's thread. Run a few steps per call from a button or a timer (\`@click={() => train(20)}\`) and update the shown numbers after each call, rather than one long loop that freezes the page.
- **The first \`import torch\` costs about a second**, once per page. Import at the top of the module, not inside a function called per frame.
- **Eager torch only.** Use plain tensor operations, \`torch.nn\` modules, losses and \`torch.optim\` optimizers on the CPU. Do not use \`torch.compile\` or anything needing a GPU: that path is not wired.
- A file named \`torch.py\` is reserved: it would shadow the package.`;

export const PYTHON_TORCH_UNDECLARED = `- **torch must be declared.** \`import torch\` is refused unless manifest.json says \`"config": { "python": { "packages": ["torch"] } }\`; add that declaration first if the app needs machine learning.`;

// A project whose manifest has a `server` block has a private backend: a host
// (FormLogic's native hosting, SoftN's PHP and Rust hosts) runs it and keeps its
// SQLite database. The rules are the hosts' API v1 (see
// apps/softn-host-rust/PRIVATE_BACKEND.md and apps/softn-host-php/runtime).
/**
 * The SQL functions a host lets an app call (apps/softn-host-php/runtime/sql.mjs, the Rust host's
 * rules): at request time, and the ones migrations may also call (the clock, for defaults and
 * backfills). A query or migration that calls anything else is refused.
 */
export const SQL_RUNTIME_FUNCTIONS = ['count', 'min', 'max', 'sum', 'avg', 'total', 'coalesce', 'ifnull', 'nullif', 'length', 'lower', 'upper',
  'trim', 'ltrim', 'rtrim', 'substr', 'substring', 'replace', 'instr', 'abs', 'round', 'like', 'glob', 'typeof', 'unicode', 'char', 'hex', 'quote'] as const;
/** What a migration may call beyond the query functions: the clock (defaults, backfills), and printf/format. */
export const SQL_MIGRATION_EXTRA_FUNCTIONS = ['datetime', 'date', 'time', 'strftime', 'julianday', 'unixepoch', 'printf', 'format'] as const;
/** Table-valued functions a query may read from like a table (`FROM items, json_each(items.tags)`). */
export const SQL_TABLE_FUNCTIONS = ['json_each', 'json_tree'] as const;

export const PRIVATE_BACKEND_SECTION = `## This app's private backend (server/)
manifest.json has a \`server\` block: the app has a backend that runs on its host, not in the browser, with a private SQLite database. The app's real data belongs there, in tables, not in XDB or storage.

- **The \`server\` block.** Keep it whenever you rewrite manifest.json. \`entry\` is the backend file (\`server/main.logic\`); \`requires\` is \`{ "apiVersion": 1, "capabilities": ["sql"] }\`; \`database\` is \`{ "kind": "private-sqlite", "migrations": [ …every migration file, in order… ] }\`; \`routes\` lists every endpoint: \`{ "path": "/api/items", "method": "GET", "handler": "listItems", "transaction": "read", "authorization": "anonymous" }\`. A path starts with \`/api/\` and is matched exactly (no \`/:id\` segments: pass an id in the query or the body). Methods are GET, POST, PUT and DELETE; one route per method and path. A route that changes data needs \`"transaction": "write"\`; a \`"read"\` route cannot write. Keep \`config.server.allowedOrigins\` as it is.
- **server/main.logic is JavaScript**, whatever the page's logic language. Each handler is a top-level \`function listItems(req)\`: \`req.body\` (an object), \`req.query\`, \`req.headers\`, \`req.method\`, \`req.path\`. It returns \`{ status: 200, body: { … } }\`, the body an object. Check its input and answer \`{ status: 422, body: { error: "…" } }\` when it is wrong.
- **SQL.** \`softn.sql.query(sql, params)\` returns rows, \`softn.sql.first(sql, params)\` one row or null, and \`softn.sql.execute(sql, params)\` runs one INSERT, UPDATE, DELETE or REPLACE and returns \`{ changes, lastInsertRowid }\` (no rows, so no RETURNING: read a new row back with \`first\` by its \`lastInsertRowid\`). One statement per call, always with \`?\` parameters, never text built from input. It is SQLite: \`INTEGER PRIMARY KEY\` numbers rows itself (no SERIAL or AUTO_INCREMENT). A query may call only ${SQL_RUNTIME_FUNCTIONS.join(', ')}, and read ${SQL_TABLE_FUNCTIONS.join(' and ')} like a table — no clock or random functions: take the time from \`softn.time.now()\` (epoch seconds) and pass it as a parameter.
- **Migrations** are numbered files, \`server/migrations/001.sql\`, \`002.sql\`, … each listed in \`database.migrations\`. Each runs once, in order. Never change or remove one that exists (the host refuses to start); to change a table, add the next file (\`ALTER TABLE items ADD COLUMN done INTEGER NOT NULL DEFAULT 0;\`). Tables, indexes, ALTER TABLE and inserts only: no triggers, views, PRAGMAs or transactions. A migration may call the query functions above and ${SQL_MIGRATION_EXTRA_FUNCTIONS.join(', ')} (e.g. \`DEFAULT (datetime('now'))\`); nothing else. A column added to an existing table with NOT NULL needs a DEFAULT.
- **Calling the backend from the page.** Call it the way the page already does: \`softn.net.fetch\` with the origin from \`config.server.allowedOrigins\` and the route's path — \`softn.net.fetch(API + "/api/items", { method: "POST", body: { title: title } }, function(response) { … })\`, with \`API\` that origin. \`response.ok\` and \`response.status\` say how it went, and \`response.body\` is the handler's body as JSON text: \`JSON.parse(response.body)\` (in Python, \`json.loads(response["body"])\` after \`import json\`). Load lists in \`_init()\` and again after a change. The host routes these calls to the backend; do not add them to permission.json.
- **Test the backend by reading it**, and by calling the page's functions with run_app_function: a preview shows the page, and a call to the backend may not answer there.`;

export const PYTHON_APP_EXAMPLE = `## Complete App Example (Python)

Here is a minimal but complete todo app: the .ui file and its logic in \`logic/main.py\`.

\`ui/main.ui\`:

\`\`\`xml
<logic src="../logic/main.py" />

<App theme="dark">
  <Container size="sm">
    <Stack direction="vertical" gap="lg" padding="xl">
      <Heading level={1}>Tasks</Heading>

      <Stack direction="horizontal" gap="sm">
        <Input :bind={new_task} placeholder="What needs to be done?" />
        <Button @click={() => add_task()} variant="primary">Add</Button>
      </Stack>

      #each (task in tasks)
        <Card>
          <Stack direction="horizontal" gap="md" align="center">
            <Checkbox checked={task.done} @change={() => toggle_task(task.id)} />
            <Text style={{ flex: 1, textDecoration: task.done ? "line-through" : "none" }}>{task.title}</Text>
            <Button variant="ghost" size="sm" @click={() => delete_task(task.id)}>Delete</Button>
          </Stack>
        </Card>
      #empty
        <EmptyState title="No tasks" description="Add a task to get started" />
      #end

      <Text size="sm" variant="muted">{remaining() + " remaining"}</Text>
    </Stack>
  </Container>
</App>
\`\`\`

\`logic/main.py\`:

\`\`\`python
tasks = []
new_task = ""
_next_id = 1


def add_task():
    global tasks, new_task, _next_id
    if new_task.strip() == "":
        return
    tasks = tasks + [{"id": str(_next_id), "title": new_task.strip(), "done": False}]
    _next_id = _next_id + 1
    new_task = ""


def toggle_task(task_id):
    global tasks
    updated = []
    for task in tasks:
        if task["id"] == task_id:
            task = {"id": task["id"], "title": task["title"], "done": not task["done"]}
        updated.append(task)
    tasks = updated


def delete_task(task_id):
    global tasks
    tasks = [task for task in tasks if task["id"] != task_id]


def remaining():
    return len([task for task in tasks if not task["done"]])
\`\`\`

\`manifest.json\`:

\`\`\`json
{ "name": "Tasks", "version": "1.0.0", "main": "ui/main.ui", "files": { "ui": ["ui/main.ui"], "logic": ["logic/main.py"] } }
\`\`\``;

// ---------------------------------------------------------------------------
// JavaScript material
// ---------------------------------------------------------------------------

const JAVASCRIPT_LOGIC_SECTION = `## .logic Syntax

.logic is JavaScript, run by a sandboxed engine. Reference it from a page with \`<logic src="../logic/main.logic" />\` (relative to the .ui file), or write a short \`<logic>…</logic>\` block inline.

- **Every top-level variable is state** the template reads by name; **every top-level function** can be called from the template. Assign to change state: \`count = count + 1\`, \`tasks = tasks.concat([task])\`, \`tasks = tasks.filter((t) => t.id !== id)\`. Reassign rather than mutate in place, so the change is seen.
- **\`_init()\`**, if defined, runs once after the app loads. \`$: total = items.length\` declares a computed value the template reads as \`{total}\`.
- **A function called inside \`{…}\` must only read state** (\`{remaining()}\`): changes it makes there do not reach the page. Change state from event handlers.
- **Share code between .logic files** with a whole-file \`import "./helpers.logic"\` written inside the logic, or by listing the helper in manifest.json's \`files.logic\`. (\`<import { f } from="…" />\` in markup does nothing.)
- **Globals:** \`softn.*\` (capabilities — see below), \`db\` (XDB records), \`localStorage\` (kept per app), \`navigator.clipboard\`, \`window.addEventListener\` for keyboard and pointer events, and \`console\`. There is no \`fetch\` (use \`softn.net.fetch(url, options, callback)\`), no \`eval\` and no \`new Function\`. For a timer or game clock use the \`<Loop interval={100} running={true} @tick={() => step()} />\` component.
- **\`db\`** (XDB): \`db.query("tasks")\`, \`db.get("tasks", id)\`, \`db.create("tasks", { title: "x" })\`, \`db.update(id, { done: true })\`, \`db.delete(id)\`. Records come back as \`{ id, collection, data: { … }, created_at, updated_at }\`.
- **Event data:** a logic function bound by name (\`@keydown={onKey}\`) receives the event as plain data — \`{ type, key, code, shiftKey, … }\` or pointer coordinates — with no \`target\` or \`preventDefault\`.

\`\`\`javascript
let count = 0
let items = []
let draft = ""

function add() {
  const title = draft.trim()
  if (title === "") return
  items = items.concat([{ id: String(Date.now()), title: title, done: false }])
  draft = ""
}

function remaining() {
  return items.filter((item) => !item.done).length
}
\`\`\``;

export const JAVASCRIPT_APP_EXAMPLE = `## Complete App Example (JavaScript)

A minimal but complete todo app: the page, its logic in \`logic/main.logic\`, and the manifest.

\`ui/main.ui\`:

\`\`\`xml
<logic src="../logic/main.logic" />

<App theme="dark">
  <Container size="sm">
    <Stack direction="vertical" gap="lg" padding="xl">
      <Heading level={1}>Tasks</Heading>

      <Stack direction="horizontal" gap="sm">
        <Input :bind={newTask} placeholder="What needs to be done?" />
        <Button variant="primary" @click={() => addTask()}>Add</Button>
      </Stack>

      <Tabs tabs={[{ key: "all", label: "All" }, { key: "active", label: "Active" }, { key: "done", label: "Done" }]} activeKey={filter} @change={(key) => filter = key} />

      #each (task in visibleTasks())
        <Card>
          <Stack direction="horizontal" gap="md" align="center">
            <Checkbox checked={task.done} @change={() => toggleTask(task.id)} />
            <Text style={{ flex: 1, textDecoration: task.done ? "line-through" : "none" }}>{task.title}</Text>
            <Button variant="ghost" size="sm" @click={() => deleteTask(task.id)}>Delete</Button>
          </Stack>
        </Card>
      #empty
        <EmptyState title="No tasks" description="Add a task to get started" />
      #end

      <Text size="sm" variant="muted">{remaining() + " remaining"}</Text>
    </Stack>
  </Container>
</App>
\`\`\`

\`logic/main.logic\`:

\`\`\`javascript
let tasks = []
let newTask = ""
let filter = "all"
let nextId = 1

function addTask() {
  const title = newTask.trim()
  if (title === "") return
  tasks = tasks.concat([{ id: String(nextId), title: title, done: false }])
  nextId = nextId + 1
  newTask = ""
}

function toggleTask(id) {
  tasks = tasks.map((t) => (t.id === id ? { id: t.id, title: t.title, done: !t.done } : t))
}

function deleteTask(id) {
  tasks = tasks.filter((t) => t.id !== id)
}

function visibleTasks() {
  if (filter === "active") return tasks.filter((t) => !t.done)
  if (filter === "done") return tasks.filter((t) => t.done)
  return tasks
}

function remaining() {
  return tasks.filter((t) => !t.done).length
}
\`\`\`

\`manifest.json\`:

\`\`\`json
{ "name": "Tasks", "version": "1.0.0", "main": "ui/main.ui", "files": { "ui": ["ui/main.ui"], "logic": ["logic/main.logic"] } }
\`\`\``;

// ---------------------------------------------------------------------------
// The guide
// ---------------------------------------------------------------------------

export function buildGuide({ python, torch, backend = false, style }: { python: boolean; torch: boolean; backend?: boolean; style: string }): string {
  const logicExt = python ? '.py' : '.logic';
  const entry = python ? 'logic/main.py' : 'logic/main.logic';
  return `# How to build a SoftN app

A SoftN app is a bundle of text files: pages in the SoftN UI language (\`.ui\`), logic, data and a manifest. The runtime composes the main page with its logic and renders it with SoftN's components.

## Files
- **manifest.json** — required. \`name\` (non-empty), \`version\`, \`main\` (the entry .ui file, e.g. \`"main": "ui/main.ui"\`, which must exist), and \`files\` listing every .ui, ${logicExt}, .xdb and asset you create, by group: \`{ "ui": […], "logic": […], "xdb": […], "assets": […] }\`. A path listed that does not exist is refused. \`config.execution\` may be \`"main"\` or \`"worker"\`${python ? '; `config.python.packages` may be `["torch"]`' : ''}. Never write an \`entry\` field; the runtime does not read it.
- **permission.json** — what the app may use: \`{ "permissions": { "net": { "enabled": true, "allowed_hosts": ["api.example.com"] }, "storage": { "enabled": true } } }\`. \`enabled\` must be the boolean \`true\`. Capabilities: net, camera, mic, files, qr, ai, gpu, sync, storage, accel. Without the file, every capability is denied; declare exactly what the logic calls, in the same step you write the call.
- **ui/*.ui** — pages. **${python ? 'logic/*.py' : 'logic/*.logic'}** — logic, referenced from a page with \`<logic src>\`. **data/*.xdb** — seed records. **assets/** — images, sounds, fonts (already in the project; you write text files only).
${python ? '- **.py** — Python: this project\'s logic language. Each file is a module, referenced from a .ui file with `<logic src="...">`. (A `.logic` file is JavaScript, and one app cannot mix the two.)' : '- **.logic** — JavaScript, run in a sandboxed VM. Imported by .ui files for shared logic.'}
- Keep manifest.json true: \`"main"\` names the entry .ui file, and \`"files"\` lists every .ui, ${logicExt}, .xdb and asset you create, by group.

## A .ui page
A page is a template rooted at \`<App>\`, plus optional blocks in any order: \`<logic src="../${entry}" />\`${python ? '' : ' (or an inline `<logic>…</logic>`)'}, \`<data>\` for XDB collections, and \`<style>\`. \`<App theme="light">\` takes \`light\`, \`dark\` or \`system\`.

\`\`\`xml
<logic src="../${entry}" />

<App theme="dark">
  <Stack direction="vertical" gap="md" padding="lg">
    <Heading level={1}>Counter</Heading>
    <Text>Count: {count}</Text>
    <Button variant="primary" @click={() => increment()}>Add one</Button>
  </Stack>
</App>
\`\`\`

### Props and expressions
- \`label="Save"\` is a string; \`size={3}\`, \`disabled={count > 3}\`, \`items={[1, 2]}\`, \`style={{ padding: "1rem" }}\` are expressions; a bare \`disabled\` is \`true\`. \`style="color: red; padding: 8px"\` also works as CSS text.
- \`{…}\` interpolates: \`<Text>Hello {name}</Text>\`, \`<Badge>{done ? "Done" : "Open"}</Badge>\`.
- Text reads like HTML around expressions: \`<Text>{count} tasks</Text>\` shows "3 tasks", and \`{first} {last}\` keeps its space.
- Template expressions support \`?:\`, \`??\`, \`&&\`, \`||\`, comparisons, arithmetic, \`!\`, \`typeof\`, member access, \`?.\`, calls and method calls, array and object literals, template literals, and arrow functions **with parentheses and a single-expression body**: \`(x) => x * 2\`, \`() => save()\`.
- **Not supported in templates:** \`x => x\` without parentheses, block bodies \`() => { … }\` (the handler never runs), \`new\`, \`undefined\` as a value, \`in\`, \`async\`/\`await\`, spread. Put anything more in a logic function and call it.
- Globals a template can use: \`Math\`, \`JSON\`, \`Number\`, \`String\`, \`Boolean\`, \`Array\`, \`Date\` (as \`Date.now()\`), \`parseInt\`, \`parseFloat\`, \`isNaN\`, \`encodeURIComponent\`, and helpers such as \`formatDate(value)\`, \`timeAgo(value)\`, \`currency(value)\`, \`truncate(text, n)\`.

### Events
- \`@click={() => save()}\`, \`@click={() => count = count + 1}\` (an assignment is allowed), \`@click={() => remove(item.id)}\`. Write handlers as arrows${python ? '' : ', or name a function: `@click={save}` calls it with the event'}.
- \`@name\` sets the component's \`onName\` prop: \`@change\` → onChange, \`@keydown\` → onKeyDown, \`@tick\` → onTick. lookup_components lists each component's events.
- \`@change\` and \`@input\` receive the **new value**, not a DOM event: \`@change={(value) => query = value}\`. Tabs' \`@change\` receives the tab key; a Checkbox's receives \`"on"\`, so toggle with \`@change={() => toggle(item.id)}\`.
- An arrow written in the template sees the raw event: \`@keydown={(e) => e.key === "Enter" && add()}\`.

### Binding
- **\`:bind={name}\` is the only two-way binding**: it shows the state and writes what the person types or checks back to it. \`<Input :bind={query} />\`, \`<Checkbox :bind={agreed} />\`, \`<Select :bind={choice} options={["A", "B"]} />\`.
- Every other prop is one-way: \`value={x}\` or \`checked={x}\` only shows \`x\`. A controlled component needs its event too: \`<Tabs activeKey={tab} @change={(key) => tab = key} … />\`.

### Classes and styles
- On components write \`className="card"\`; \`class:selected={isSelected}\` adds a class when true. (\`class="…"\` only styles plain HTML tags.)
- A \`<style>\` block is global to the page, not scoped: give your classes distinctive names.

### Control flow
\`\`\`xml
<App>
  #if (items.length > 0)
    <Text>{items.length} items</Text>
  #elseif (loading)
    <Spinner />
  #else
    <EmptyState title="Nothing yet" />
  #end

  #each (item in items)
    <Text>{item.title}</Text>
  #empty
    <Text>No items</Text>
  #end

  #each (item, i in items)
    <Text>{i + 1}. {item.title}</Text>
  #end
</App>
\`\`\`
- Conditions go in parentheses. Write \`#elseif\` — \`#else if\` renders as text. The index form is \`#each (item, i in items)\`; \`#each (item in items; let i)\` is a parse error.
- Inline forms: \`<Box if={open}>…</Box>\`, \`<Card each={items} as="item">{item.title}</Card>\`.

### Reuse
\`<import Header from="./header.ui" />\` pastes that file's markup wherever \`<Header />\` appears, reading the page's state — but the tag's props and children are dropped, and \`<component>\`, \`<prop>\` and \`<slot>\` declarations do nothing useful. For repeated UI, loop over data with \`#each\` and keep the shared behaviour in logic functions.

### Assets
\`<Image src={asset("assets/logo.png")} alt="Logo" />\` — the path is from the bundle root, never \`../\`.

## Data with XDB
- A \`.xdb\` file seeds a collection: \`{ "collection": "tasks", "records": [{ "id": "1", "title": "Buy milk", "done": false }] }\`. Every record needs a **string** \`id\` (a record without one is dropped). List the file in manifest.json's \`files.xdb\`, or its records are not loaded.
- Bind it in a page: \`<data><collection name="tasks" as="tasks" sort="created_at:desc" limit={50} /></data>\`, with optional \`filter={{ done: false }}\` (literal values only). The template reads a bound record's fields under \`data\`: \`{task.data.title}\`, with \`task.id\` and \`task.created_at\` beside it. A Table wants flat rows: \`data={tasks.map((t) => t.data)}\`.
- Logic does not see \`<data>\` collections.${python ? ' Python logic has no `db`: keep app records in state, or use `softn.storage.*`.' : ' Logic changes records with `db.create`, `db.update` and `db.delete`, and the bound collection updates.'}

${python ? `${PYTHON_LOGIC_SECTION}
${torch ? `
${PYTHON_TORCH_SECTION}` : PYTHON_TORCH_UNDECLARED}` : JAVASCRIPT_LOGIC_SECTION}

## Capabilities (softn.*)
\`softn.net.fetch\` (net), \`softn.camera.*\` (camera), \`softn.mic.*\` (mic), \`softn.files.*\` (files), \`softn.qr.*\` (qr), \`softn.ai.*\` (ai; \`softn.ai.gpu.*\` needs gpu), \`softn.storage.*\` (storage — server storage for a published app), \`db.startSync\` (sync). Each needs its capability in permission.json. \`softn.backend.call\`, \`softn.audio.*\` for bundle sounds and \`softn.input.captureKeys\` need none. The preview grants no capabilities, so these calls fail there; Run opens the app in the runtime.

## Common mistakes and the errors they cause
- \`<logic src="../logic/app${logicExt}" />\` naming a file that is not there: "logic/app${logicExt} is referenced by ui/main.ui but is not in the bundle".
- manifest.json \`main\` missing or wrong: "The manifest names no entry file (main)." / "The manifest's entry file is not in the bundle: …".
- manifest.json \`files\` listing a path that does not exist: "manifest.files.ui lists …, but the bundle has no such file."
- A capability called but not declared: "Network access not permitted. Add net.enabled to permission.json".
- An unknown capability in permission.json: "permission.json names capabilities the runtime does not have: …".
- Template syntax the parser cannot read: "Unexpected token … in expression: the rest of the expression up to its closing "}" is not supported here and was not read" — rewrite it as a call to a logic function.
${python ? `- JavaScript and Python in one app: "This app mixes Python and JavaScript logic. …".
- Inline Python: "ui/main.ui has an inline <logic lang="python"> block: put Python in a .py file and reference it with <logic src="...">".
- A bad module name: "logic/my-app.py cannot be a Python module: name it with letters, digits and underscores, starting with a letter".
- \`import torch\` without the declaration: "logic/main.py imports torch, which an app asks for in manifest.json: …".` : `- \`:value={x}\` on an input and expecting typing to change \`x\`: it does not; use \`:bind\`.`}
- \`{item.title}\` on a record bound with \`<data>\` shows nothing: use \`{item.data.title}\`.

## Style
Match the brief's style: ${style}. Pages should be responsive and polished — production quality, not wireframes: real headings and copy, sensible spacing (\`Stack gap\`, \`Container size\`), empty states, and sample data where it helps.
${backend ? `
${PRIVATE_BACKEND_SECTION}
` : ''}
${python ? PYTHON_APP_EXAMPLE : JAVASCRIPT_APP_EXAMPLE}`;
}

/** Whether manifest.json declares a private backend (a `server` block with an entry). */
export function projectHasBackend(manifestSource: string | undefined): boolean {
  if (!manifestSource) return false;
  try {
    const manifest = JSON.parse(manifestSource) as { server?: { entry?: unknown } };
    return typeof manifest?.server?.entry === 'string' && manifest.server.entry.length > 0;
  } catch {
    return false;
  }
}
