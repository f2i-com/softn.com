import { create } from 'zustand';
import type {
  AgentState,
  AIFailure,
  ChatMessage,
  ProviderConfig,
  ModelProfile,
} from '../types/studio';

/** How long one provider request may take before Studio gives up on it. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
/**
 * The output allowance reserved for each request, sent as the provider's
 * max_tokens. It is also what the budget check reserves before sending: a
 * reply cannot be longer than this, so a request the remaining budget
 * cannot cover at this size is refused before it costs anything.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
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

  // Chat
  messages: ChatMessage[];
  /** Unsaved composition survives switching panels, but belongs to this project only. */
  draftMessage: string;

  // Actions
  addProvider(provider: ProviderConfig): void;
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
  addMessage(message: ChatMessage): void;
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
  maxIterations: 15,
  tokensUsed: 0,
  tokenBudget: 50000,
  filesChanged: 0,
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  lastFailure: null,

  messages: [],
  draftMessage: '',

  addProvider: (provider) =>
    set((s) => ({ providers: [...s.providers, provider] })),
  removeProvider: (id) =>
    set((s) => ({
      providers: s.providers.filter((p) => p.id !== id),
      activeProviderId: s.activeProviderId === id ? null : s.activeProviderId,
    })),
  setActiveProvider: (id) => set({ activeProviderId: id }),
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
  setMaxIterations: (max) => set({ maxIterations: Math.max(1, Math.min(100, max)) }),
  setTokenBudget: (budget) => set({ tokenBudget: Math.max(1000, Math.min(1000000, budget)) }),
  setRequestTimeoutMs: (ms) =>
    set({ requestTimeoutMs: Number.isFinite(ms) ? Math.max(REQUEST_TIMEOUT_BOUNDS_MS.min, Math.min(REQUEST_TIMEOUT_BOUNDS_MS.max, Math.floor(ms))) : DEFAULT_REQUEST_TIMEOUT_MS }),
  setMaxOutputTokens: (tokens) =>
    set({ maxOutputTokens: Number.isFinite(tokens) ? Math.max(MAX_OUTPUT_TOKENS_BOUNDS.min, Math.min(MAX_OUTPUT_TOKENS_BOUNDS.max, Math.floor(tokens))) : DEFAULT_MAX_OUTPUT_TOKENS }),
  setLastFailure: (failure) => set({ lastFailure: failure }),
  addMessage: (message) =>
    set((s) => {
      const next = [...s.messages, message];
      return { messages: next.length > 200 ? next.slice(-200) : next };
    }),
  setDraftMessage: (draftMessage) => set({ draftMessage }),
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
