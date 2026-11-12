/**
 * What to do after a run did not finish.
 *
 * A run that stops says why, in its own block of the chat, and often names
 * the control that mends it: "enter the key it expects", "raise the limit in
 * Settings". The only button under those words was Continue, which sends the
 * same request again with the same key and the same limit. The reason for
 * the stop was kept (`lastFailure` in the AI store) and never shown.
 *
 * This turns that reason into one line of what happened, one of what to do,
 * and the control to do it with, where Studio has one: the AI setup, the
 * provider's own key and address, or the limits in Settings. The chat draws
 * it above the box a message is typed in (components/ai/FailureNextStep.tsx).
 */

import type { AIFailure } from '../../types/studio';

export interface NextStep {
  /** What happened, in a line. */
  title: string;
  /** What to do about it. */
  advice: string;
  /** The control that mends it, when one of Studio's does. */
  action?: { label: string; opens: NonNullable<AIFailure['fix']> };
}

export interface NextStepContext {
  /** The provider the AI uses, by its name here. */
  providerName?: string;
  /** The run that stopped is the last thing in the chat and can go on: 'continue', or 'resume' for one that paused. */
  goOn?: 'continue' | 'resume';
  /** A hosted editor's AI is its host's: there is no setup here to open. */
  hosted?: boolean;
}

/** The step for a failure, or null for one that needs none (the person stopped the run themselves). */
export function nextStepFor(failure: AIFailure, context: NextStepContext = {}): NextStep | null {
  if (failure.kind === 'cancelled') return null;
  const provider = context.providerName?.trim() || 'the provider';
  const button = context.goOn === 'resume' ? 'Resume' : 'Continue';
  /** How the request is asked again once the thing is mended. */
  const again = context.goOn ? `press ${button} on the run above` : 'send your message again';
  const then = `then ${again}`;
  const limits: NextStep['action'] = { label: 'Open the limits', opens: 'limits' };
  const check: NextStep['action'] = { label: `Check ${provider}`, opens: 'provider' };

  let step: NextStep;
  switch (failure.kind) {
    case 'setup':
      step = {
        title: 'The AI is not set up yet',
        advice: 'Connect a provider and choose one of its models, then send your message again.',
        action: { label: 'Open AI setup', opens: 'setup' },
      };
      break;
    case 'budget':
      step = {
        title: 'The AI stopped at a limit you set',
        advice: `Raise the limit, or reset what is used, in Settings, ${then}.`,
        action: limits,
      };
      break;
    case 'timeout':
      step = {
        title: 'The AI provider took too long to answer',
        advice: `To ask again, ${again}. If it keeps happening, allow a longer wait: Request timeout, in Settings.`,
        action: limits,
      };
      break;
    case 'rate-limited': {
      const seconds = failure.retryAfterMs && failure.retryAfterMs > 0 ? Math.ceil(failure.retryAfterMs / 1000) : 0;
      step = {
        title: 'The AI provider is turning requests away for now',
        advice: `${seconds ? `It asked for ${seconds} ${seconds === 1 ? 'second' : 'seconds'}. Wait that long` : 'Wait a moment'}, ${then}. If it goes on, check the usage and billing of your account with ${provider}.`,
      };
      break;
    }
    case 'network':
      step = {
        title: 'Studio could not reach the AI provider',
        advice: `Check that it is running and that its address is right, ${then}.`,
        action: check,
      };
      break;
    case 'invalid-response':
      step = {
        title: 'The AI provider’s answer could not be read',
        advice: `To ask again, ${again}. If it keeps happening, check that the address is the provider’s own.`,
        action: check,
      };
      break;
    case 'truncated':
      step = failure.fix === 'limits'
        ? { title: 'The model’s reply was cut off at the output limit', advice: `Raise Max output tokens in Settings, or ask for a smaller change, ${then}.`, action: limits }
        : { title: 'The model’s reply was cut off at the most it allows', advice: `Ask for a smaller change, or choose a model that allows longer replies, ${then}.`, action: { label: 'Choose another model', opens: 'provider' } };
      break;
    case 'refused':
      step = { title: 'The model declined this request', advice: 'Say it another way, or ask for something else.' };
      break;
    case 'empty':
      step = {
        title: 'The model answered without building anything',
        advice: `Smaller models often cannot use the tools that write files. To let it try again, ${again}; or choose a larger model.`,
        action: { label: 'Choose another model', opens: 'provider' },
      };
      break;
    case 'stuck':
      step = {
        title: 'The run stopped itself',
        advice: `It kept meeting the same problem, which the run above names. Say how to fix it in a message, or ${again} to let it try again.`,
      };
      break;
    default:
      // A provider's own error.
      step = failure.fix === 'provider'
        ? { title: 'The AI provider answered with an error', advice: `Check its key and its address, ${then}.`, action: check }
        : failure.fix === 'limits'
          ? { title: 'The AI provider would not take the request', advice: `Change the limit it names, in Settings, ${then}.`, action: limits }
          : { title: 'The AI provider had an error of its own', advice: `Give it a moment, ${then}.` };
  }
  // No setup to open in a hosted editor: its AI is chosen in the host.
  if (context.hosted && step.action && step.action.opens !== 'limits') {
    return { title: step.title, advice: `${step.advice} The AI here is the one chosen in the site Studio is opened in.` };
  }
  return step;
}
