/** Runtime target for generated apps */
export type RuntimeTarget = 'web' | 'desktop' | 'dual';

/** Visual style presets */
export type VisualStyle = 'clean' | 'bold' | 'minimal' | 'playful' | 'dark';

/**
 * Where a provider's replies come from. `local` is a server on this
 * computer (Ollama, LM Studio, another OpenAI-compatible one); `custom` is
 * any other OpenAI-compatible endpoint, and what local servers were saved
 * as before `local` existed.
 */
export type ProviderType = 'anthropic' | 'openai' | 'local' | 'custom';

/** Which local server a `local` provider is, for its default address and its advice. */
export type LocalServerKind = 'ollama' | 'lmstudio' | 'other';


/** Agent loop states */
export type AgentState =
  | 'idle'
  | 'building'
  | 'complete'
  | 'error';

/**
 * The language an app's logic is written in. The runtime decides it from the
 * logic files' names — `.logic` is JavaScript, `.py` is Python — and an app
 * uses one of them for all of its logic.
 */
export type LogicLanguage = 'javascript' | 'python';

/** Brief wizard data */
export interface ProjectBrief {
  appName: string;
  description: string;
  target: RuntimeTarget;
  pages: string[];
  collections: string[];
  authNeeded: boolean;
  style: VisualStyle;
  /**
   * What the scaffold and the model write the logic in. Absent in projects
   * saved before the choice existed, and absent means JavaScript, which is
   * all Studio wrote then.
   */
  logicLanguage?: LogicLanguage;
  /**
   * Python packages the app asks the runtime for — today only `torch` — which
   * the scaffold writes into manifest.json's `config.python.packages`. Only
   * read for a Python project; absent in briefs saved before it existed.
   */
  pythonPackages?: string[];
  referenceImages: File[];
}

/** BYOK provider config */
export interface ProviderConfig {
  id: string;
  type: ProviderType;
  name: string;
  apiKey: string;
  /**
   * The server's address or API base (`http://localhost:11434`,
   * `https://example.com/v1`); older providers stored the full completion
   * URL, which still works. Absent means the type's usual address.
   */
  baseUrl?: string;
  /**
   * The model every request uses. There is no default: a provider without
   * one is refused with a prompt to choose, never sent a guessed name.
   */
  modelId?: string;
  orgId?: string;
  /** For a `local` provider: which server, for its address and its advice. */
  serverKind?: LocalServerKind;
}

/** Per-role model assignment */
export interface ModelProfile {
  architect: string;
  builder: string;
  repair: string;
  vision: string;
}

/** Chat message */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  toolCalls?: ToolCallCard[];
  tokens?: { input: number; output: number };
  /** The VFS transaction this turn committed, when it committed one; what "Revert this turn" reverts. */
  transactionId?: string;
  /** An agent run's timeline, when this message is one. Plain data; see lib/agent/types.ts. */
  run?: import('../lib/agent/types').AgentRunRecord;
}

/** Why the last agent turn did not finish, in a form the UI can act on. */
export type AIFailureKind =
  | 'timeout'
  | 'cancelled'
  | 'rate-limited'
  | 'provider'
  | 'network'
  | 'invalid-response'
  | 'budget'
  | 'truncated'
  | 'refused'
  | 'empty'
  /** The provider needs setting up first — typically a model to be chosen. */
  | 'setup';

export interface AIFailure {
  kind: AIFailureKind;
  message: string;
  /** For a rate limit: how long the provider asked us to wait. */
  retryAfterMs?: number;
  at: number;
}

/** Tool call displayed as card */
export interface ToolCallCard {
  tool: string;
  args: Record<string, unknown>;
  result?: string;
  status: 'pending' | 'success' | 'error';
}

/** VFS file */
export interface VFSFile {
  path: string;
  content: string | Uint8Array;
  mimeType: string;
  lastModified: number;
  lastModifiedBy: 'user' | 'ai';
  version: number;
}

/** VFS change event */
export interface VFSEvent {
  type: 'create' | 'update' | 'patch' | 'delete';
  path: string;
  timestamp: number;
  source: 'user' | 'ai';
  previousContent?: string | Uint8Array;
  /**
   * The undo unit this event belongs to. Every event has one; a single
   * edit is a unit of one, an import or an AI turn is a unit of many.
   * Undo, redo, revert and pruning act on whole units.
   */
  transactionId?: string;
  /** The file as it was before this event — bytes and metadata — for an exact restore. Absent for a create. */
  previous?: VFSFile;
  /** On the redo stack only: the file as it was after this event, for an exact redo. Absent for a delete. */
  after?: VFSFile;
}

/** Blueprint page */
export interface BlueprintPage {
  id: string;
  name: string;
  route?: string;
  layout: string;
  components: string[];
}

/** Blueprint collection */
export interface BlueprintCollection {
  id: string;
  name: string;
  fields: BlueprintField[];
  relationships: BlueprintRelationship[];
}

export interface BlueprintField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object';
  required: boolean;
  defaultValue?: string;
}

export interface BlueprintRelationship {
  target: string;
  type: 'one-to-one' | 'one-to-many' | 'many-to-many';
}

/** Blueprint data */
export interface Blueprint {
  appName: string;
  target: RuntimeTarget;
  style: VisualStyle;
  pages: BlueprintPage[];
  collections: BlueprintCollection[];
  navigation: { type: 'tabs' | 'sidebar' | 'stack'; items: string[] };
  risks: string[];
  assumptions: string[];
}

/** Task in the execution graph */
export interface AgentTask {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'complete' | 'failed' | 'skipped';
  dependencies: string[];
  retries: number;
  files: string[];
}

/** Validation error */
export interface ValidationError {
  file: string;
  line?: number;
  level: 'error' | 'warning' | 'info';
  type: string;
  message: string;
  suggestion?: string;
}

/** Preview device preset */
export type DevicePreset = 'desktop' | 'tablet' | 'mobile';

/** Left rail panel */
export type LeftPanel = 'pages' | 'history' | 'ai' | 'settings' | 'files';

/**
 * Where the project is: being described (no brief yet), its structure laid
 * out (a blueprint waiting for approval), or being designed and built.
 * Projects saved by older Studios may say `data`, `logic` or `test`, modes
 * that were never reachable; they load as `design` (see `normalizeMode`).
 */
export type BuilderMode = 'describe' | 'structure' | 'design';

/** Bottom drawer tab */
export type BottomTab = 'log';

/** Recent locally persisted project */
export interface RecentProjectRecord {
  id: string;
  name: string;
  target: RuntimeTarget;
  lastModified: string;
}

