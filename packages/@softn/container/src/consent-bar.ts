/**
 * Lightweight, Zero-React Capability Consent Bar rendered inside `<softn-app>`'s ShadowRoot.
 * Non-blocking: the app renders and stays interactive below the bar while the visitor decides.
 */

import { describeCapability, type Capability } from '@softn/bundle-format/capabilities';

export function renderConsentBar(
  requested: readonly Capability[],
  appName: string,
  onDecision: (granted: boolean) => void,
  /** The hosts the app's network grant names; none listed means any site, and the bar says so. */
  netHosts: readonly string[] = []
): HTMLElement {
  const bar = document.createElement('div');
  bar.setAttribute('data-softn-consent-bar', '');
  bar.style.cssText = [
    'display:flex',
    'align-items:center',
    'justify-content:space-between',
    'flex-wrap:wrap',
    'gap:0.75rem',
    'padding:0.55rem 0.9rem',
    'background:#0f172a',
    'color:#f8fafc',
    'border-bottom:1px solid #334155',
    'font-size:0.8125rem',
    'font-family:system-ui,-apple-system,sans-serif',
    'z-index:2147483647',
  ].join(';');

  // What "the network" means for this app is part of what is being asked: the sites it
  // names, or any site at all when it names none. The bar said "network" for both.
  const reach = netHosts.length > 0 ? netHosts.slice(0, 6).join(', ') + (netHosts.length > 6 ? `, and ${netHosts.length - 6} more` : '') : 'any site';
  const labels = requested.map((c) => (c === 'net' ? `${describeCapability(c).label} (${reach})` : describeCapability(c).label)).join(', ');
  const msg = document.createElement('span');
  msg.textContent = `${appName} requests access to: ${labels}`;

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:0.5rem;align-items:center';

  const allowBtn = document.createElement('button');
  allowBtn.type = 'button';
  allowBtn.textContent = 'Allow';
  allowBtn.style.cssText =
    'padding:0.28rem 0.7rem;border-radius:6px;border:none;background:#2563eb;color:#fff;font-size:0.78rem;font-weight:600;cursor:pointer';
  allowBtn.addEventListener('click', () => {
    bar.remove();
    onDecision(true);
  });

  const denyBtn = document.createElement('button');
  denyBtn.type = 'button';
  denyBtn.textContent = 'Not now';
  denyBtn.style.cssText =
    'padding:0.28rem 0.7rem;border-radius:6px;border:1px solid #475569;background:transparent;color:#cbd5e1;font-size:0.78rem;cursor:pointer';
  denyBtn.addEventListener('click', () => {
    bar.remove();
    onDecision(false);
  });

  actions.append(allowBtn, denyBtn);
  bar.append(msg, actions);
  return bar;
}
