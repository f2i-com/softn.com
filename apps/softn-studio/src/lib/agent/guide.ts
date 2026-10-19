/**
 * "How to build a SoftN app": the part of the agent's system prompt that
 * teaches the language. Every statement here was checked against core's
 * parser, renderer and composer (packages/@softn/core/src/parser/,
 * renderer/render.tsx, loader/SoftNRenderer.tsx, bundle/source-composer.ts)
 * rather than written from memory, and the guide the single-shot prompt used
 * had real errors this one corrects: `:value` is one-way (only `:bind` writes
 * back), `#each (x in xs; let i)` is a parse error, `<data>` collections are not visible
 * to logic, `<import>` of a page drops its props and children, `<style>`
 * is global, and `<App title>` does nothing.
 *
 * test/agentGuide.test.tsx keeps it honest: every component it names exists
 * in the component manifest, and every example composes with the runtime's
 * composer and renders with the real renderer without errors — the Python one
 * on the real Python engine.
 *
 * A JavaScript project's guide says nothing about Python, and a Python
 * project's says nothing of JavaScript logic: each is taught the one language
 * it writes (test/logicLanguage.test.tsx).
 *
 * It teaches the layout Studio scaffolds, `index.html`, `pages/*.html` and
 * `main.js` or `main.py`, and says that a project made before, `ui/*.ui` and
 * `logic/*.logic`, works the same: the agent edits whichever it is given.
 */

import { SOFTN_PY_STDLIB_IMPORTS } from '@softn/core';

// ---------------------------------------------------------------------------
// Python material (core's contract: docs/engineering/ZIPP_LANGUAGES.md)
// ---------------------------------------------------------------------------

const PYTHON_RESERVED = ['`softn`', 'any name starting `__softn`', ...SOFTN_PY_STDLIB_IMPORTS.map((name) => `\`${name}\``), '`torch`'].join(', ');

export const PYTHON_LOGIC_SECTION = `## Python logic (.py)

This project's logic is **Python**. The runtime decides a logic file's language from its name and nothing else: \`.py\` is Python, \`.js\` and \`.logic\` are JavaScript.

- **Only .py files, referenced with \`<script src>\`.** Put all logic in .py files (e.g. \`main.py\`) and reference the entry from the page with \`<script src="main.py"></script>\`; the path is relative to the page. (\`<logic src="main.py" />\` is the same, in projects made before.)
- **No inline Python.** Never write logic inside a \`<script>\` or \`<logic>\` block. \`<script type="text/python">\` and \`<logic lang="python">\` are refused, because Python's indentation is the program and markup indentation is not reliable; an inline block without them is JavaScript.
- **One language per app.** Do not create \`.js\` or \`.logic\` files or inline JavaScript logic. A bundle whose logic is partly each is refused.
- **Each file is a module named after its file.** \`helpers.py\` is \`helpers\`: reach it with \`import helpers\` or \`from helpers import double\`. List helper modules in manifest.json's \`files.logic\` before the entry. A module name is letters, digits and underscores, not starting with a digit, and no two .py files may share one, even in different folders. Reserved, and refused as file names: ${PYTHON_RESERVED}.
- **Every top-level name is state.** A module-level \`count = 0\` is state the template reads as \`{count}\`. A name starting with \`_\` is private and not exposed (except \`_init\`). State must be JSON data — \`dict\`, \`list\`, \`str\`, \`int\`, \`float\`, \`bool\`, \`None\`; a class instance is not offered as state. Keep it shallow.
- **Handlers use \`global\`.** A function that assigns a module-level name must declare it \`global\`, or Python makes a local and the state never changes.
- **Functions are the app's API.** Every top-level \`def\` can be called from the template — \`@click={() => add_task()}\`, \`@click={() => remove(item.id)}\`, \`{remaining()}\`. \`_init()\`, if defined, runs once after the app loads. A function called inside \`{…}\` must only read state: changes it makes there do not reach the page.
- **Call handlers with an arrow.** Never hand an event a function by name (\`@click={add_task}\`): it is called with the event as an argument, and a \`def\` with no parameter for it raises \`TypeError\`. Write \`@click={() => add_task()}\`, or give the \`def\` a parameter for the event.
- **Templates are unchanged.** \`{…}\` and \`@event={…}\` are evaluated by the host with the syntax above. Keep them to reading state and calling your functions; compute anything more in a function.
- **\`softn.*\` takes a callback.** \`import softn\`. Capabilities are asynchronous and hand their answer to a callback rather than returning it: \`softn.backend.call("save", {"id": 1}, on_saved)\`, \`softn.net.fetch(url, {"method": "GET"}, on_response)\`. Each has its Python name and its JavaScript one (\`softn.camera.capture_photo\` / \`softn.camera.capturePhoto\`). \`softn.on("keydown", handler)\` registers an event listener. Declare every capability in permission.json.
- **Not available in Python:** \`db.*\`, \`localStorage\` and \`navigator.clipboard\` (use \`softn.storage.*\` for storage), \`$:\` computed declarations (define a function instead), \`async\`/\`await\`, and timers (for a clock, \`<Loop interval={100} running={running} @tick={() => step()} />\` in the page). Collections bound with \`<data>\` are for the template to read.`;

