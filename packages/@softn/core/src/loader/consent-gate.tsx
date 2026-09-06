/**
 * Capability state, published to the component tree.
 *
 * `permission.json` covers the softn.* scripting API and nothing else. The
 * hardware components — <Camera>, <QRReader>, <Microphone> — call
 * getUserMedia themselves, from a React effect, with no route through the
 * script runtime and therefore no capability check in front of them. While a
 * modal blocked the load that never mattered, because the app did not exist
 * until the user answered. Rendering the app first removes the accident: the
 * device is now reachable from an entry page while the bar is still asking,
 * unless something holds it, and this is what holds it.
 *
 * It used to hold only one bit — "is the bar unanswered?" — and once the bar
 * was answered the components opened the device whether or not the bundle had
 * declared it. A bundle that asked for `net` alone, and was allowed `net`
 * alone, got the camera: the browser had granted the origin, every bundle
 * shares the origin, and nothing asked which bundle the user had approved for
 * it. So what is published now is the whole decision: whether consent is
 * pending, and which capabilities the bundle declared and the user allowed.
 * A component asks about the one it needs and gets one of four answers.
 *
 * A prop cannot carry this: those components are instantiated by the
 * document renderer from a .ui template, so the host would have to thread it
 * through every component in the registry. Context can, and it is per-tree,
 * which is what softn-web needs — every open tab is mounted at once in one
 * realm, and one tab's grant must not speak for another's.
 *
 * The default — no provider above — is `unrestricted`, so a component used
 * outside a SoftN runtime (the builder's palette, studio's preview, any React
 * host importing @softn/components directly) behaves exactly as it did. Only
 * a host that publishes a permission config closes the gate, and it closes
 * it per capability.
 */

import React from 'react';
import type { EgressConfig } from '../runtime/egress-policy';

/** The capability names permission.json can declare. */
export type CapabilityName =
  | 'net'
  | 'camera'
  | 'mic'
  | 'files'
  | 'qr'
  | 'ai'
  | 'gpu'
  | 'sync'
  | 'storage'
  | 'accel';

/**
 * What a component learns about one capability.
 *
 * - `unrestricted`: no host is enforcing anything; behave as before.
 * - `granted`: the bundle declared it and the user allowed it.
 * - `pending`: the bar is unanswered; start nothing, and start on your own
 *   when the answer arrives as a re-render.
 * - `absent`: the host is enforcing and the bundle did not declare it (or the
 *   user refused). Do not touch the device, and say why.
 */
export type CapabilityStatus = 'unrestricted' | 'granted' | 'pending' | 'absent';

export interface CapabilityState {
  /** True while this app's declared capabilities are withheld pending the user's answer. */
  consentPending: boolean;
  /**
   * The capabilities in force: the bundle's declared, granted permissions.
   * `null` means the host is not enforcing — nothing is published because
   * nothing was declared to a host that checks.
   */
  permissions: Partial<Record<CapabilityName, { enabled?: boolean } | undefined>> | null;
}

const UNRESTRICTED: CapabilityState = { consentPending: false, permissions: null };

const CapabilityContext = React.createContext<CapabilityState>(UNRESTRICTED);

/** The host's whole capability decision, for the tree below. */
export const CapabilityProvider = CapabilityContext.Provider;

export function useCapabilityState(): CapabilityState {
  return React.useContext(CapabilityContext);
}

/** Resolve one capability against a published state. */
export function capabilityStatus(state: CapabilityState, name: CapabilityName): CapabilityStatus {
  if (state.consentPending) return 'pending';
  if (state.permissions === null) return 'unrestricted';
  // A config whose `permissions` key is missing or malformed declared nothing.
  return state.permissions?.[name]?.enabled === true ? 'granted' : 'absent';
}

/**
 * The answer for one capability. Anything that reaches a device, a network
 * or a socket must not start unless this is `granted` or `unrestricted`, and
 * must start of its own accord when it becomes so — the grant arrives as a
 * re-render, and a user who pressed Allow will not go looking for a reload.
 */
export function useCapability(name: CapabilityName): CapabilityStatus {
  return capabilityStatus(React.useContext(CapabilityContext), name);
}

/** Whether a status permits the thing it was asked about. */
export function isCapabilityAllowed(status: CapabilityStatus): boolean {
  return status === 'granted' || status === 'unrestricted';
}

/**
 * True while this app's declared capabilities are withheld pending the user's
 * answer. The one-bit view, kept for components that only need to phrase a
 * message differently — <Image> — and for hosts that publish nothing else.
 */
export function useConsentPending(): boolean {
  return React.useContext(CapabilityContext).consentPending;
}

/**
 * The host's whole network decision for markup below this point, in the
 * shape egress-policy.ts reads: null where the host is not enforcing. For
 * the components that take markup as a string — `<RichTextEditor value>`,
 * `<Icon svg>` — and so never have a URL prop the renderer could judge.
 */
export function useEgressConfig(): EgressConfig | null {
  const state = React.useContext(CapabilityContext);
  return React.useMemo(
    () =>
      state.permissions === null
        ? null
        : { consentPending: state.consentPending, permissions: state.permissions as EgressConfig['permissions'] },
    [state]
  );
}

/**
 * The one-bit provider, kept for hosts and tests that publish consent state
 * alone. It publishes no capability list, so below it every capability is
 * `pending` while the value is true and `unrestricted` once it is false —
 * exactly what it meant before the list existed.
 */
export function ConsentPendingProvider({
  value,
  children,
}: {
  value: boolean;
  children?: React.ReactNode;
}): React.ReactElement {
  const state = React.useMemo<CapabilityState>(
    () => (value ? { consentPending: true, permissions: null } : UNRESTRICTED),
    [value]
  );
  return <CapabilityContext.Provider value={state}>{children}</CapabilityContext.Provider>;
}
