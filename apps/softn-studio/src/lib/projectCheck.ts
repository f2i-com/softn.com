/**
 * Studio's check, kept current: the problem list under the canvas, which
 * holds Run and Publish back while it holds an error.
 *
 * Two parts. The validator (lib/validator.ts) answers at once: the bundle as
 * the directory inspects it, the composer, and every page as core's parser
 * reads it. Whether the logic compiles is the engine's to say
 * (lib/logicCheck.ts), which takes a moment, so it is asked a moment after
 * the files settle, and only when what it reads has changed: the pages, the
 * logic and the manifest, not a record in a data file.
 *
 * The engine's last answer is kept with the files it was given. While a new
 * one is coming, the last one for this project stands, so an app that did
 * not compile does not flash "No problems", and Run does not come back on,
 * before the engine has said it compiles now.
 */

import { useEffect, useRef } from 'react';
import { useVFSStore, useWorkspaceStore } from '../stores';
import type { ValidationError, VFSFile } from '../types/studio';
import { logicSyntaxProblems } from './logicCheck';
import { isLogicPath, isPagePath } from './sourceKinds';
import { validateProject } from './validator';

/** How long the files must keep still before the engine is asked. */
export const LOGIC_CHECK_DELAY_MS = 250;

/** What the engine's answer depends on: the pages (and their inline logic), the logic files and the manifest. */
export function logicCheckKey(files: Map<string, VFSFile>): string {
  const parts: string[] = [];
  for (const [path, file] of files) {
    if (typeof file.content !== 'string') continue;
    if (path === 'manifest.json' || isPagePath(path) || isLogicPath(path)) parts.push(`${path}\u0000${file.content}`);
  }
  return parts.sort().join('\u0001');
}

interface LogicAnswer {
  projectId: string | null;
  key: string;
  problems: ValidationError[];
}

/** Keep the workspace's problem list current for the project in the stores, while `enabled`. */
export function useProjectCheck(enabled: boolean): void {
  const files = useVFSStore((s) => s.files);
  const blueprint = useWorkspaceStore((s) => s.blueprint);
  const projectId = useWorkspaceStore((s) => s.projectId);
  const answer = useRef<LogicAnswer | null>(null);

  useEffect(() => {
    if (!enabled || files.size === 0) return;
    const found = validateProject(files, blueprint);
    const key = logicCheckKey(files);
    const held = answer.current?.projectId === projectId ? answer.current : null;
    const publish = (logic: ValidationError[]) => useWorkspaceStore.getState().setErrors([...found, ...logic]);
    publish(held?.problems ?? []);
    if (held?.key === key) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void logicSyntaxProblems(files).then(
        (problems) => {
          if (cancelled || useVFSStore.getState().files !== files) return;
          answer.current = { projectId, key, problems };
          publish(problems);
        },
        () => {
          // The engine could not be asked (it did not load): the preview says why.
        },
      );
    }, LOGIC_CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, files, blueprint, projectId]);
}