// torch, for a Python project that declares it in manifest.json, and a
// one-line rule for one that does not. The composer refuses an undeclared
// `import torch`, naming the line to add.
export const PYTHON_TORCH_SECTION = `### Machine learning with torch

This project declares torch in manifest.json (\`"config": { "python": { "packages": ["torch"] } }\`), so its .py files may \`import torch\` and \`import torch.nn as nn\`. Keep that declaration whenever you rewrite manifest.json; without it the import is refused.

- **Tensors and models stay in Python.** A tensor, model or optimizer is an object, not state the template can read. Keep them in module-level names starting with \`_\` (private), and keep what the markup shows as plain floats, ints and lists: \`loss = float(current)\`, \`weights = _model.weight.tolist()\`.
- **Train in short calls.** A training step runs on the page's thread. Run a few steps per call from a button or a \`<Loop>\` (\`@click={() => train(20)}\`) and update the shown numbers after each call, rather than one long loop that freezes the page.
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
- **server/main.logic is JavaScript**, whatever the page's logic language. Each handler is a top-level \`function listItems(req)\`: \`req.body\` (an object), \`req.query\`, \`req.headers\`, \`req.method\`, \`req.path\`. It returns \`{ status: 200, body: { … } }\`, the body an object. Check its input and answer \`{ status: 422, body: { error: "…" } }\` when it is wrong. There are no timers in server logic (\`setTimeout\`, \`setInterval\`): a handler does its work before it returns.
- **SQL.** \`softn.sql.query(sql, params)\` returns rows, \`softn.sql.first(sql, params)\` one row or null, and \`softn.sql.execute(sql, params)\` runs one INSERT, UPDATE, DELETE or REPLACE and returns \`{ changes, lastInsertRowid }\` (no rows, so no RETURNING: read a new row back with \`first\` by its \`lastInsertRowid\`). One statement per call, always with \`?\` parameters, never text built from input. It is SQLite: \`INTEGER PRIMARY KEY\` numbers rows itself (no SERIAL or AUTO_INCREMENT). A query may call only ${SQL_RUNTIME_FUNCTIONS.join(', ')}, and read ${SQL_TABLE_FUNCTIONS.join(' and ')} like a table — no clock or random functions: take the time from \`softn.time.now()\` (epoch seconds) and pass it as a parameter. A handler is one transaction: a statement that fails rolls back everything the handler wrote and the request answers 500, even if the handler catches the error. Do not rely on catching a failed INSERT (a duplicate, a broken constraint): check with a query first and answer \`{ status: 409, … }\`, or return \`rollback: true\` beside \`status\` and \`body\` to undo the handler's writes and keep its answer. The same holds for every \`softn.*\` call that throws, not only SQL (\`softn.time.parseZoned\` on a time that does not exist, a crypto call given bad input): check the input yourself and answer 422 before making the call, rather than catching its failure.
- **Migrations** are numbered files, \`server/migrations/001.sql\`, \`002.sql\`, … each listed in \`database.migrations\`. Each runs once, in order. Never change or remove one that exists (the host refuses to start); to change a table, add the next file (\`ALTER TABLE items ADD COLUMN done INTEGER NOT NULL DEFAULT 0;\`). Tables, indexes, ALTER TABLE and inserts only: no triggers, views, PRAGMAs or transactions. A migration may call the query functions above and ${SQL_MIGRATION_EXTRA_FUNCTIONS.join(', ')} (e.g. \`DEFAULT (datetime('now'))\`); nothing else. A column added to an existing table with NOT NULL needs a DEFAULT.
- **Calling the backend from the page.** Call it the way the page already does: \`softn.net.fetch\` with the origin from \`config.server.allowedOrigins\` and the route's path — \`softn.net.fetch(API + "/api/items", { method: "POST", body: { title: title } }, function(response) { … })\`, with \`API\` that origin. \`response.ok\` and \`response.status\` say how it went, and \`response.body\` is the handler's body as JSON text: \`JSON.parse(response.body)\` (in Python, \`json.loads(response["body"])\` after \`import json\`). Load lists in \`_init()\` and again after a change. The host routes these calls to the backend; do not add them to permission.json.
- **Test the backend by reading it**, and by calling the page's functions with run_app_function: a preview shows the page, and a call to the backend may not answer there.`;

