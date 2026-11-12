/**
 * The mark every loaded script is given: how its variables stood when its
 * logic had just started, so that it can be told later which of them moved
 * (state-carry.ts). On its own, because it is made at every load, while the
 * carrying it serves is fetched only when an open app's logic is replaced.
 */

import type { CarryEngine, StartMark, StateSlots } from './state-carry';

function plainCopy(value: unknown): unknown {
  try {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

/** Mark how the variables stand now: digests where the engine gives them (nothing is copied), else copies of the values. */
export function markStart(engine: CarryEngine, slots: StateSlots): StartMark {
  try {
    const prints = engine.getGlobalsFingerprint?.(slots.indices) ?? null;
    if (prints && prints.length === slots.indices.length) return { prints, values: null };
  } catch {
    // Digests are a saving; values answer the same question.
  }
  try {
    return { prints: null, values: engine.getGlobalsBatch(slots.indices).map(plainCopy) };
  } catch {
    return { prints: null, values: null };
  }
}
