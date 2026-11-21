/**
 * The tools the agent builds an app with: one list, from which the
 * Anthropic `tools`, the OpenAI-compatible `functions` and the text
 * protocol's documentation are all made, so the three cannot disagree.
 *
 * Descriptions are written for the model: what the tool does, when to use
 * it, and what its result looks like. Results are compact text.
 */

export interface ToolSpec {
  name: string;
  description: string;
  /** A JSON schema object. */
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; items?: unknown; enum?: string[] }>;
    required: string[];
  };
}

const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'integer', description });
const bool = (description: string) => ({ type: 'boolean', description });

export const AGENT_TOOLS: ToolSpec[] = [
  {
    name: 'design_database',
    description: 'Create a local XDB collection or a FormLogic private SQLite table with typed fields. Read manifest.json first. Creates editable source and updates the manifest together. FormLogic tables get an integer primary key called id automatically and a new migration. Edit handlers separately to expose rows to an authorized caller.',
    inputSchema: { type: 'object', properties: {
      target: { type: 'string', description: 'Where records are stored.', enum: ['local', 'formlogic'] },
      name: str('Collection or table name. Start with a letter.'),
      fields: { type: 'array', description: 'Fields in display order.', items: { type: 'object', properties: {
        name: str('Field name'), type: { type: 'string', enum: ['string', 'number', 'integer', 'boolean', 'date', 'email', 'url'] },
        required: bool('Whether the field is required.'),
      }, required: ['name', 'type'] } },
    }, required: ['target', 'name', 'fields'] },
  },
  {
    name: 'list_files',
    description: 'List the project\'s files as a tree, each with its size and kind (page, logic, data, config, asset). Private editor state is not listed.',
    inputSchema: { type: 'object', properties: { prefix: str('Only list files under this folder, e.g. "pages/". Optional.') }, required: [] },
  },
  {
    name: 'read_file',
    description:
      'Read the exact source text beneath a header naming the file and line range. Give start_line/end_line (1-based, inclusive) to read part of a long file. A binary file answers with its type and size. Read a file before you edit it: edit_file needs it read in this run, write_file on an existing file needs it read whole.',
    inputSchema: {
      type: 'object',
      properties: { path: str('Project path, e.g. "index.html".'), start_line: int('First line to read. Optional.'), end_line: int('Last line to read. Optional.') },
      required: ['path'],
    },
  },
  {
    name: 'search_files',
    description: 'Search the project\'s text files for a regular expression (or plain text), answering path:line: text for each match, at most 50.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: str('A JavaScript regular expression, or plain text when regex is false.'),
        regex: bool('Whether pattern is a regular expression. Default true.'),
        path_prefix: str('Only search under this folder. Optional.'),
      },
      required: ['pattern'],
    },
  },
  {
    name: 'write_file',
    description:
      'Create a file, or replace an existing one whole. Use it for new files; for a change to an existing file prefer edit_file. Replacing an existing file requires that you read it whole in this run.',
    inputSchema: { type: 'object', properties: { path: str('Project path.'), content: str('The complete file content.') }, required: ['path', 'content'] },
  },
  {
    name: 'edit_file',
    description:
      'The main editing tool. Replace old_string with new_string in a file you have read in this run. old_string must match the file exactly — whitespace and indentation included — and exactly once, unless replace_all is true. Include enough surrounding lines to make it unique. On a mismatch the error shows the closest lines.',
    inputSchema: {
      type: 'object',
      properties: {
        path: str('Project path.'),
        old_string: str('The exact text to replace.'),
        new_string: str('The text to put in its place.'),
        replace_all: bool('Replace every occurrence. Default false.'),
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file. Deleting more than a few files in one run asks the person first.',
    inputSchema: { type: 'object', properties: { path: str('Project path.') }, required: ['path'] },
  },
  {
    name: 'rename_file',
    description: 'Move or rename a file, keeping its content. Update any references to it (imports, <logic src>, manifest.json) with edit_file.',
    inputSchema: { type: 'object', properties: { from: str('Current path.'), to: str('New path.') }, required: ['from', 'to'] },
  },
  {
    name: 'check_app',
    description:
      'Check the app the way the runtime will run it: the bundle inspector and composer, then a real render of the main page (or the page given). Reports parse errors, composer refusals, script and Python load errors, runtime exceptions and console errors, and every name the markup uses that nothing defines — a handler calling a function the logic lacks, :bind to a name that is not state, a read of a name that is not state, a function, a computed value, a <data> alias or a loop variable — each with its file and line. Studio also runs it automatically after each step that changes files.',
    inputSchema: { type: 'object', properties: { page: str('A page (e.g. "pages/home.html") to render instead of the manifest\'s main; a page the app imports is rendered with the app\'s logic and <data> around it, as it runs. Optional.') }, required: [] },
  },
  {
    name: 'inspect_preview',
    description:
      'Render a page and describe what it shows as text: headings, visible text, and interactive elements (buttons, inputs, checkboxes, links) with their labels and state — like an accessibility tree. Use it to confirm the page looks as intended.',
    inputSchema: { type: 'object', properties: { page: str('A page (e.g. "pages/home.html"); default the manifest\'s main.') }, required: [] },
  },
  {
    name: 'run_app_function',
    description:
      'Call one of the app\'s logic functions in a fresh, isolated runtime (the same engine as the preview), after its top level and _init() have run. Reports the return value, the state before and after (as a diff) and any error; a timer the call sets is not waited for. Pass setup_calls to call other functions first — e.g. set new_task then call add_task, then read the state.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('The function to call.'),
        args: { type: 'array', description: 'Arguments, as JSON values. Optional.', items: {} },
        setup_calls: {
          type: 'array',
          description: 'Calls to make first, each { "name": "...", "args": [...] } or { "set": "stateName", "value": ... }. Optional.',
          items: { type: 'object' },
        },
        page: str('The page whose logic to load; default the manifest\'s main.'),
      },
      required: ['name'],
    },
  },
  {
    name: 'lookup_components',
    description:
      'The full reference for components you are about to use: every prop with its type and allowed values, which are optional, its events (@name), whether it takes children, and a usage example. Generated from the component sources, so it is authoritative — check a component here before relying on a prop you are unsure of.',
    inputSchema: {
      type: 'object',
      properties: { names: { type: 'array', description: 'Component names, e.g. ["Table", "Tabs"]. Up to 12.', items: { type: 'string' } } },
      required: ['names'],
    },
  },
  {
    name: 'read_docs',
    description:
      // The examples are a guide and a section that exist, in every project's index: a model
      // copies what it is shown, and this once showed a section its guide does not have.
      'Read one of SoftN\'s published guides as text, by its slug from the guide index in your instructions, optionally narrowed to one section by adding # and the section\'s name (e.g. "xdb-data" or "ui-language#bindings").',
    inputSchema: { type: 'object', properties: { topic: str('A guide slug, optionally with #section.') }, required: ['topic'] },
  },
  {
    name: 'update_plan',
    description:
      'Set the short checklist the person sees for this run. Send the whole list each time, marking each item pending, active or done. Keep it to 3–8 items. Use it at the start and as you complete items.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'The checklist: [{ "text": "Write the task list page", "status": "active" }, …]',
          items: { type: 'object', properties: { text: { type: 'string' }, status: { type: 'string', enum: ['pending', 'active', 'done'] } }, required: ['text', 'status'] },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'ask_user',
    description:
      'Pause and ask the person one short question when you cannot proceed without their decision. The run waits; their answer comes back as this tool\'s result. Do not ask about things you can decide sensibly yourself.',
    inputSchema: { type: 'object', properties: { question: str('The question, in one or two sentences.') }, required: ['question'] },
  },
  {
    name: 'finish',
    description:
      'End the run and show the person your answer. For a question, put the direct answer in the summary. For an edit, report the actual changes once check_app is clean or you have explained what remains.',
    inputSchema: { type: 'object', properties: { summary: str('The answer to the question or a short account of the changes made in this run.') }, required: ['summary'] },
  },
];

