/**
 * SoftN App Templates
 *
 * Starting points for common apps over a collection of records. Each
 * generator returns one page: markup, with its logic in a `<logic>` block and
 * its rules in a `<style>` block, written as the language is written today.
 * State is the logic's top-level variables, a field is two-way with `:bind`,
 * a list is drawn with `#each`, and records are read and written through
 * `db`: read in `_init()` and again after each change.
 *
 * The pages name components by their tags (`Input`, `TextArea`, `Checkbox`,
 * `Select`, `Button`, `Card`, `Confirm`), which a host registers from
 * `@softn/components`.
 */

export interface TemplateField {
  name: string;
  type: 'text' | 'number' | 'boolean' | 'date' | 'select' | 'textarea';
  label?: string;
  placeholder?: string;
  required?: boolean;
  options?: string[]; // For select type
  defaultValue?: unknown;
}

export interface TemplateConfig {
  name: string;
  collection: string;
  fields: TemplateField[];
  features?: {
    /** A search field over the text fields (over every field when none is text). */
    search?: boolean;
    /** The list in order, and column headings that sort: by the field named, or by the first field for `true`. */
    sort?: boolean | string;
    /** A choice above the list for each select and yes/no field, to show only the records with that value. */
    filter?: boolean;
    /** The list a page of ten at a time. */
    pagination?: boolean;
    /**
     * Not generated. Saving a file needs the `files` permission, which an
     * app declares in its bundle's permission.json and a page cannot give
     * itself; with it, a logic function can call `softn.files.saveFile`.
     */
    export?: boolean;
  };
}

/** How many records a page of the list holds, with `features.pagination`. */
const PAGE_SIZE = 10;

/** A value as logic writes it. `</` would end the `<logic>` block it is written in. */
function literal(value: unknown): string {
  return (JSON.stringify(value) ?? 'null').replace(/<\//g, '<\\/');
}

/** Whether a name can be written bare: after a dot, or as a record's key. */
function isPlainName(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name);
}

/** `record.name`, or `record["a name"]` for a name a dot cannot take. */
function member(record: string, name: string): string {
  return isPlainName(name) ? `${record}.${name}` : `${record}[${JSON.stringify(name)}]`;
}

/**
 * The `<data>` block that declares a collection. Its records go by a name
 * there, which has to be one an expression can write: the collection's own
 * where it is, and otherwise that name with `_` for what cannot stand in one
 * (`to-buy` is `to_buy`). The pages draw the records their logic reads, so
 * nothing in them goes by that name.
 */
function dataBlock(collection: string): string {
  const named = isPlainName(collection) ? collection : collection.replace(/[^\w$]/g, '_').replace(/^(?=\d|$)/, '_');
  return `<data>
  <collection name="${attr(collection)}" as="${named}" />
</data>`;
}

/** A record's key as logic writes it: `name`, or `"a name"`. */
function key(name: string): string {
  return isPlainName(name) ? name : literal(name);
}

/** Words between tags: what would be read as a tag, an entity or an expression is written out. */
function text(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[{}]/g, (brace) => `{"${brace}"}`);
}

/** A value between double quotes. */
function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Words inside `<!-- -->`, which two hyphens would end. */
function comment(value: string): string {
  return value.replace(/-{2,}/g, '-');
}

function labelOf(field: TemplateField): string {
  return field.label || field.name;
}

/** What a field holds in a new record. */
function defaultOf(field: TemplateField): unknown {
  if (field.defaultValue !== undefined) return field.defaultValue;
  if (field.type === 'boolean') return false;
  if (field.type === 'number') return 0;
  return '';
}

/** What `save()` stores for a field, from what the form holds. */
function storedValue(field: TemplateField): string {
  const held = member('form', field.name);
  switch (field.type) {
    case 'boolean':
      return `${held} === true`;
    case 'number':
      // A number field holds a number, or "" while it is empty.
      return `${held} === "" || ${held} === null || ${held} === undefined ? null : Number(${held})`;
    case 'select':
    case 'date':
      return `${held} ?? ""`;
    default:
      return `String(${held} ?? "").trim()`;
  }
}