export const PYTHON_APP_EXAMPLE = `## Complete App Example (Python)

Here is a minimal but complete todo app: the page and its logic in \`main.py\`.

\`index.html\`:

\`\`\`xml
<script src="main.py"></script>

<App theme="dark">
  <Container size="sm">
    <Stack direction="vertical" gap="lg" padding="xl">
      <Heading level={1}>Tasks</Heading>

      <Stack direction="horizontal" gap="sm">
        <Input :bind={new_task} placeholder="What needs to be done?" />
        <Button @click={() => add_task()} variant="primary">Add</Button>
      </Stack>

      #each (task in tasks) key={task.id}
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

\`main.py\`:

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
{ "name": "Tasks", "version": "1.0.0", "main": "index.html", "files": { "ui": ["index.html"], "logic": ["main.py"] } }
\`\`\``;

// ---------------------------------------------------------------------------
// JavaScript material
// ---------------------------------------------------------------------------

const JAVASCRIPT_LOGIC_SECTION = `## Logic (.js)

Logic is JavaScript in a \`.js\` file, run by a sandboxed engine. Reference it from a page with \`<script src="main.js"></script>\` (relative to the page), or write a short \`<script>…</script>\` block inline. (\`.logic\` files and \`<logic src>\` are the same, in projects made before.) It is one script, not modules: every file's top-level names are the page's.

- **Every top-level variable is state** the template reads by name; **every top-level function** can be called from the template. Assign to change state: \`count = count + 1\`, \`tasks = tasks.concat([task])\`, \`tasks = tasks.filter((t) => t.id !== id)\`. Reassign rather than mutate in place, so the change is seen.
- **\`_init()\`**, if defined, runs once after the app loads. \`$: total = items.length\` declares a computed value the template reads as \`{total}\`.
- **A function called inside \`{…}\` must only read state** (\`{remaining()}\`): changes it makes there do not reach the page. Change state from event handlers.
- **Share code between files** with \`import "./helpers.js"\` or \`import { total } from "./helpers.js"\`, which places that file's code, or by listing the helper in manifest.json's \`files.logic\`. \`export\` before a declaration is allowed and changes nothing. An import that renames (\`{ a as b }\`), a default or namespace import, and a package import (\`from "lodash"\`) are not read. (\`<import { f } from="…" />\` in markup does nothing.)
- **Prefer state.** The page shows state, and a handler changes state: write SoftN that way. Code written for a browser also works on a page's plain HTML (\`document.getElementById\`, \`querySelector\`, \`createElement\`, \`appendChild\`, \`textContent\`, \`innerHTML\`, \`classList\`, \`addEventListener\`, a field's \`value\`, \`DOMContentLoaded\`), for a person who asks for it or a page brought in from elsewhere. It cannot reach inside a component, a \`{…}\` value, \`#if\` or \`#each\`: SoftN draws those. Layout reads (\`offsetWidth\`, \`getBoundingClientRect()\`) are zero.
- **Globals:** \`softn.*\` (capabilities — see below), \`db\` (XDB records), \`localStorage\` (kept per app), \`navigator.clipboard\`, \`window.addEventListener\` for keyboard and pointer events, \`console\`, and the browser's \`fetch\` (a promise; the hosts it may reach are those permission.json allows \`net\`), \`location\` (\`location.href = "about.html"\` goes to another page of the app; never another site), \`URLSearchParams\`, \`structuredClone\`, \`queueMicrotask\`, \`sessionStorage\` and \`alert()\`. There is no \`confirm()\` or \`prompt()\` (nothing can wait for an answer): ask with a \`<Confirm>\` or a field on the page.
- **Timers:** \`setTimeout\`, \`setInterval\`, \`clearTimeout\` and \`clearInterval\` work in page logic: the callback runs like a handler and what it writes is drawn. Use them for a delay, a debounce or a countdown, and start one from a logic function (\`@click={() => startCountdown()}\`): markup cannot call them. For a game clock prefer \`<Loop interval={100} running={running} @tick={() => step()} />\`. Timers do not work in backend (server) logic. \`requestAnimationFrame\` waits about a frame (16 ms).
- **\`db\`** (XDB): \`db.query("tasks")\`, \`db.get("tasks", id)\`, \`db.create("tasks", { title: "x" })\`, \`db.update(id, { done: true })\`, \`db.delete(id)\`. Records come back as \`{ id, collection, data: { … }, created_at, updated_at }\`.
- **Event data:** a logic function bound by name (\`@keydown={onKey}\`) or handed the event (\`onsubmit="send(event)"\`) receives it as plain data — \`{ type, key, code, shiftKey, … }\` or pointer coordinates, with \`target\` and \`currentTarget\` as what those elements hold (\`value\`, \`checked\`, \`name\`, \`dataset\`). \`e.preventDefault()\` can be called and does nothing: cancel with a modifier (\`@submit.prevent\`); a \`<form>\` with no \`action\` never leaves its page anyway.

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

A minimal but complete todo app: the page, its logic in \`main.js\`, and the manifest.

\`index.html\`:

\`\`\`xml
<script src="main.js"></script>

<App theme="dark">
  <Container size="sm">
    <Stack direction="vertical" gap="lg" padding="xl">
      <Heading level={1}>Tasks</Heading>

      <Stack direction="horizontal" gap="sm">
        <Input :bind={newTask} placeholder="What needs to be done?" />
        <Button variant="primary" @click={() => addTask()}>Add</Button>
      </Stack>

      <Tabs tabs={[{ key: "all", label: "All" }, { key: "active", label: "Active" }, { key: "done", label: "Done" }]} activeKey={filter} @change={(key) => filter = key} />

      #each (task in visibleTasks()) key={task.id}
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

\`main.js\`:

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
{ "name": "Tasks", "version": "1.0.0", "main": "index.html", "files": { "ui": ["index.html"], "logic": ["main.js"] } }
\`\`\``;