export type AgentAppMode = 'web' | 'legacy-ui';

export const TOOL_NAMES = new Set(AGENT_TOOLS.map((t) => t.name));

/** The tools that change files. */
export const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'rename_file', 'design_database']);

const LEGACY_UI_ONLY_TOOLS = new Set(['lookup_components', 'run_app_function']);

export function agentToolsForMode(mode: AgentAppMode = 'legacy-ui'): ToolSpec[] {
  if (mode !== 'web') return AGENT_TOOLS;
  return AGENT_TOOLS.filter((t) => !LEGACY_UI_ONLY_TOOLS.has(t.name)).map((t) => {
    if (t.name === 'rename_file') {
      return {
        ...t,
        description: 'Move or rename a file, keeping its content. Update any references to it (ES module imports, <script src>, <link href>, manifest.json) with edit_file.',
      };
    }
    if (t.name === 'check_app') {
      return {
        ...t,
        description:
          'Validate manifest.json, permission.json, HTML/CSS/module references, and boot the Web App Container headlessly inside the ZIPP WASM sandbox. Reports syntax/module errors, missing files, runtime exceptions, console errors, and visible rendered text. Studio also runs it automatically after each step that changes files.',
        inputSchema: {
          type: 'object',
          properties: { page: str('An HTML page (e.g. "index.html") to render instead of the manifest\'s main. Optional.') },
          required: [],
        },
      };
    }
    if (t.name === 'inspect_preview') {
      return {
        ...t,
        inputSchema: {
          type: 'object',
          properties: { page: str('An HTML page (e.g. "index.html"); default the manifest\'s main.') },
          required: [],
        },
      };
    }
    if (t.name === 'read_docs') {
      return {
        ...t,
        description:
          'Read one of SoftN\'s published guides as text, by its slug from the guide index in your instructions, optionally narrowed to one section by adding # and the section\'s name (e.g. "xdb-data" or "permissions#declaration").',
      };
    }
    return t;
  });
}