/** Whether what `save()` is about to store for a required field is nothing. */
function missingTest(field: TemplateField): string {
  const stored = member('data', field.name);
  if (field.type === 'boolean') return `${stored} !== true`;
  if (field.type === 'number') return `${stored} === null || isNaN(${stored})`;
  return `${stored} === ""`;
}

/**
 * Generate a CRUD app template for managing a collection
 */
export function generateCrudApp(config: TemplateConfig): string {
  const { name, collection, fields, features = {} } = config;
  const indent = (lines: string[], by: string) => lines.map((line) => `${by}${line}`).join('\n');

  // What each feature adds.
  const search = Boolean(features.search);
  const textFields = fields.filter((f) => f.type === 'text' || f.type === 'textarea');
  const searched = textFields.length > 0 ? textFields : fields;
  const filterFields = features.filter
    ? fields.filter((f) => f.type === 'boolean' || (f.type === 'select' && (f.options ?? []).length > 0))
    : [];
  const sorted = Boolean(features.sort) && fields.length > 0;
  const sortField =
    typeof features.sort === 'string' && fields.some((f) => f.name === features.sort) ? features.sort : (fields[0]?.name ?? '');
  const paged = Boolean(features.pagination);
  const narrowed = search || filterFields.length > 0;

  // ── Logic ────────────────────────────────────────────────────────────────

  const blankForm = `{ ${fields.map((f) => `${key(f.name)}: ${literal(defaultOf(f))}`).join(', ')} }`;

  const stateLines = [
    '// What the form holds: a value for each field',
    `let form = ${blankForm}`,
    '// The record being edited (null for a new one), and whether the form is open',
    'let editingId = null',
    'let showForm = false',
    'let formError = ""',
    '// The record Delete was pressed on, while the person is asked',
    'let removingId = null',
    'let confirmingRemove = false',
    '// The records, as they were last read',
    'let records = []',
  ];
  // With nothing to narrow, order or page, the list is the records. Otherwise
  // it is `filteredItems`, which `relist()` works out: a logic function and
  // not a `$:` value, so the app runs in a worker as well as on the page's
  // thread, where a `$:` would keep it.
  const listed = narrowed || sorted || paged;
  const shown = listed ? 'filteredItems' : 'records';
  if (listed) stateLines.push('// The records the list shows', 'let filteredItems = []');
  if (search) stateLines.push('// What is typed into the search field', 'let searchQuery = ""');
  if (filterFields.length > 0) {
    stateLines.push(
      '// The value chosen for each filter ("" shows every record)',
      `let filters = { ${filterFields.map((f) => `${key(f.name)}: ""`).join(', ')} }`
    );
  }
  if (sorted) stateLines.push('// The field the list is in order of, and which way', `let sortBy = ${literal(sortField)}`, 'let sortDescending = false');
  if (paged) stateLines.push('// The page of the list shown, and how many there are', 'let page = 1', 'let pageCount = 1');

  const functions: string[] = [];

  functions.push(`// Read the records again: once at the start, and after each change
function refresh() {
  records = db.query(${literal(collection)})${listed ? '\n  relist()' : ''}
}

function _init() {
  refresh()
}`);

  if (listed) {
    const steps = [narrowed ? 'let list = records.filter(matches)' : 'let list = records'];
    if (sorted) steps.push('list = inOrder(list, sortBy, sortDescending)');
    if (paged) {
      steps.push(
        `pageCount = Math.max(1, Math.ceil(list.length / ${PAGE_SIZE}))`,
        'page = Math.min(Math.max(1, page), pageCount)',
        `list = list.slice((page - 1) * ${PAGE_SIZE}, page * ${PAGE_SIZE})`
      );
    }
    steps.push('filteredItems = list');
    functions.push(`// Work out the list again: after the records change, and after what narrows, orders or pages them does
function relist() {
${indent(steps, '  ')}
}`);
  }

  if (narrowed) {
    const tests: string[] = [];
    for (const f of filterFields) {
      const chosen = member('filters', f.name);
      const held = member('item.data', f.name);
      tests.push(
        f.type === 'boolean'
          ? `if (${chosen} !== "" && (${held} === true) !== (${chosen} === "yes")) return false`
          : `if (${chosen} !== "" && ${held} !== ${chosen}) return false`
      );
    }
    if (search) {
      tests.push(
        'const query = String(searchQuery ?? "").trim().toLowerCase()',
        'if (query === "") return true',
        `return ${searched.map((f) => `String(${member('item.data', f.name)} ?? "").toLowerCase().includes(query)`).join(' ||\n    ') || 'true'}`
      );
    } else {
      tests.push('return true');
    }
    functions.push(`// Whether the list shows a record
function matches(item) {
${indent(tests, '  ')}
}`);
  }

  if (sorted) {
    functions.push(`// A list of records in order of one field: numbers by size, anything else as text
function inOrder(list, field, descending) {
  const ordered = list.slice()
  ordered.sort(function (a, b) {
    const x = a.data[field]
    const y = b.data[field]
    if (typeof x === "number" && typeof y === "number") return x - y
    const s = String(x ?? "").toLowerCase()
    const t = String(y ?? "").toLowerCase()
    return s < t ? -1 : s > t ? 1 : 0
  })
  if (descending) ordered.reverse()
  return ordered
}

// A column heading was pressed: order by it, or turn the order round
function sortOn(field) {
  if (sortBy === field) {
    sortDescending = !sortDescending
  } else {
    sortBy = field
    sortDescending = false
  }
  relist()
}`);
  }

  if (paged) {
    functions.push(`function showPage(number) {
  page = number
  relist()
}`);
  }

  // A record as `save()` stores it, and as `edit()` puts it in the form: a field
  // the record does not have starts as a new record's does, and a number that
  // was left empty is an empty field again, not a 0 that the next save keeps.
  const storedLines = fields.map((f) => `${key(f.name)}: ${storedValue(f)}`);
  const editedLines = fields.map(
    (f) => `${key(f.name)}: ${member('item.data', f.name)} ?? ${f.type === 'number' ? '""' : literal(defaultOf(f))}`
  );
  const requiredLines = fields
    .filter((f) => f.required)
    .map((f) => `if (${missingTest(f)}) { formError = ${literal(`${labelOf(f)} is required.`)}; return }`);
  const record = (lines: string[]) => (lines.length > 0 ? `{\n${indent(lines, '    ').replace(/\n/g, ',\n')}\n  }` : '{}');

  functions.push(`// Open the form for a new record, or close it
function toggleForm() {
  if (showForm) {
    cancel()
  } else {
    form = ${blankForm}
    editingId = null
    formError = ""
    showForm = true
  }
}

// Save a new record, or the changes to the one being edited
function save() {
  const data = ${record(storedLines)}
${[
  ...requiredLines,
  `if (editingId && db.get(${literal(collection)}, editingId)) {`,
  '  db.update(editingId, data)',
  '} else {',
  `  db.create(${literal(collection)}, data)`,
  '}',
  'cancel()',
  'refresh()',
]
  .map((line) => `  ${line}`)
  .join('\n')}
}

// Edit a record
function edit(id) {
  const item = db.get(${literal(collection)}, id)
  if (!item) {
    refresh()
    return
  }
  form = ${record(editedLines)}
  editingId = item.id
  formError = ""
  showForm = true
}

// Delete a record: ask first, and delete it when the person agrees
function remove(id) {
  removingId = id
  confirmingRemove = true
}

function confirmRemove() {
  if (removingId && db.get(${literal(collection)}, removingId)) {
    db.delete(removingId)
  }
  if (removingId === editingId) cancel()
  removingId = null
  refresh()
}

// Close the form and empty it
function cancel() {
  form = ${blankForm}
  editingId = null
  formError = ""
  showForm = false
}`);

  const logic = [indent(stateLines, '  '), ...functions.map((f) => indent(f.split('\n'), '  '))]
    .join('\n\n')
    // No spaces on a line that is only indentation.
    .replace(/^[ \t]+$/gm, '');

  // ── Markup ───────────────────────────────────────────────────────────────

  const formFields = fields.map((f) => generateFormField(f)).join('\n        ');

  const tableHeaders = fields
    .map((f) => {
      const label = text(labelOf(f));
      if (!sorted) return `            <th>${label}</th>`;
      const here = `sortBy === ${JSON.stringify(f.name)}`;
      return `            <th aria-sort={${here} ? (sortDescending ? "descending" : "ascending") : "none"}>
              <button type="button" class="sort-button" @click={() => sortOn(${JSON.stringify(f.name)})}>${label}{${here} ? (sortDescending ? " ▼" : " ▲") : ""}</button>
            </th>`;
    })
    .join('\n');

  const tableCells = fields
    .map((f) => {
      const held = member('item.data', f.name);
      return `              <td>{${f.type === 'boolean' ? `${held} ? "Yes" : "No"` : held}}</td>`;
    })
    .join('\n');

  // `:bind` keeps what is typed in `searchQuery`, and the handler beside it,
  // which runs once the binding has written, has the logic work the list out
  // again. It is `@change`, which `Input` calls at each keystroke: the
  // component takes no `@input`. (This once had `:value` and an `@input`
  // whose `(e) => … e.target.value` wrote nothing: a handler in braces there
  // is handed the text typed, not the event.)
  const tools: string[] = [];
  if (search) {
    tools.push(`<Input
        placeholder="Search..."
        aria-label="Search"
        :bind={searchQuery}
        @change={() => relist()}
      />`);
  }
  for (const f of filterFields) {
    const options =
      f.type === 'boolean' ? '[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]' : JSON.stringify(f.options ?? []);
    tools.push(`<Select
        aria-label="${attr(`Show by ${labelOf(f)}`)}"
        placeholder="${attr(`${labelOf(f)}: all`)}"
        options={${options}}
        clearable
        :bind={${member('filters', f.name)}}
        @change={() => relist()}
      />`);
  }
  const toolbar =
    tools.length > 0
      ? `
    <div class="list-tools">
      ${tools.join('\n      ')}
    </div>
`
      : '';

  const pages = paged
    ? `

      #if (pageCount > 1)
        <div class="pages">
          <Button size="sm" variant="secondary" disabled={page <= 1} @click={() => showPage(page - 1)}>Previous</Button>
          <span>Page {page} of {pageCount}</span>
          <Button size="sm" variant="secondary" disabled={page >= pageCount} @click={() => showPage(page + 1)}>Next</Button>
        </div>
      #end`
    : '';

  const noMatch = narrowed
    ? `
    #elseif (records.length > 0)
      <div class="empty-state">
        <p>No items match.</p>
      </div>`
    : '';

  return `<!-- ${comment(name)} - Generated SoftN CRUD App -->

${dataBlock(collection)}

<logic>
${logic}
</logic>

<div class="app-container">
  <header class="app-header">
    <h1>${text(name)}</h1>
    <Button @click={() => toggleForm()}>
      {showForm ? "Cancel" : "Add New"}
    </Button>
  </header>

  #if (showForm)
    <Card class="form-card">
      <form @submit.prevent={() => save()}>
        ${formFields}
        #if (formError)
          <p class="form-error" role="alert">{formError}</p>
        #end
        <div class="form-actions">
          <Button type="submit" variant="primary">
            {editingId ? "Update" : "Create"}
          </Button>
          <Button type="button" variant="secondary" @click={() => cancel()}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  #end

  <Card class="list-card">${toolbar}
    #if (${shown}.length > 0)
      <table class="data-table">
        <thead>
          <tr>
${tableHeaders}
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          #each (item in ${shown}) key={item.id}
            <tr>
${tableCells}
              <td class="actions">
                <Button size="sm" @click={() => edit(item.id)}>Edit</Button>
                <Button size="sm" variant="danger" @click={() => remove(item.id)}>Delete</Button>
              </td>
            </tr>
          #end
        </tbody>
      </table>${pages}${noMatch}
    #else
      <div class="empty-state">
        <p>No items yet. Click "Add New" to create one.</p>
      </div>
    #end
  </Card>

  <Confirm
    :bind={confirmingRemove}
    title="Delete this item?"
    message="It cannot be brought back."
    confirmText="Delete"
    variant="danger"
    @confirm={() => confirmRemove()}
  />
</div>

<style>
  .app-container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 2rem;
  }

  .app-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 2rem;
  }

  .app-header h1 {
    margin: 0;
  }

  .form-card {
    margin-bottom: 2rem;
    padding: 1.5rem;
  }

  .form-group {
    margin-bottom: 1rem;
  }

  .form-error {
    margin: 0 0 1rem;
    color: #f87171;
  }

  .form-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 1.5rem;
  }

  .list-card {
    padding: 1.5rem;
  }

  .list-tools {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .data-table {
    width: 100%;
    border-collapse: collapse;
  }

  .data-table th,
  .data-table td {
    padding: 0.75rem;
    text-align: left;
    border-bottom: 1px solid #3f3f46;
  }

  .data-table th {
    font-weight: 600;
    background: #27272a;
  }

  .sort-button {
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .actions {
    display: flex;
    gap: 0.5rem;
  }

  .pages {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 1rem;
  }

  .empty-state {
    text-align: center;
    padding: 3rem;
    color: #6b7280;
  }
</style>
`;
}

function generateFormField(field: TemplateField): string {
  const label = attr(labelOf(field));
  const placeholder = field.placeholder ? `\n            placeholder="${attr(field.placeholder)}"` : '';
  const required = field.required ? ' required' : '';
  const bound = `:bind={${member('form', field.name)}}`;

  switch (field.type) {
    case 'number':
      return `<div class="form-group">
          <Input
            label="${label}"
            type="number"${placeholder}
            ${bound}${required}
          />
        </div>`;

    case 'textarea':
      return `<div class="form-group">
          <TextArea
            label="${label}"${placeholder}
            ${bound}${required}
          />
        </div>`;

    case 'boolean':
      return `<div class="form-group">
          <Checkbox
            ${bound}
            label="${label}"
          />
        </div>`;

    case 'date':
      return `<div class="form-group">
          <Input
            label="${label}"
            type="date"
            ${bound}${required}
          />
        </div>`;

    case 'select':
      // A field that must be filled is not given the button that empties it.
      return `<div class="form-group">
          <Select
            label="${label}"
            placeholder="Select..."
            options={${JSON.stringify(field.options ?? [])}}
            ${bound}${field.required ? ' required' : ' clearable'}
          />
        </div>`;

    case 'text':
    default:
      return `<div class="form-group">
          <Input
            label="${label}"
            type="text"${placeholder}
            ${bound}${required}
          />
        </div>`;
  }
}

/**
 * Generate a Todo app template
 */
export function generateTodoApp(collectionName = 'todos'): string {
  return generateCrudApp({
    name: 'Todo App',
    collection: collectionName,
    fields: [
      {
        name: 'title',
        type: 'text',
        label: 'Title',
        placeholder: 'What needs to be done?',
        required: true,
      },
      { name: 'completed', type: 'boolean', label: 'Completed', defaultValue: false },
      {
        name: 'priority',
        type: 'select',
        label: 'Priority',
        options: ['low', 'medium', 'high'],
        defaultValue: 'medium',
      },
    ],
    features: { search: true },
  });
}

/**
 * Generate a Notes app template
 */
export function generateNotesApp(collectionName = 'notes'): string {
  return generateCrudApp({
    name: 'Notes',
    collection: collectionName,
    fields: [
      { name: 'title', type: 'text', label: 'Title', placeholder: 'Note title', required: true },
      { name: 'content', type: 'textarea', label: 'Content', placeholder: 'Write your note...' },
      {
        name: 'category',
        type: 'select',
        label: 'Category',
        options: ['personal', 'work', 'ideas', 'other'],
      },
    ],
    features: { search: true },
  });
}

/**
 * Generate a Contacts app template
 */
export function generateContactsApp(collectionName = 'contacts'): string {
  return generateCrudApp({
    name: 'Contacts',
    collection: collectionName,
    fields: [
      { name: 'name', type: 'text', label: 'Name', required: true },
      { name: 'email', type: 'text', label: 'Email' },
      { name: 'phone', type: 'text', label: 'Phone' },
      { name: 'company', type: 'text', label: 'Company' },
      { name: 'notes', type: 'textarea', label: 'Notes' },
    ],
    features: { search: true },
  });
}

/**
 * Generate a simple list template (minimal CRUD)
 */
export function generateSimpleList(config: {
  name: string;
  collection: string;
  itemField: string;
}): string {
  const collection = literal(config.collection);
  const itemField = key(config.itemField);
  // Whether an item is ticked off, beside its words: under another name where the words are `completed`.
  const flag = config.itemField === 'completed' ? 'done' : 'completed';

  return `<!-- ${comment(config.name)} - Simple List -->

${dataBlock(config.collection)}

<logic>
  // What is being typed, and the records as they were last read
  let newItem = ""
  let items = []

  // Read the records again: once at the start, and after each change
  function refresh() {
    items = db.query(${collection})
  }

  function _init() {
    refresh()
  }

  function add() {
    const words = String(newItem ?? "").trim()
    if (words === "") return
    db.create(${collection}, { ${itemField}: words, ${flag}: false })
    newItem = ""
    refresh()
  }

  function remove(id) {
    if (db.get(${collection}, id)) db.delete(id)
    refresh()
  }

  // Tick an item off, or bring it back
  function toggle(id) {
    const item = db.get(${collection}, id)
    if (item) db.update(id, { ${flag}: !item.data.${flag} })
    refresh()
  }
</logic>

<div class="simple-list">
  <h2>${text(config.name)}</h2>

  <form @submit.prevent={() => add()} class="add-form">
    <Input
      placeholder="Add new item..."
      aria-label="New item"
      :bind={newItem}
    />
    <Button type="submit">Add</Button>
  </form>

  <ul class="items">
    #each (item in items) key={item.id}
      <li class="item" class:done={item.data.${flag}}>
        <Checkbox
          checked={item.data.${flag} === true}
          label={${member('item.data', config.itemField)}}
          @change={() => toggle(item.id)}
        />
        <Button size="sm" variant="ghost" aria-label="Remove" @click={() => remove(item.id)}>×</Button>
      </li>
    #empty
      <li class="empty">No items yet</li>
    #end
  </ul>

  <p class="count">{items.length} {items.length === 1 ? "item" : "items"}</p>
</div>

<style>
  .simple-list {
    max-width: 500px;
    margin: 2rem auto;
    padding: 1.5rem;
  }

  .add-form {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
  }

  .add-form input {
    flex: 1;
  }

  .items {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem;
    border-bottom: 1px solid #3f3f46;
  }

  .item.done {
    opacity: 0.6;
    text-decoration: line-through;
  }

  .empty {
    text-align: center;
    padding: 2rem;
    color: #9ca3af;
  }

  .count {
    text-align: center;
    color: #6b7280;
    font-size: 0.875rem;
    margin-top: 1rem;
  }
</style>
`;
}

/**
 * Generate a Kanban board template
 */
export function generateKanbanBoard(config: {
  name: string;
  collection: string;
  columns: string[];
}): string {
  const { name, columns } = config;
  const collection = literal(config.collection);

  return `<!-- ${comment(name)} - Kanban Board -->

${dataBlock(config.collection)}

<logic>
  let columns = ${literal(columns)}
  // The task being typed, and the column it will be added to
  let newTask = ""
  let newColumn = ${literal(columns[0] ?? '')}
  // The board as it was last read: each column with its tasks, in order
  let board = []
  // The task being dragged
  let draggedId = null

  // Read the tasks again: once at the start, and after each change
  function refresh() {
    const tasks = db.query(${collection})
    board = columns.map(function (column) {
      return { name: column, tasks: getTasksByStatus(tasks, column) }
    })
  }

  function _init() {
    refresh()
  }

  function getTasksByStatus(tasks, status) {
    const found = tasks.filter(function (task) {
      return task.data.status === status
    })
    found.sort(function (a, b) {
      return (a.data.order || 0) - (b.data.order || 0)
    })
    return found
  }

  function addTask() {
    const title = String(newTask ?? "").trim()
    if (title === "") return
    db.create(${collection}, {
      title: title,
      status: newColumn,
      order: Date.now()
    })
    newTask = ""
    refresh()
  }

  function moveTask(taskId, newStatus) {
    if (db.get(${collection}, taskId)) db.update(taskId, { status: newStatus, order: Date.now() })
    refresh()
  }

  // Move a task one column along (1) or back (-1), for a phone or a keyboard
  function shiftTask(taskId, by) {
    const task = db.get(${collection}, taskId)
    if (!task) return
    const to = columns.indexOf(task.data.status) + by
    if (to >= 0 && to < columns.length) moveTask(taskId, columns[to])
  }

  function deleteTask(id) {
    if (db.get(${collection}, id)) db.delete(id)
    refresh()
  }

  function onDragStart(id) {
    draggedId = id
  }

  function onDrop(status) {
    if (draggedId) {
      moveTask(draggedId, status)
      draggedId = null
    }
  }
</logic>

<div class="kanban">
  <header class="kanban-header">
    <h1>${text(name)}</h1>
    <form @submit.prevent={() => addTask()} class="add-form">
      <Input placeholder="New task..." aria-label="New task" :bind={newTask} />
      <Select aria-label="Column" options={columns} :bind={newColumn} />
      <Button type="submit">Add</Button>
    </form>
  </header>

  <div class="kanban-board">
    #each (column, at in board) key={column.name}
      <div
        class="kanban-column"
        @dragover={(e) => e.preventDefault()}
        @drop={() => onDrop(column.name)}
      >
        <h3 class="column-title">
          {column.name}
          <span class="count">({column.tasks.length})</span>
        </h3>
        <div class="column-tasks">
          #each (task in column.tasks) key={task.id}
            <div
              class="task-card"
              draggable="true"
              @dragstart={() => onDragStart(task.id)}
            >
              <span class="task-title">{task.data.title}</span>
              <span class="task-actions">
                <Button size="sm" variant="ghost" aria-label="Move back" disabled={at === 0} @click={() => shiftTask(task.id, -1)}>‹</Button>
                <Button size="sm" variant="ghost" aria-label="Move on" disabled={at === board.length - 1} @click={() => shiftTask(task.id, 1)}>›</Button>
                <Button size="sm" variant="ghost" aria-label="Delete" @click={() => deleteTask(task.id)}>×</Button>
              </span>
            </div>
          #empty
            <div class="empty-column">Drop tasks here</div>
          #end
        </div>
      </div>
    #end
  </div>
</div>

<style>
  .kanban {
    padding: 1.5rem;
    min-height: 100vh;
    background: #18181b;
  }

  .kanban-header {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
  }

  .kanban-header h1 {
    margin: 0;
  }

  .add-form {
    display: flex;
    gap: 0.5rem;
  }

  .kanban-board {
    display: flex;
    gap: 1rem;
    overflow-x: auto;
    padding-bottom: 1rem;
  }

  .kanban-column {
    flex: 0 0 300px;
    background: #fff;
    border-radius: 0.5rem;
    padding: 1rem;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }

  .column-title {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin: 0 0 1rem;
    font-size: 1rem;
    font-weight: 600;
  }

  .column-title .count {
    font-weight: normal;
    color: #9ca3af;
  }

  .column-tasks {
    min-height: 200px;
  }

  .task-card {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem;
    background: #27272a;
    border-radius: 0.375rem;
    margin-bottom: 0.5rem;
    cursor: grab;
    transition: box-shadow 0.2s;
  }

  .task-card:hover {
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }

  .task-card:active {
    cursor: grabbing;
  }

  .task-actions {
    display: flex;
    flex: none;
  }

  .empty-column {
    text-align: center;
    padding: 2rem;
    color: #9ca3af;
    border: 2px dashed #3f3f46;
    border-radius: 0.375rem;
  }
</style>
`;
}

// Export all generators
export const templates = {
  crud: generateCrudApp,
  todo: generateTodoApp,
  notes: generateNotesApp,
  contacts: generateContactsApp,
  simpleList: generateSimpleList,
  kanban: generateKanbanBoard,
};
