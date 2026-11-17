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
  // A site is shown as a site's name is written; an entry that is not one reaches no site,
  // and is not the app's to put words in the bar with.
  const named = netHosts.filter((host) => HOST_NAME.test(host));
  const reach =
    netHosts.length === 0
      ? 'any site'
      : named.length === 0
        ? 'no site'
        : named.slice(0, 6).join(', ') + (named.length > 6 ? `, and ${named.length - 6} more` : '');
  const labels = requested.map((c) => (c === 'net' ? `${describeCapability(c).label} (${reach})` : describeCapability(c).label)).join(', ');
  const msg = document.createElement('span');
  msg.append(ownWord(appName), ` requests access to: ${labels}`);

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

/** A site's name as an address has it. */
const HOST_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i;

/**
 * A word of the app's own (its name, a file's name) among the bar's words: kept to itself,
 * so that whichever way it reads, the bar's words before and after it read their own way.
 */
function ownWord(text: string, strong = false): HTMLElement {
  const word = document.createElement('bdi');
  word.textContent = text;
  if (strong) word.style.cssText = 'font-weight:600';
  return word;
}

/** The most of a file's name the bar shows. */
const SHOWN_NAME_LENGTH = 64;

/**
 * A file's name as the bar shows it: all of it when it is short, and its beginning and its
 * end when it is long. The end is the part that says what the file is, so it is never the
 * part left out.
 */
export function shownFileName(name: string): string {
  const letters = Array.from(name);
  if (letters.length <= SHOWN_NAME_LENGTH) return name;
  return `${letters.slice(0, SHOWN_NAME_LENGTH - 25).join('')}…${letters.slice(-24).join('')}`;
}

/** How long the bar is up before its Save button answers: a click already on its way to the app is not a yes. */
const SAVE_GUARD_MS = 400;

/** A size as a person reads one. */
function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The bar that asks before an app saves a file to the person's disk.
 *
 * A file saved from a page is saved in the page's name: the browser says it came from the
 * site the app is embedded in. So the embedding page asks, in words of its own that name
 * the app and the file, and nothing is saved until the person says so. Drawn in a shadow
 * root of its own, as the consent bar is, where no stylesheet of the app's reaches it.
 */
export function renderSaveBar(appName: string, fileName: string, bytes: number, onDecision: (save: boolean) => void): HTMLElement {
  const bar = document.createElement('div');
  bar.setAttribute('data-softn-save-bar', '');
  bar.setAttribute('role', 'alertdialog');
  bar.setAttribute('aria-label', 'Save a file');
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
  ].join(';');

  const msg = document.createElement('span');
  msg.style.cssText = 'overflow-wrap:anywhere;min-width:0';
  // The app's name and the file's are the app's words: each is kept to itself and shown as
  // text, the file's between marks so it reads as one.
  msg.append(ownWord(appName), ' wants to save a file to this device: “', ownWord(shownFileName(fileName), true), `” (${sizeLabel(bytes)})`);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:0.5rem;align-items:center';
  // The bar appears where the app was a moment ago. A click that was on its way to the app
  // lands on the bar: it may say no, and may not say yes.
  const shownAt = performance.now();
  const answer = (save: boolean) => () => {
    if (save && performance.now() - shownAt < SAVE_GUARD_MS) return;
    bar.remove();
    onDecision(save);
  };

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save';
  saveBtn.setAttribute('data-softn-save-allow', '');
  saveBtn.style.cssText = 'padding:0.28rem 0.7rem;border-radius:6px;border:none;background:#2563eb;color:#fff;font-size:0.78rem;font-weight:600;cursor:pointer';
  saveBtn.addEventListener('click', answer(true));

  const denyBtn = document.createElement('button');
  denyBtn.type = 'button';
  denyBtn.textContent = 'Not now';
  denyBtn.setAttribute('data-softn-save-deny', '');
  denyBtn.style.cssText = 'padding:0.28rem 0.7rem;border-radius:6px;border:1px solid #475569;background:transparent;color:#cbd5e1;font-size:0.78rem;cursor:pointer';
  denyBtn.addEventListener('click', answer(false));

  actions.append(saveBtn, denyBtn);
  bar.append(msg, actions);
  return bar;
}