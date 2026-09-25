import { create } from 'zustand';
import type {
  AgentState,
  AIFailure,
  ChatMessage,
  ProviderConfig,
  ModelProfile,
} from '../types/studio';
import { DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_REQUEST_TIMEOUT_MS } from '../lib/aiProvider';

// The request timeout and output cap are the provider adapter's defaults;
// the store re-exports them so the settings panel and tests keep one import.
export { DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_REQUEST_TIMEOUT_MS };
const DEFAULT_MAX_ITERATIONS = 15;
/**
 * The session's token guardrail. An agent run re-sends its conversation on
 * every step, so a run of a few dozen steps counts hundreds of thousands of
 * input tokens; the single-shot default of 50,000 stopped a run after two
 * requests.
 */
export const DEFAULT_TOKEN_BUDGET = 2_000_000;
export const MAX_ITERATIONS_BOUNDS = { min: 1, max: 100 } as const;
export const TOKEN_BUDGET_BOUNDS = { min: 1_000, max: 20_000_000 } as const;

/** How an agent run is bounded and what it may do without asking. */
export interface AgentSettings {
  /** Tool calls per run before it stops and asks to continue. */
  maxSteps: number;
  /** Tokens one run may count before it stops and asks to continue. */
  runTokenBudget: number;
  /** Run check_app automatically after each step that changes files. */
  autoCheck: boolean;
  /** Ask before a run deletes more than a few files. */
  confirmDeletes: boolean;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = { maxSteps: 40, runTokenBudget: 600_000, autoCheck: true, confirmDeletes: true };
export const MAX_STEPS_BOUNDS = { min: 5, max: 200 } as const;
export const RUN_TOKEN_BUDGET_BOUNDS = { min: 10_000, max: 10_000_000 } as const;

/** What a provider and model were found to support for tool calls: `text` once `tools` was refused. */
export type ToolProtocolMemory = Record<string, 'native' | 'text'>;
/**
 * What a provider and model were found to do with a streamed request:
 * `plain` once it refused `stream_options`, `off` once it refused streaming
 * or sent a stream that could not be read. Absent means stream fully.
 */
export type StreamModeMemory = Record<string, 'plain' | 'off'>;
/** The bounds the setters clamp to; the settings panel shows the same numbers. */
export const REQUEST_TIMEOUT_BOUNDS_MS = { min: 5_000, max: 600_000 } as const;
/**
 * The output cap's bounds. The upper bound is the largest max_tokens the
 * providers Studio talks to accept today (Anthropic's current models take
 * up to 128k output tokens; OpenAI-compatible endpoints vary and reject a
 * value they cannot honour with a 4xx the adapter reports). Every request
 * reserves this many tokens from the session budget before it is sent.
 */
export const MAX_OUTPUT_TOKENS_BOUNDS = { min: 256, max: 128_000 } as const;

interface AIState {
  // BYOK config
  providers: ProviderConfig[];
  activeProviderId: string | null;
  modelProfile: ModelProfile;

  // Agent state
  agentState: AgentState;
  currentStep: string;
  iterationsUsed: number;
  maxIterations: number;
  tokensUsed: number;
  /**
   * The session's token budget. It is a local guardrail — Studio counts
   * what providers report and refuses a request the remainder cannot cover
   * — not a billing cap: the provider bills what it bills, and a reply
   * whose usage arrives malformed is counted as zero here.
   */
  tokenBudget: number;
  filesChanged: number;
  /** Per-request timeout, in milliseconds. */
  requestTimeoutMs: number;
  /** Output allowance per request; the provider's max_tokens and the budget reservation. */
  maxOutputTokens: number;
  /** Why the last turn did not finish, until the next one starts. */
  lastFailure: AIFailure | null;
  agentSettings: AgentSettings;
  /** Per `providerId:model`, whether native tool calls work; learned, and kept with the settings. */
  toolProtocols: ToolProtocolMemory;
  /** Per `providerId:model`, how far streaming works; learned, and kept with the settings. */
  streamModes: StreamModeMemory;

  // Chat
  messages: ChatMessage[];
  /** Unsaved composition survives switching panels, but belongs to this project only. */
  draftMessage: string;

