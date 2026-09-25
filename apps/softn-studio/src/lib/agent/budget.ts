/**
 * How a run's tokens are counted against its budget and the session's.
 *
 * A prompt read from the provider's cache costs a fraction of one read
 * afresh, and an agent run re-sends its whole conversation every step, so
 * counting cached tokens at face value would make a run with a warm cache
 * look ten times dearer than it is — and stop it at a budget it has not
 * spent. The budgets count "effective" tokens instead: output and uncached
 * input at face value, cache reads and writes weighted by their price next to
 * ordinary input. The weights are the providers' published ratios, by kind of
 * provider rather than by model: Anthropic reads its cache at a tenth of the
 * input price and writes it at 1.25×; OpenAI-compatible providers discount
 * cached input by between half and nine tenths depending on the model, and
 * the budget takes the smaller discount so it never under-counts.
 */

import type { ProviderConfig } from '../../types/studio';
import type { AgentUsage } from './protocol';
import type { RunTokens } from './types';

export interface CacheWeights {
  /** What a token read from the cache counts as. */
  read: number;
  /** What a token written to the cache counts as. */
  write: number;
}

export const ANTHROPIC_CACHE_WEIGHTS: CacheWeights = { read: 0.1, write: 1.25 };
export const OPENAI_CACHE_WEIGHTS: CacheWeights = { read: 0.5, write: 1 };

export function cacheWeights(provider: Pick<ProviderConfig, 'type'>): CacheWeights {
  return provider.type === 'anthropic' ? ANTHROPIC_CACHE_WEIGHTS : OPENAI_CACHE_WEIGHTS;
}

/** One request's usage in effective tokens. */
export function effectiveTokens(usage: AgentUsage, weights: CacheWeights): number {
  const read = Math.min(usage.cacheReadTokens ?? 0, usage.inputTokens);
  const write = Math.min(usage.cacheWriteTokens ?? 0, usage.inputTokens - read);
  const fresh = usage.inputTokens - read - write;
  return Math.ceil(fresh + read * weights.read + write * weights.write + usage.outputTokens);
}

/** A run's total so far in effective tokens; a record from before caching was counted is face value. */
export function runEffective(tokens: RunTokens): number {
  return tokens.effective ?? tokens.input + tokens.output;
}

/** A run's totals with one more request added. */
export function addUsage(tokens: RunTokens, usage: AgentUsage, weights: CacheWeights): RunTokens {
  const cached = (tokens.cached ?? 0) + (usage.cacheReadTokens ?? 0);
  const cacheWrite = (tokens.cacheWrite ?? 0) + (usage.cacheWriteTokens ?? 0);
  return {
    input: tokens.input + usage.inputTokens,
    output: tokens.output + usage.outputTokens,
    ...(cached > 0 ? { cached } : {}),
    ...(cacheWrite > 0 ? { cacheWrite } : {}),
    effective: runEffective(tokens) + effectiveTokens(usage, weights),
  };
}
