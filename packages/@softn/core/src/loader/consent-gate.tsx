/**
 * Consent state, published to the component tree.
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
 * A prop cannot carry the answer: those components are instantiated by the
 * document renderer from a .ui template, so the host would have to thread it
 * through every component in the registry. Context can, and it is per-tree,
 * which is what softn-web needs — every open tab is mounted at once in one
 * realm, and one tab's grant must not speak for another's.
 *
 * The default is `false`, so a component used outside a SoftN runtime — the
 * builder's palette, studio's preview, any React host importing
 * @softn/components directly — behaves exactly as it did. Only a host that
 * says it is holding capabilities back closes the gate.
 */

import React from 'react';

const ConsentPendingContext = React.createContext<boolean>(false);

/**
 * True while this app's declared capabilities are withheld pending the user's
 * answer. Anything that reaches a device, a network or a socket must not start
 * while it is true, and must start of its own accord when it turns false — the
 * grant arrives as a re-render, and a user who pressed Allow will not go
 * looking for a reload button.
 */
export function useConsentPending(): boolean {
  return React.useContext(ConsentPendingContext);
}

export const ConsentPendingProvider = ConsentPendingContext.Provider;