  /**
   * The person chose to look around without connecting a provider. Until
   * then, with no provider, the dashboard asks for one before anything else.
   */
  setupSkipped: boolean;
  /**
   * The AI setup dialog, when it is open: `providerId` is the provider being
   * edited (to choose its model, say), or null to add one.
   */
  setupDialog: { providerId: string | null } | null;

  // Actions
  addProvider(provider: ProviderConfig): void;
  /** Add a provider, or replace the one with the same id. */
  saveProvider(provider: ProviderConfig): void;
  updateProvider(id: string, patch: Partial<Omit<ProviderConfig, 'id'>>): void;
  setSetupSkipped(skipped: boolean): void;
  openProviderSetup(providerId?: string | null): void;
  closeProviderSetup(): void;
  removeProvider(id: string): void;
  setActiveProvider(id: string | null): void;
  updateModelProfile(profile: Partial<ModelProfile>): void;
  setAgentState(state: AgentState): void;
  setCurrentStep(step: string): void;
  incrementIteration(): void;
  addTokens(count: number): void;
  incrementFilesChanged(): void;
  setMaxIterations(max: number): void;
  setTokenBudget(budget: number): void;
  setRequestTimeoutMs(ms: number): void;
  setMaxOutputTokens(tokens: number): void;
  setLastFailure(failure: AIFailure | null): void;
  updateAgentSettings(patch: Partial<AgentSettings>): void;
  rememberToolProtocol(key: string, protocol: 'native' | 'text'): void;
  rememberStreamMode(key: string, mode: 'plain' | 'off'): void;
  addMessage(message: ChatMessage): void;
  /** Replace one message by id, if it is still there. */
  replaceMessage(id: string, update: (message: ChatMessage) => ChatMessage): void;
  setDraftMessage(message: string): void;
  updateLastMessage(content: string): void;
  clearMessages(): void;
  resetBudget(): void;
  resetSession(): void;
}

export const useAIStore = create<AIState>((set) => ({
  providers: [],
  activeProviderId: null,
  modelProfile: {
    architect: '',
    builder: '',
    repair: '',
    vision: '',
  },

  agentState: 'idle',
  currentStep: '',
  iterationsUsed: 0,
  maxIterations: DEFAULT_MAX_ITERATIONS,
  tokensUsed: 0,
  tokenBudget: DEFAULT_TOKEN_BUDGET,
  filesChanged: 0,
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  lastFailure: null,
  agentSettings: DEFAULT_AGENT_SETTINGS,
  toolProtocols: {},
  streamModes: {},

  messages: [],
  draftMessage: '',

  setupSkipped: false,
  setupDialog: null,

  addProvider: (provider) =>
    set((s) => ({ providers: [...s.providers, provider] })),
  saveProvider: (provider) =>
    set((s) => ({
      providers: s.providers.some((p) => p.id === provider.id)
        ? s.providers.map((p) => (p.id === provider.id ? provider : p))
        : [...s.providers, provider],
    })),
  updateProvider: (id, patch) =>
    set((s) => ({ providers: s.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),
  setSetupSkipped: (setupSkipped) => set({ setupSkipped }),
  openProviderSetup: (providerId = null) => set({ setupDialog: { providerId } }),
  closeProviderSetup: () => set({ setupDialog: null }),
  // The generation model is one of the active provider's own models, so it
  // is cleared when the active provider changes or goes: carried over, it
  // would send one provider's model name to another.
  removeProvider: (id) =>
    set((s) => ({
      providers: s.providers.filter((p) => p.id !== id),
      activeProviderId: s.activeProviderId === id ? null : s.activeProviderId,
      modelProfile: s.activeProviderId === id ? { ...s.modelProfile, builder: '' } : s.modelProfile,
    })),
  setActiveProvider: (id) =>
    set((s) => (s.activeProviderId === id
      ? { activeProviderId: id }
      : { activeProviderId: id, modelProfile: { ...s.modelProfile, builder: '' } })),
  updateModelProfile: (profile) =>
    set((s) => ({ modelProfile: { ...s.modelProfile, ...profile } })),
  setAgentState: (state) => set({ agentState: state }),
  setCurrentStep: (step) => set({ currentStep: step }),
  incrementIteration: () => set((s) => ({ iterationsUsed: s.iterationsUsed + 1 })),
  // A count that is not a finite non-negative number is not counted: the
  // accounting must never go NaN because a provider sent a malformed field.
  addTokens: (count) =>
    set((s) => ({ tokensUsed: s.tokensUsed + (Number.isFinite(count) && count > 0 ? Math.floor(count) : 0) })),
  incrementFilesChanged: () => set((s) => ({ filesChanged: s.filesChanged + 1 })),
  setMaxIterations: (max) => set({ maxIterations: Number.isFinite(max) ? Math.max(MAX_ITERATIONS_BOUNDS.min, Math.min(MAX_ITERATIONS_BOUNDS.max, Math.floor(max))) : DEFAULT_MAX_ITERATIONS }),
  setTokenBudget: (budget) => set({ tokenBudget: Number.isFinite(budget) ? Math.max(TOKEN_BUDGET_BOUNDS.min, Math.min(TOKEN_BUDGET_BOUNDS.max, Math.floor(budget))) : DEFAULT_TOKEN_BUDGET }),
  setRequestTimeoutMs: (ms) =>
    set({ requestTimeoutMs: Number.isFinite(ms) ? Math.max(REQUEST_TIMEOUT_BOUNDS_MS.min, Math.min(REQUEST_TIMEOUT_BOUNDS_MS.max, Math.floor(ms))) : DEFAULT_REQUEST_TIMEOUT_MS }),
  setMaxOutputTokens: (tokens) =>
    set({ maxOutputTokens: Number.isFinite(tokens) ? Math.max(MAX_OUTPUT_TOKENS_BOUNDS.min, Math.min(MAX_OUTPUT_TOKENS_BOUNDS.max, Math.floor(tokens))) : DEFAULT_MAX_OUTPUT_TOKENS }),
  setLastFailure: (failure) => set({ lastFailure: failure }),
  updateAgentSettings: (patch) =>
    set((s) => {
      const next = { ...s.agentSettings, ...patch };
      const clamp = (value: number, bounds: { min: number; max: number }, fallback: number) =>
        Number.isFinite(value) ? Math.max(bounds.min, Math.min(bounds.max, Math.floor(value))) : fallback;
      return {
        agentSettings: {
          maxSteps: clamp(next.maxSteps, MAX_STEPS_BOUNDS, DEFAULT_AGENT_SETTINGS.maxSteps),
          runTokenBudget: clamp(next.runTokenBudget, RUN_TOKEN_BUDGET_BOUNDS, DEFAULT_AGENT_SETTINGS.runTokenBudget),
          autoCheck: next.autoCheck !== false,
          confirmDeletes: next.confirmDeletes !== false,
        },
      };
    }),
  rememberToolProtocol: (key, protocol) =>
    set((s) => (s.toolProtocols[key] === protocol ? s : { toolProtocols: { ...s.toolProtocols, [key]: protocol } })),
  rememberStreamMode: (key, mode) =>
    set((s) => (s.streamModes[key] === mode ? s : { streamModes: { ...s.streamModes, [key]: mode } })),
  addMessage: (message) =>
    set((s) => {
      const next = [...s.messages, message];
      return { messages: next.length > 200 ? next.slice(-200) : next };
    }),
  setDraftMessage: (draftMessage) => set({ draftMessage }),
  replaceMessage: (id, update) =>
    set((s) => {
      const index = s.messages.findIndex((m) => m.id === id);
      if (index < 0) return s;
      const messages = [...s.messages];
      messages[index] = update(messages[index]);
      return { messages };
    }),
  updateLastMessage: (content) =>
    set((s) => {
      if (s.messages.length === 0) return s;
      const msgs = [...s.messages];
      msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content };
      return { messages: msgs };
    }),
  clearMessages: () => set({ messages: [] }),
  resetBudget: () =>
    set({ iterationsUsed: 0, tokensUsed: 0, filesChanged: 0 }),
  resetSession: () =>
    set({ messages: [], draftMessage: '', agentState: 'idle', currentStep: '', iterationsUsed: 0, tokensUsed: 0, filesChanged: 0, lastFailure: null }),
}));
