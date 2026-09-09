/**
 * Egress for CSS a component writes itself.
 *
 * The renderer scrubs `props.style` for a remote `url()` before any component
 * is constructed, and that object is the only inline CSS it knows about. A
 * layout component that takes `background` as a prop of its own and copies
 * it into the style it builds is a second route to the identical fetch:
 * `<Box background="url(https://attacker.example/x)">` painted, and so
 * requested, with no `net` grant. The question is the renderer's, asked of
 * the same policy, at the one place the value turns into CSS.
 */

import { useMemo } from 'react';
import {
  cssResourceReferences,
  describeMarkupEgress,
  useEgressConfig,
  type EgressConfig,
} from '@softn/core';

/**
 * A CSS value as the app may paint it: unchanged when it names nothing to
 * fetch, or every resource it names is one the policy allows; `undefined`
 * when any is refused. A value the scan could not read through — an escape
 * next to a function name — is refused too, exactly as the renderer refuses
 * it in `style`, because nothing a background legitimately says needs one.
 * No config means the host is not enforcing, and the value passes as it is.
 */
export function judgeCssValue(
  value: string | undefined,
  egress: EgressConfig | null | undefined
): string | undefined {
  if (typeof value !== 'string' || !egress) return value;
  const scan = cssResourceReferences(value);
  if (scan.opaque) return undefined;
  if (scan.urls.length === 0) return value;
  return scan.urls.every((target) => describeMarkupEgress(target, egress).allowed) ? value : undefined;
}

/** {@link judgeCssValue} against the host's decision for the tree above. */
export function useJudgedBackground(value: string | undefined): string | undefined {
  const egress = useEgressConfig();
  return useMemo(() => judgeCssValue(value, egress), [value, egress]);
}
