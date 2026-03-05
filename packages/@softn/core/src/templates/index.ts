/**
 * SoftN App Templates
 *
 * Pre-built templates for common app patterns that work with XDB.
 * These templates make it easy to create full apps in minutes.
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
    search?: boolean;
    sort?: boolean | string;
    filter?: boolean;
    pagination?: boolean;
    export?: boolean;
  };
}

/**
 * Generate a CRUD app template for managing a collection
 */
export function generateCrudApp(config: TemplateConfig): string {
  const { name, collection, fields, features = {} } = config;

  const stateFields = fields
    .map((f) => {
      const defaultVal =
        f.defaultValue !== undefined
          ? JSON.stringify(f.defaultValue)
          : f.type === 'boolean'
            ? 'false'
            : f.type === 'number'
              ? '0'
              : '""';
      return `  ${f.name}: ${defaultVal}`;
    })
    .join(',\n');

  const formFields = fields.map((f) => generateFormField(f)).join('\n        ');
  const tableHeaders = fields.map((f) => `            <th>${f.label || f.name}</th>`).join('\n');
  const tableCells = fields.map((f) => `            <td>{item.data.${f.name}}</td>`).join('\n');
  const clearFormState = fields
    .map((f) => {
      const defaultVal =
        f.defaultValue !== undefined
          ? JSON.stringify(f.defaultValue)
          : f.type === 'boolean'
            ? 'false'
            : f.type === 'number'
              ? '0'
              : '""';
      return `  state.${f.name} = ${defaultVal}`;
    })
    .join('\n');

  const searchFeature = features.search
    ? `
      <Input
        placeholder="Search..."
        :value={searchQuery}
        @input={(e) => state.searchQuery = e.target.value}
      />`
    : '';

  const searchLogic = features.search
    ? `
  searchQuery: ""`
    : '';

  const filterLogic = features.search
    ? `
  // Filter by search query
  const filteredItems = filter(${collection}, item =>
    ${
      fields
        .filter((f) => f.type === 'text' || f.type === 'textarea')
        .map((f) => `item.data.${f.name}?.toLowerCase().includes(state.searchQuery.toLowerCase())`)
        .join(' ||\n    ') || 'true'
    }
  )`
    : `const filteredItems = ${collection}`;

  return `<!-- ${name} - Generated SoftN CRUD App -->

<data>
  <collection name="${collection}" as="${collection}" />
</data>

<logic>
  // Form state
${stateFields},
  editingId: null,
  showForm: false${searchLogic}

  // Save or update record
  async function save() {
    const data = {
${fields.map((f) => `      ${f.name}: state.${f.name}`).join(',\n')}
    }

    if (state.editingId) {
      await xdb.update(state.editingId, data)
      state.editingId = null
    } else {
      await xdb.create("${collection}", data)
    }

    // Reset form
${clearFormState}
    state.showForm = false
  }

  // Edit a record
  function edit(item) {
${fields.map((f) => `    state.${f.name} = item.data.${f.name}`).join('\n')}
    state.editingId = item.id
    state.showForm = true
  }

  // Delete a record
  async function remove(id) {
    if (confirm("Are you sure you want to delete this item?")) {
      await xdb.delete(id)
    }
  }

  // Cancel editing
  function cancel() {
${clearFormState}
    state.editingId = null
    state.showForm = false
  }
</logic>

<div class="app-container">
  <header class="app-header">
    <h1>${name}</h1>
    <Button @click={() => state.showForm = !state.showForm}>
      {state.showForm ? "Cancel" : "Add New"}
    </Button>
  </header>

  #if (state.showForm)
    <Card class="form-card">
      <form @submit={(e) => { e.preventDefault(); save() }}>
        ${formFields}
        <div class="form-actions">
          <Button type="submit" variant="primary">
            {state.editingId ? "Update" : "Create"}
          </Button>
          <Button type="button" variant="secondary" @click={cancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  #end

  <Card class="list-card">${searchFeature}
    ${filterLogic}

    #if (count(filteredItems) > 0)
      <table class="data-table">
        <thead>
          <tr>
${tableHeaders}
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          #each (item in filteredItems)
            <tr>
${tableCells}
              <td class="actions">
                <Button size="sm" @click={() => edit(item)}>Edit</Button>
                <Button size="sm" variant="danger" @click={() => remove(item.id)}>Delete</Button>
              </td>
            </tr>
          #end
        </tbody>
      </table>
    #else
      <div class="empty-state">
        <p>No items yet. Click "Add New" to create one.</p>
      </div>
    #end
  </Card>
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

  .form-group label {
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
  }

  .form-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 1.5rem;
  }

  .list-card {
    padding: 1.5rem;
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

  .actions {
    display: flex;
    gap: 0.5rem;
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
  const label = field.label || field.name;
  const required = field.required ? ' required' : '';

  switch (field.type) {
    case 'text':
      return `<div class="form-group">
          <label>${label}</label>
          <Input
            type="text"
            placeholder="${field.placeholder || ''}"
            :value={${field.name}}${required}
          />
        </div>`;

    case 'number':
      return `<div class="form-group">
          <label>${label}</label>
          <Input
            type="number"
            placeholder="${field.placeholder || ''}"
            :value={${field.name}}${required}
          />
        </div>`;

    case 'textarea':
      return `<div class="form-group">
          <label>${label}</label>
          <Textarea
            placeholder="${field.placeholder || ''}"
            :value={${field.name}}${required}
          />
        </div>`;

    case 'boolean':
      return `<div class="form-group">
          <Checkbox
            :checked={${field.name}}
            label="${label}"
          />
        </div>`;

    case 'date':
      return `<div class="form-group">
          <label>${label}</label>
          <Input
            type="date"
            :value={${field.name}}${required}
          />
        </div>`;

    case 'select': {
      const options = (field.options || [])
        .map((opt) => `<option value="${opt}">${opt}</option>`)
        .join('\n              ');
      return `<div class="form-group">
          <label>${label}</label>
          <Select :value={${field.name}}${required}>
            <option value="">Select...</option>
            ${options}
          </Select>
        </div>`;
    }

    default:
      return `<div class="form-group">
          <label>${label}</label>
          <Input
            type="text"
            :value={${field.name}}${required}
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
  return `<!-- ${config.name} - Simple List -->

<data>
  <collection name="${config.collection}" as="items" />
</data>

<logic>
  newItem: ""

  async function add() {
    if (state.newItem.trim()) {
      await xdb.create("${config.collection}", { ${config.itemField}: state.newItem })
      state.newItem = ""
    }
  }

  async function remove(id) {
    await xdb.delete(id)
  }

  async function toggle(item) {
    await xdb.update(item.id, { completed: !item.data.completed })
  }
</logic>

<div class="simple-list">
  <h2>${config.name}</h2>

  <form @submit={(e) => { e.preventDefault(); add() }} class="add-form">
    <Input
      placeholder="Add new item..."
      :value={newItem}
    />
    <Button type="submit">Add</Button>
  </form>

  <ul class="items">
    #each (item in items)
      <li class="item">
        <span>{item.data.${config.itemField}}</span>
        <Button size="sm" variant="ghost" @click={() => remove(item.id)}>×</Button>
      </li>
    #empty
      <li class="empty">No items yet</li>
    #end
  </ul>

  <p class="count">{count(items)} item{count(items) !== 1 ? 's' : ''}</p>
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
  const { name, collection, columns } = config;
  const columnsJson = JSON.stringify(columns);

  return `<!-- ${name} - Kanban Board -->

<data>
  <collection name="${collection}" as="tasks" />
</data>

<logic>
  columns: ${columnsJson}
  newTask: ""
  newColumn: "${columns[0]}"
  draggedId: null

  async function addTask() {
    if (state.newTask.trim()) {
      await xdb.create("${collection}", {
        title: state.newTask,
        status: state.newColumn,
        order: Date.now()
      })
      state.newTask = ""
    }
  }

  async function moveTask(taskId, newStatus) {
    await xdb.update(taskId, { status: newStatus })
  }

  async function deleteTask(id) {
    await xdb.delete(id)
  }

  function getTasksByStatus(status) {
    return sort(filter(tasks, { status }), 'order')
  }

  function onDragStart(id) {
    state.draggedId = id
  }

  function onDrop(status) {
    if (state.draggedId) {
      moveTask(state.draggedId, status)
      state.draggedId = null
    }
  }
</logic>

<div class="kanban">
  <header class="kanban-header">
    <h1>${name}</h1>
    <form @submit={(e) => { e.preventDefault(); addTask() }} class="add-form">
      <Input placeholder="New task..." :value={newTask} />
      <Select :value={newColumn}>
        #each (col in columns)
          <option value={col}>{col}</option>
        #end
      </Select>
      <Button type="submit">Add</Button>
    </form>
  </header>

  <div class="kanban-board">
    #each (column in columns)
      <div
        class="kanban-column"
        @dragover={(e) => e.preventDefault()}
        @drop={() => onDrop(column)}
      >
        <h3 class="column-title">
          {column}
          <span class="count">({count(getTasksByStatus(column))})</span>
        </h3>
        <div class="column-tasks">
          #each (task in getTasksByStatus(column))
            <div
              class="task-card"
              draggable="true"
              @dragstart={() => onDragStart(task.id)}
            >
              <span class="task-title">{task.data.title}</span>
              <Button
                size="sm"
                variant="ghost"
                @click={() => deleteTask(task.id)}
              >×</Button>
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