// ---------------------------------------------------------------------------
// The guide
// ---------------------------------------------------------------------------

export function buildGuide({ python, torch, backend = false, style }: { python: boolean; torch: boolean; backend?: boolean; style: string }): string {
  const logicExt = python ? '.py' : '.js';
  const entry = python ? 'main.py' : 'main.js';
  return `# How to build a SoftN app

A SoftN app is a bundle of text files: pages written as HTML with SoftN's components and syntax in them (\`.html\`), logic, data and a manifest. The runtime composes the main page with its logic and renders it with SoftN's components. A project made before has \`.ui\` pages and \`.logic\` files instead: they are the same language, and you edit whichever the project has, keeping its names.

## Files
- **manifest.json** — required. \`name\` (non-empty), \`version\`, \`main\` (the entry page, e.g. \`"main": "index.html"\`, which must exist), and \`files\` listing every page, ${logicExt}, .xdb and asset you create, by group: \`{ "ui": […], "logic": […], "xdb": […], "assets": […] }\`. A path listed that does not exist is refused. \`config.execution\` may be \`"main"\` or \`"worker"\`${python ? '; `config.python.packages` may be `["torch"]`' : ''}. \`icon\` names the app's icon, an image in the bundle (\`"icon": "assets/icon.svg"\`). Keep it when you rewrite the manifest; an .svg is text, so you can redraw it with write_file. Never write an \`entry\` field; the runtime does not read it.
- **permission.json** — what the app may use: \`{ "permissions": { "net": { "enabled": true, "allowed_hosts": ["api.example.com"] }, "storage": { "enabled": true } } }\`. \`enabled\` must be the boolean \`true\`. Capabilities: net, camera, mic, files, qr, ai, gpu, sync, storage, accel. Without the file, every capability is denied; declare exactly what the logic calls, in the same step you write the call.
- **index.html** — the main page; **pages/*.html** — the pages it imports (\`ui/*.ui\` in a project made before). **${entry}** — logic, referenced from a page with \`<script src>\`. **xdb/*.xdb** — seed records. **assets/** — images, sounds, fonts (already in the project; you write text files only, which an .svg is).
${python ? '- **.py** — Python: this project\'s logic language. Each file is a module, referenced from a page with `<script src="...">`. (A `.js` or `.logic` file is JavaScript, and one app cannot mix the two.)' : '- **.js** — JavaScript, run in a sandboxed VM (`.logic` in a project made before). Imported by a page, or by other logic, for shared code.'}
- Keep manifest.json true: \`"main"\` names the entry page, and \`"files"\` lists every page (under \`ui\`), ${logicExt}, .xdb and asset you create, by group.

## A page
A page is a template rooted at \`<App>\`, plus optional blocks in any order: \`<script src="${entry}"></script>\`${python ? '' : ' (or an inline `<script>…</script>`)'}, \`<data>\` for XDB collections, and \`<style>\` (or \`<link rel="stylesheet" href="styles.css">\` for a stylesheet of the app's). \`<App theme="light">\` takes \`light\`, \`dark\` or \`system\`.

**Theme.** An app's theme is kept in two places. manifest.json's \`config.theme.mode\` is the project's: \`"light"\` or \`"dark"\` is honoured wherever the app runs, and wins over the visitor's device and the theme of the site it is opened on; \`"system"\` (or no mode) follows the visitor. \`<App theme="light">\` or \`<App theme="dark">\` pins the page to that side wherever it runs, and wins over the manifest; a page that pins neither is drawn on the side \`config.theme.mode\` declares. When you change the app's theme, change both. For an app that follows the visitor, write \`"system"\` in the manifest and no \`theme\` on \`<App>\`.

\`\`\`xml
<script src="${entry}"></script>

<App theme="dark">
  <Stack direction="vertical" gap="md" padding="lg">
    <Heading level={1}>Counter</Heading>
    <Text>Count: {count}</Text>
    <Button variant="primary" @click={() => increment()}>Add one</Button>
  </Stack>
</App>
\`\`\`

### HTML in a page
A page is HTML with SoftN in it: lower-case tags are HTML elements (\`<div>\`, \`<p>\`, \`<a>\`, \`<table>\`, \`<form>\`, \`<input>\`, \`<svg>\` and its shapes), capitalised tags are SoftN components (\`<Button>\`, \`<Card>\`). Use components for controls and layout where one exists; plain HTML is for what none covers. In an HTML element:
- \`<br>\`, \`<img …>\`, \`<input …>\` need no \`/>\`. \`for\`, \`readonly\`, \`tabindex\` and HTML's other attribute names work as written.
- \`onclick="add()"\` and the other \`on…\` attributes run their code when the event fires, with the event as \`event\`; a closing \`return false\` cancels the default. No \`this\`, and no \`if\` or \`let\` (call a logic function).
- A \`<form>\` with no \`action\` never leaves its page: \`<form onsubmit="save(event)">\` runs \`save\`, and the page stays.
- \`<input value="Ada">\` starts with that value and can be edited; to read what is typed, \`:bind\` it.
- \`<img src="assets/logo.png">\` shows the bundle's file; so does \`url(assets/paper.png)\` in a stylesheet.
- Braces in text are expressions (write \`{"{"}\` for one), a line starting \`#if\` is SoftN's, and every element but a void one needs its closing tag. Scripts and stylesheets from other sites are not loaded.

### Props and expressions
- \`label="Save"\` is a string; \`size={3}\`, \`disabled={count > 3}\`, \`items={[1, 2]}\`, \`style={{ padding: "1rem" }}\` are expressions; a bare \`disabled\` is \`true\`. \`style="color: red; padding: 8px"\` also works as CSS text.
- \`{…}\` interpolates: \`<Text>Hello {name}</Text>\`, \`<Badge>{done ? "Done" : "Open"}</Badge>\`.
- Text reads like HTML around expressions: \`<Text>{count} tasks</Text>\` shows "3 tasks", and \`{first} {last}\` keeps its space.
- Template expressions support \`?:\`, \`??\`, \`&&\`, \`||\`, comparisons, \`in\`, \`instanceof\`, arithmetic including \`**\`, \`!\`, \`typeof\`, member access, \`?.\`, calls and method calls, array and object literals, spread (\`[...done, item]\`, \`Math.max(...scores)\`, \`{ ...base, color: "red" }\`), template literals, \`undefined\`, and arrow functions: \`t => t.done\`, \`(a, b) => a - b\`, \`() => save()\`. A handler may also have a block body, \`() => { count++; save() }\`, whose statements run in order (one to a line, or separated by \`;\`), and a \`return\` hands back its value. \`if\`, \`let\` and loops belong in a logic function the handler calls. A parameter may take its argument apart, have a default or gather the rest: \`([key, value]) => key\`, \`({ id, title }) => title\`, \`({ size = "md" }) => size\`, \`(n, step = 1) => n + step\`, \`(first, ...others) => others.length\`. An object literal may work out a key: \`{ ...filters, [name]: value }\`. A comment inside braces, \`{/* note */}\`, renders nothing.
- **Not supported in templates:** \`function\` expressions, \`async\`/\`await\`, regular expression literals, bitwise operators, a comma between expressions (\`(a, b)\` without \`=>\`), and \`{...props}\` spread onto a tag. Put anything more in a logic function and call it.
- Globals a template can use: \`Math\`, \`JSON\`, \`Number\`, \`String\`, \`Boolean\`, \`Array\`, \`Date\`, \`Map\`, \`Set\`, \`Object.keys\`/\`Object.values\`/\`Object.entries\` (nothing else of \`Object\`), \`parseInt\`, \`parseFloat\`, \`isNaN\`, \`encodeURIComponent\`, and helpers such as \`formatDate(value)\`, \`timeAgo(value)\`, \`currency(value)\`, \`truncate(text, n)\`. \`new\` constructs \`Date\`, \`Array\`, \`Map\` and \`Set\` only: \`{new Date().getFullYear()}\`.
- A variable may be called \`data\`, \`style\`, \`from\`, \`end\` or any other word markup also uses; JavaScript's own reserved words (\`if\`, \`function\`, \`return\`, \`delete\`) are not names.

### Events
- \`@click={() => save()}\`, \`@click={() => count++}\`, \`@click={() => open = !open}\` (one assignment or update is allowed, in a handler only: \`{count++}\` in the page itself changes nothing), \`@click={() => remove(item.id)}\`. Write handlers as arrows${python ? '' : ', or name a function: `@click={save}` calls it with the event'}.
- \`@name\` sets the component's \`onName\` prop: \`@change\` → onChange, \`@keydown\` → onKeyDown, \`@tick\` → onTick. lookup_components lists each component's events.
- \`@change\` and \`@input\` receive the **new value**, not a DOM event: \`@change={(value) => query = value}\`. Tabs' \`@change\` receives the tab key; a Checkbox's receives \`"on"\`, so toggle with \`@change={() => toggle(item.id)}\`.
- **Modifiers** go after the event name: \`@submit.prevent={() => save()}\` cancels the browser's default (a form does not reload the page), \`@click.stop\` keeps the event from the elements around it, \`@click.self\` runs only for a click on the element itself (a modal backdrop), and a key name runs the handler for that key only: \`@keydown.enter={() => add()}\`, \`@keydown.escape={() => close()}\`. Keys: enter, escape, space, tab, up, down, left, right, backspace, delete; held keys: ctrl, shift, alt, meta (\`@keydown.ctrl.enter\`). A script never receives the live event, so this is how a handler prevents a default.
- An arrow written in the template that names a parameter is given the event as plain data too: \`@keydown={(e) => e.key === "Enter" && add()}\`. It also has \`e.preventDefault()\`, \`e.stopPropagation()\`, and \`e.target\` / \`e.currentTarget\` as records of what the element holds (\`value\`, \`checked\`, \`dataset\`, its size). It is not the live DOM event: there is no \`e.target.parentNode\`, no \`querySelector\`, no document or window. Prefer a modifier (\`@keydown.enter\`, \`@submit.prevent\`) or \`:bind\` where one does the job.

### Binding
- **\`:bind={name}\` is the only two-way binding**: it shows the state and writes what the person types or checks back to it. \`<Input :bind={query} />\`, \`<Checkbox :bind={agreed} />\`, \`<Select :bind={choice} options={["A", "B"]} />\`.
- **\`:bind\` also holds what is open and which one is showing.** \`<Modal :bind={adding}>\` is open while \`adding\` is true and sets it false when the person closes it, so no close function is needed; the same for \`Drawer\`, \`Popover\` and \`Confirm\` (either answer shuts it; \`@confirm\` still runs). \`<Tabs :bind={tab} />\` holds the chosen tab's key, \`<Pagination :bind={page} />\` the page, \`<Accordion :bind={openPanels} />\` the open keys. To open one, set the variable: \`@click={() => adding = true}\`.
- **What a bound control holds.** \`<Input type="number" :bind={qty} />\` writes a number, and \`''\` while the field is empty, so \`qty + 1\` adds; a text field writes text. \`<DatePicker :bind={day} />\` holds the day as text, \`"2026-10-12"\`, and \`null\` once cleared: when a date is needed make it with \`new Date(day + "T00:00")\`, the person's own midnight (\`new Date(day)\` is midnight UTC, the day before west of Greenwich). \`Select\`, \`Radio\` and \`SegmentedControl\` hold the chosen option's own value, a number for a numbered option.
- **Inside \`#each\`, bind the loop item itself.** \`#each (todo in todos)\` with \`<Checkbox :bind={todo.done} />\` writes that row, and so does a handler that assigns to it: \`@click={() => todo.done = !todo.done}\`, \`@click={() => todo.count++}\`. This needs the list to be state (a state variable, or a path into one such as \`project.tasks\`). Over a list worked out in the page (\`todos.filter(…)\`), a computed value or a \`<data>\` collection, the item has nowhere in state to be written: nothing changes and the console says so. There, call a logic function with the item's id.
- Every other prop is one-way: \`value={x}\` or \`checked={x}\` only shows \`x\`. A controlled component needs its event too: \`<Tabs activeKey={tab} @change={(key) => tab = key} … />\`.

### Classes and styles
- \`className="card"\` puts a class on a component or a plain tag (\`class="card"\` is the same word); \`class:selected={isSelected}\` adds a class when true, hyphens included (\`class:is-active={on}\`). A class may also be a list or a record of conditions: \`className={["card", selected && "is-selected"]}\`, \`className={{ card: true, "is-selected": selected }}\`.
- \`id\`, \`data-…\` and \`aria-…\` written on Box, Stack, Grid, Card, Container, Center, Text, Heading, Button, Badge, Tag, Icon or Image reach the element, so a \`<style>\` rule can select by them: \`<Box className="tool" data-on={tool === "wall"}>\` with \`.tool[data-on="true"]\`. On other components they are dropped; wrap the component in a \`<div>\` that carries them.
- \`style:color={accent}\` sets one style property and leaves the rest of \`style\` alone: \`style:font-size="1.25rem"\`, \`style:--accent={colour}\` for a CSS variable, \`style:opacity={busy && 0.5}\` (a false or empty value sets nothing).
- **A component draws its own look with inline styles, and an inline style outranks a class rule.** For a property the component sets itself (a Heading's colour, for one), \`<Heading className="title">\` with \`.title { color: red }\` changes nothing and reports no error: write \`<Heading style:color="red">\`, or mark the rule \`!important\`. A class rule does apply to what the component leaves unset.
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
- Conditions go in parentheses. \`#elseif (…)\` and \`#else if (…)\` are the same branch. The index form is \`#each (item, i in items)\`; \`#each (item in items; let i)\` is a parse error.
- The loop variable may take the item apart: \`#each ({ id, title } in tasks)\`, \`#each ([name, total] in Object.entries(totals))\` (no defaults there; use \`??\` where the name is used).
- \`#each\` goes through a list, a \`Set\`, a \`Map\` (as \`[key, value]\` pairs), a record (its values, with the key as the second name: \`#each (value, key in settings)\`) and a whole number, which counts from 1 (\`#each (n in 5)\`). Text is not gone through letter by letter.
- Give a loop over records a key, so each row keeps its identity as the list changes: \`#each (task in tasks) key={task.id}\`. Without one the page warns when it renders.
- \`#if\` and \`#each\` may be written inside \`#empty\`.
- Inline forms: \`<Box if={open}>…</Box>\`, \`<Card each={items} as="item">{item.title}</Card>\`.

### Reuse: an imported page
\`<import TaskRow from="./task-row.html" />\` then \`<TaskRow />\` places that file's markup where the tag is, **in this page's scope**. It is not a component:
- It reads this page's state, calls this page's functions and sees a loop's variable, by the same names the page uses.
- Attributes and children written on the tag are dropped (\`<TaskRow task={task} @done={…} />\` passes nothing): there are no props, no events and no \`$emit\`. check_app warns at each such use.
- The file has no scope of its own. State that belongs to one use, such as which row is being edited, lives in the page's logic (\`editingId\`), never in the imported file.
- An imported file's \`<script>\` joins the page's one scope, its \`<data>\` is declared by the page, and its own \`<App>\` root is taken off.

\`index.html\`:

\`\`\`softn
<import TaskRow from="./task-row.html" />
<script src="${entry}"></script>

<App>
  <Stack direction="vertical" gap="sm" padding="lg">
    #each (task in tasks) key={task.id}
      <TaskRow />
    #end
  </Stack>
</App>
\`\`\`

\`task-row.html\`, which reads \`task\` from the loop it is placed in and \`editingId\`, \`draft\`, \`rename\` and \`save\` from the page's logic:

\`\`\`softn
<Card>
  #if (editingId === task.id)
    <Input :bind={draft} />
    <Button variant="primary" @click={() => save(task.id)}>Save</Button>
  #else
    <Text>{task.title}</Text>
    <Button variant="ghost" @click={() => rename(task.id)}>Rename</Button>
  #end
</Card>
\`\`\`

### Assets
\`<Image src={asset("assets/logo.png")} alt="Logo" />\` — the path is from the bundle root, never \`../\`. A component names a file in the bundle through \`asset("…")\`, which may be given a path it works out (\`asset("assets/avatars/" + person.id + ".png")\`); on a component a bare path (\`src="assets/logo.png"\`) loads nothing when the app runs, and the check reports it. On an HTML element, \`<img src="assets/logo.png">\` and \`<video poster="…">\` show the bundle's file as written.

## Data with XDB
- A \`.xdb\` file seeds a collection: \`{ "collection": "tasks", "records": [{ "id": "1", "title": "Buy milk", "done": false }] }\`. Every record needs a **string** \`id\` (a record without one is dropped). List the file in manifest.json's \`files.xdb\`, or its records are not loaded.
- Bind it in a page: \`<data><collection name="tasks" as="tasks" sort="created_at:desc" limit={50} /></data>\`, with optional \`filter={{ done: false }}\` (literal values only). The template reads a bound record's fields under \`data\`: \`{task.data.title}\`, with \`task.id\` and \`task.created_at\` beside it. A Table wants flat rows: \`data={tasks.map((t) => t.data)}\`. A page has only the collections a \`<data>\` block binds for it (its own block, or one in a page it imports or is imported into): a collection that is only a file under \`xdb/\` is an empty list to the page, and the check says which line would bind it.
- Logic does not see \`<data>\` collections.${python ? ' Python logic has no `db`: keep app records in state, or use `softn.storage.*`.' : ' Logic changes records with `db.create`, `db.update` and `db.delete`, and the bound collection updates.'}

${python ? `${PYTHON_LOGIC_SECTION}
${torch ? `
${PYTHON_TORCH_SECTION}` : PYTHON_TORCH_UNDECLARED}` : JAVASCRIPT_LOGIC_SECTION}

## Capabilities (softn.*)
\`softn.net.fetch\` (net), \`softn.camera.*\` (camera), \`softn.mic.*\` (mic), \`softn.files.*\` (files), \`softn.qr.*\` (qr), \`softn.ai.*\` (ai; \`softn.ai.gpu.*\` needs gpu), \`softn.storage.*\` (storage — server storage for a published app), \`db.startSync\` (sync). Each needs its capability in permission.json. \`softn.backend.call\`, \`softn.audio.*\` for bundle sounds and \`softn.input.captureKeys\` need none. The preview grants no capabilities, so these calls fail there; Run opens the app in the runtime.

## Common mistakes and the errors they cause
- \`<script src="app${logicExt}"></script>\` naming a file that is not there: "app${logicExt} is referenced by index.html but is not in the bundle".
- manifest.json \`main\` missing or wrong: "The manifest names no entry file (main)." / "The manifest's entry file is not in the bundle: …".
- manifest.json \`files\` listing a path that does not exist: "manifest.files.ui lists …, but the bundle has no such file."
- A capability called but not declared: "Network access not permitted. Add net.enabled to permission.json".
- An unknown capability in permission.json: "permission.json names capabilities the runtime does not have: …".
- Template syntax the parser cannot read: "Unexpected token … in expression: the rest of the expression up to its closing "}" is not supported here and was not read" — rewrite it as a call to a logic function.
${python ? `- JavaScript and Python in one app: "This app mixes Python and JavaScript logic. …".
- Inline Python: "index.html has an inline <script type="text/python"> block: put Python in a .py file and reference it with <script src="...">".
- A bad module name: "my-app.py cannot be a Python module: name it with letters, digits and underscores, starting with a letter".
- \`import torch\` without the declaration: "main.py imports torch, which an app asks for in manifest.json: …".` : `- \`:value={x}\` on an input and expecting typing to change \`x\`: it does not; use \`:bind\`.`}
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
