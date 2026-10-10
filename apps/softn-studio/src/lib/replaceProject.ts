/**
 * The first step of anything that replaces the open project: a new app, an
 * example, an import, a project opened from the list, and the host opening
 * an app in a hosted Studio.
 *
 * Two things stand in the way of a replacement. A run left working would
 * finish against the project that takes this one's place and write its files
 * there, so it is discarded. And a file being edited by hand, with changes
 * not saved, goes with the project, so the person is asked.
 *
 * They are done in that order's reverse. Each caller used to discard the run
 * and then ask: a person who answered Cancel kept the draft and the project,
 * and the run they had been waiting for was already gone, its row left
 * saying "working" over nothing. The question comes first, and until it is
 * answered nothing is stopped and no other open is superseded.
 */

import { abortAgentTurn } from './agentOrchestrator';
import { confirmLeaveDraft } from './handEdit';
import { claimWorkspace } from './projectSession';

/**
 * Take the workspace for a replacement. Answers the generation claimed
 * (`owner` when an earlier step, the remote open, already claimed one), or
 * null when the person would rather stay: then nothing has changed.
 */
export function beginReplacingProject(owner?: number): number | null {
  if (!confirmLeaveDraft()) return null;
  const generation = owner ?? claimWorkspace().generation;
  abortAgentTurn();
  return generation;
}
