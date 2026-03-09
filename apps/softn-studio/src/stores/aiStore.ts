import { create } from 'zustand';
import type {
  AgentState,
  ChatMessage,
  ProviderConfig,
  ModelProfile,
} from '../types/studio';

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
  tokenBudget: number;
  filesChanged: number;

  // Chat
  messages: ChatMessage[];

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
  addMessage(message: ChatMessage): void;
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

  messages: [],

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
  addTokens: (count) => set((s) => ({ tokensUsed: s.tokensUsed + count })),
  incrementFilesChanged: () => set((s) => ({ filesChanged: s.filesChanged + 1 })),
  setMaxIterations: (max) => set({ maxIterations: Math.max(1, Math.min(100, max)) }),
  setTokenBudget: (budget) => set({ tokenBudget: Math.max(1000, Math.min(1000000, budget)) }),
  addMessage: (message) =>
    set((s) => {
      const next = [...s.messages, message];
      return { messages: next.length > 200 ? next.slice(-200) : next };
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
    set({ messages: [], agentState: 'idle', currentStep: '', iterationsUsed: 0, tokensUsed: 0, filesChanged: 0 }),
}));
