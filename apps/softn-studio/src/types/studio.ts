/** Runtime target for generated apps */
export type RuntimeTarget = 'web' | 'desktop' | 'dual';

/** Visual style presets */
export type VisualStyle = 'clean' | 'bold' | 'minimal' | 'playful' | 'dark';

/** BYOK provider IDs */
export type ProviderType = 'anthropic' | 'openai' | 'custom';

/** Agent roles */
export type AgentRole = 'architect' | 'builder' | 'repair' | 'vision';

/** Agent loop states */
export type AgentState =
  | 'idle'
  | 'building'
  | 'complete'
  | 'error';

/** Brief wizard data */
export interface ProjectBrief {
  appName: string;
  description: string;
  target: RuntimeTarget;
  pages: string[];
  collections: string[];
  authNeeded: boolean;
  style: VisualStyle;
  referenceImages: File[];
}

/** BYOK provider config */
export interface ProviderConfig {
  id: string;
  type: ProviderType;
  name: string;
  apiKey: string;
  baseUrl?: string;
  modelId?: string;
  orgId?: string;
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

/** Builder mode */
export type BuilderMode = 'describe' | 'structure' | 'design' | 'data' | 'logic' | 'test';

/** Bottom drawer tab */
export type BottomTab = 'log';

/** Recent locally persisted project */
export interface RecentProjectRecord {
  id: string;
  name: string;
  target: RuntimeTarget;
  lastModified: string;
}

