/**
 * What the chat's header says of the session's AI use.
 *
 * It said "0/15 runs | 0 tokens" from the first moment, of a session in which
 * nothing had run, beside two pills ("Plan ready", "2 pages") that repeated
 * the Pages panel: three facts, none of them news, above every conversation.
 * The line now says nothing until something has been used, stays quiet while
 * there is room, and speaks up when the room is running out, which is the one
 * time the numbers decide what a person does next.
 */

export interface SessionUse {
  text: string;
  /** quiet: there is room. near: the limit is close. spent: the next run is refused. */
  level: 'quiet' | 'near' | 'spent';
}

export interface SessionCounts {
  iterationsUsed: number;
  maxIterations: number;
  tokensUsed: number;
  tokenBudget: number;
}

const runs = (count: number) => `${count} ${count === 1 ? 'run' : 'runs'}`;

/** The line, or null while nothing has been used: an empty count is not worth its room. */
export function sessionUse({ iterationsUsed, maxIterations, tokensUsed, tokenBudget }: SessionCounts): SessionUse | null {
  if (iterationsUsed <= 0 && tokensUsed <= 0) return null;
  const runsLeft = maxIterations - iterationsUsed;
  if (runsLeft <= 0) return { text: `No runs left: ${iterationsUsed} of ${maxIterations} used`, level: 'spent' };
  if (tokenBudget > 0 && tokensUsed >= tokenBudget) return { text: `Token budget used: ${tokensUsed.toLocaleString()} of ${tokenBudget.toLocaleString()}`, level: 'spent' };
  // Close: the last fifth of the runs (the last one at least), or of the tokens.
  if (runsLeft <= Math.max(1, Math.floor(maxIterations / 5))) return { text: `${runs(runsLeft)} left of ${maxIterations}`, level: 'near' };
  if (tokenBudget > 0 && tokensUsed >= tokenBudget * 0.8) return { text: `${Math.floor((tokensUsed / tokenBudget) * 100)}% of the token budget used`, level: 'near' };
  return { text: `${iterationsUsed} of ${runs(maxIterations)} · ${tokensUsed.toLocaleString()} tokens`, level: 'quiet' };
}
