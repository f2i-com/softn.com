import React from 'react';
import { useAIStore } from '../../stores';
import { Icon } from '../common/Icon';
import { resolveModel } from '../../lib/aiProvider';

/** What the AI can do right now, as the pill and the prompts read it. */
export type AIReadiness =
  | { state: 'none' }
  | { state: 'unselected' }
  | { state: 'no-model'; providerId: string; name: string }
  | { state: 'ready'; providerId: string; name: string; model: string };

export function useAIReadiness(): AIReadiness {
  const providers = useAIStore((s) => s.providers);
  const activeId = useAIStore((s) => s.activeProviderId);
  const builder = useAIStore((s) => s.modelProfile.builder);
  const provider = providers.find((p) => p.id === activeId);
  if (!provider) return providers.length > 0 ? { state: 'unselected' } : { state: 'none' };
  const model = resolveModel(provider, builder);
  if (!model) return { state: 'no-model', providerId: provider.id, name: provider.name };
  return { state: 'ready', providerId: provider.id, name: provider.name, model };
}

/**
 * Whether the dashboard asks for a provider before anything else: no
 * provider yet, the person has not chosen to go without, and this is not a
 * hosted editor (whose AI is its host's).
 */
export function needsProviderSetup(options: { hosted: boolean; providerCount: number; setupSkipped: boolean }): boolean {
  return !options.hosted && options.providerCount === 0 && !options.setupSkipped;
}

/** Open the setup for whatever the AI is missing. */
export function openSetupFor(readiness: AIReadiness): void {
  const ai = useAIStore.getState();
  if (readiness.state === 'no-model' || readiness.state === 'ready') ai.openProviderSetup(readiness.providerId);
  else if (readiness.state === 'unselected') ai.openProviderSetup(ai.providers[0]?.id ?? null);
  else ai.openProviderSetup(null);
}

/**
 * The AI's state as one control: which provider and model, or what is
 * missing. It is always a button, and it always opens the setup for the
 * thing it names — there is no "No provider" label that does nothing.
 */
export const AIStatusPill: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const readiness = useAIReadiness();
  const label = readiness.state === 'none'
    ? 'Connect AI'
    : readiness.state === 'unselected'
      ? 'Choose a provider'
      : readiness.state === 'no-model'
        ? 'Choose a model'
        : readiness.name;
  const title = readiness.state === 'ready'
    ? `AI: ${readiness.name}, model ${readiness.model}. Change the provider or model.`
    : readiness.state === 'no-model'
      ? `${readiness.name} has no model chosen. Choose one.`
      : 'Connect an AI provider: a local model, an OpenAI key or an Anthropic key.';
  return (
    <button
      type="button"
      className="st-ai-pill"
      data-state={readiness.state}
      onClick={() => openSetupFor(readiness)}
      title={title}
      aria-label={title}
    >
      <Icon name={readiness.state === 'ready' ? 'ai' : 'key'} size={14} />
      <span className="st-ai-pill-name">{label}</span>
      {readiness.state === 'ready' && !compact && <span className="st-ai-pill-model">{readiness.model}</span>}
    </button>
  );
};