/** Anthropic Messages API `tools`. */
export function anthropicTools(mode: AgentAppMode = 'legacy-ui'): Array<{ name: string; description: string; input_schema: ToolSpec['inputSchema'] }> {
  return agentToolsForMode(mode).map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
}

/** OpenAI-compatible Chat Completions `tools`. */
export function openAITools(mode: AgentAppMode = 'legacy-ui'): Array<{ type: 'function'; function: { name: string; description: string; parameters: ToolSpec['inputSchema'] } }> {
  return agentToolsForMode(mode).map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
}

/**
 * The text protocol, for a provider that cannot carry tool calls natively.
 * The `<arg>` form carries file content raw — no JSON escaping for the model
 * to get wrong — and is what the prompt teaches; a JSON object body is also
 * accepted.
 */
export function textProtocolGuide(mode: AgentAppMode = 'legacy-ui'): string {
  const tools = agentToolsForMode(mode);
  const lines = tools.map((t) => {
    const params = Object.entries(t.inputSchema.properties)
      .map(([name, p]) => `${name}${t.inputSchema.required.includes(name) ? '' : '?'} (${p.type}): ${p.description}`)
      .join('; ');
    return `- **${t.name}** — ${t.description}${params ? `\n  Arguments: ${params}` : ''}`;
  });
  const sampleOld = mode === 'web' ? '<h1>Hello</h1>' : '<Text>Hello</Text>';
  const sampleNew = mode === 'web' ? '<h1>Hello, world</h1>' : '<Text>Hello, world</Text>';
  return `## Calling tools (text protocol)

This provider does not carry tool calls natively, so you call tools by writing blocks in your reply. Each block is one call:

<tool_call name="edit_file">
<arg name="path">index.html</arg>
<arg name="old_string">${sampleOld}</arg>
<arg name="new_string">${sampleNew}</arg>
</tool_call>

An argument's value is written raw between <arg> and </arg> — file content exactly as it should be, no escaping. Arrays, objects, numbers and booleans are written as JSON (\`<arg name="replace_all">true</arg>\`). You may instead write a JSON object as the block's body: \`<tool_call name="read_file">{"path": "index.html"}</tool_call>\`.

You may make several calls in one reply; they run in order. Then stop and wait: the results come back in the next message as <tool_result> blocks. Never write a <tool_result> yourself. A reply with no <tool_call> block ends the run, so when you are done call finish.

### Tools
${lines.join('\n')}`;
}
