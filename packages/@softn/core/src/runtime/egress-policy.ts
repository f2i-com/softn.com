/**
 * One answer to "may this app reach that host?", for every place that asks.
 *
 * `softn.net.fetch` had a careful answer — scheme, `allow_http`, the
 * `allowed_hosts` list — and nothing else did. A remote `<img src>` in the
 * bundle's markup, an inline `background-image`, an `<audio>` source, the
 * server the manifest names for sync: each of those is the same request to
 * the same host, and each had either a weaker check or none. The consent bar
 * withheld them all while it was unanswered, and after Allow they went where
 * they liked, whether or not the bundle had declared `net` and whichever hosts
 * it had scoped itself to.
 *
 * The rules live here and every sink calls in. There are two questions, kept
 * apart because callers arrive with different amounts of context:
 *
 * - {@link describeNetDestination}: is this URL a destination the declared
 *   `net` entry permits? Scheme, HTTP, host list. Says nothing about whether
 *   `net` was granted — the script runtime has its own gate for that, with
 *   its own wording.
 * - {@link describeMarkupEgress}: the whole decision for a URL that a render
 *   would hand to the browser. Not egress at all (relative, `data:`, `blob:`)
 *   is allowed with no capability; egress needs `net` granted and the
 *   destination permitted. A host that supplied no permission config is not
 *   enforcing — the builder's palette and the studio preview render markup
 *   outside any bundle — and gets the old behaviour.
 */

import { isRemoteUrl, type MarkupUrlJudge } from '../renderer/sanitize-html';

export interface NetPermission {
  enabled?: boolean;
  allowed_hosts?: string[];
  allow_http?: boolean;
}

/** The slice of a permission config that egress decisions read. */
export interface EgressConfig {
  permissions?: { net?: NetPermission };
  consentPending?: boolean;
}

export type EgressVerdict = { allowed: true } | { allowed: false; reason: string };

const ALLOW: EgressVerdict = { allowed: true };

function deny(reason: string): EgressVerdict {
  return { allowed: false, reason };
}

/**
 * Whether the declared `net` entry permits a request to `url`.
 *
 * Only the destination is judged: whether `net` itself is enabled or granted is
 * the caller's question, because the caller knows what to tell the user about
 * it. An unparseable URL is refused; so is any scheme but http(s), whatever
 * the config says, because `file:`, `javascript:` and `data:` are not hosts.
 */
export function describeNetDestination(
  url: string,
  net: NetPermission | undefined
): EgressVerdict {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return deny(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return deny(`Scheme not allowed: ${parsed.protocol}`);
  }
  if (parsed.protocol === 'http:' && net?.allow_http !== true) {
    return deny(
      `HTTP not allowed (only HTTPS). Set net.allow_http in permission.json to allow: ${url}`
    );
  }
  const listed = Array.isArray(net?.allowed_hosts) && net.allowed_hosts.includes(parsed.hostname);
  if (Array.isArray(net?.allowed_hosts) && net.allowed_hosts.length > 0 && !listed) {
    return deny(`Host not allowed: ${parsed.hostname}`);
  }
  // `net` with no host list is the internet, not the person's own machine or
  // network: a router's admin page, a printer, a development server. Those
  // answer a request from anywhere they can be reached, and a bundle could
  // send one from an image tag. An app that means to reach one names it.
  if (!listed && isLocalHostname(parsed.hostname)) {
    return deny(
      `Host not allowed: ${parsed.hostname} is on this computer or its local network. Name it in net.allowed_hosts to reach it.`
    );
  }
  return ALLOW;
}

/**
 * Whether a URL's hostname, as the URL parser gives it, names this computer
 * or its local network: loopback, the private and link-local ranges, the
 * shared address space, `localhost` and the names kept for local networks.
 * A name that resolves to such an address is beyond what a page can see; the
 * desktop runtime, which can resolve it, checks that too (net.rs).
 */
export function isLocalHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, '');
  if (name === 'localhost' || /\.(?:localhost|local|internal|home\.arpa|lan|home|corp|intranet|private|localdomain)$/.test(name)) return true;
  // A name of one label (`router`, `intranet`) is found by the local
  // network's own resolver, never on the internet's.
  if (!name.includes('.') && !name.startsWith('[') && name !== '') return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(name);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (!name.startsWith('[')) return false;
  const v6 = name.slice(1, -1);
  // Loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10),
  // the old site-local (fec0::/10), and the local-use NAT64 prefix (64:ff9b:1::/48).
  if (v6 === '::1' || v6 === '::' || /^f[cd]/.test(v6) || /^fe[89a-f]/.test(v6) || /^64:ff9b:1:/.test(v6)) return true;
  // An IPv4 address written as IPv6, which the parser gives in hex: mapped
  // (::ffff:a.b.c.d), the old compatible form (::a.b.c.d), and the NAT64
  // well-known prefix (64:ff9b::a.b.c.d). Local when the IPv4 address is.
  const embedded = /^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (embedded) {
    const high = parseInt(embedded[1], 16);
    const low = parseInt(embedded[2], 16);
    return isLocalHostname(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return false;
}

/**
 * The same destination test for a WebSocket URL: `ws:` is judged as `http:`
 * and `wss:` as `https:`, so a bundle's `allowed_hosts` and `allow_http`
 * govern the server it syncs to exactly as they govern what it fetches.
 */
export function describeSocketDestination(
  url: string,
  net: NetPermission | undefined
): EgressVerdict {
  const asHttp = url.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
  return describeNetDestination(asHttp, net);
}

/**
 * Only the host list, for a URL whose scheme is policed elsewhere.
 *
 * The manifest's sync server is one: `ws://localhost` is allowed there for
 * development by the sync client itself, so the `allow_http` rule would be
 * wrong here — but a bundle that scoped itself to a host list is held to it
 * for the server too. With no list declared, every host passes.
 */
export function describeHostAllowlist(url: string, net: NetPermission | undefined): EgressVerdict {
  if (!Array.isArray(net?.allowed_hosts) || net.allowed_hosts.length === 0) return ALLOW;
  let parsed: URL;
  try {
    parsed = new URL(url.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:'));
  } catch {
    return deny(`Invalid URL: ${url}`);
  }
  if (!net.allowed_hosts.includes(parsed.hostname)) {
    return deny(`Host not allowed: ${parsed.hostname}`);
  }
  return ALLOW;
}

/**
 * Resolve a URL against the page it will load from, for the purpose of
 * judging its destination. Protocol-relative and absolute URLs need a base;
 * without one, `//host/x` cannot be parsed at all.
 */
function resolveForJudgement(url: string): string {
  const probe = url.trim().replace(/\\/g, '/');
  if (probe.startsWith('//')) {
    const scheme =
      typeof location !== 'undefined' && location.protocol === 'http:' ? 'http:' : 'https:';
    return scheme + probe;
  }
  return probe;
}

/**
 * Whether a URL the render is about to hand to the browser may go out.
 *
 * `config` undefined means the host is not enforcing; `consentPending` means
 * the bar is unanswered and nothing remote goes out; otherwise the URL must
 * not be egress at all, or `net` must be enabled and permit the destination.
 */
export function describeMarkupEgress(
  url: string,
  config: EgressConfig | null | undefined
): EgressVerdict {
  if (!isRemoteUrl(url)) return ALLOW;
  if (!config) return ALLOW;
  if (config.consentPending) {
    return deny('Withheld until the user answers the permission bar');
  }
  const net = config.permissions?.net;
  if (net?.enabled !== true) {
    return deny(
      'Network access not permitted: the bundle loads a remote resource but declares no ' +
        '{ "net": { "enabled": true } } in permission.json'
    );
  }
  return describeNetDestination(resolveForJudgement(url), net);
}

/**
 * Which of the signalling servers a script asked its sync room to use it may
 * actually have.
 *
 * `db.startSync(room, { signaling: [...] })` opens a WebSocket to every URL in
 * the list and pushes the room's awareness and CRDT updates through it. That
 * is egress like any other, judged like any other: the bundle needs `net`,
 * and the host must be one `allowed_hosts` permits. A URL that fails is
 * dropped, not the whole request — the host's own default signalling still
 * applies when nothing survives — and the caller is told which ones went.
 */
export function filterSignalingUrls(
  urls: unknown,
  config: EgressConfig | null | undefined
): { allowed: string[]; refused: Array<{ url: string; reason: string }> } {
  const allowed: string[] = [];
  const refused: Array<{ url: string; reason: string }> = [];
  if (!Array.isArray(urls)) return { allowed, refused };
  for (const candidate of urls) {
    if (typeof candidate !== 'string') continue;
    let verdict: EgressVerdict;
    if (!config) verdict = ALLOW;
    else if (config.consentPending) verdict = deny('Withheld until the user answers the permission bar');
    else if (config.permissions?.net?.enabled !== true) {
      verdict = deny('Network access not permitted: a signalling server needs { "net": { "enabled": true } }');
    } else verdict = describeSocketDestination(candidate, config.permissions.net);
    if (verdict.allowed) allowed.push(candidate);
    else refused.push({ url: candidate, reason: verdict.reason });
  }
  return { allowed, refused };
}

/**
 * The judge `sanitizeRichText` and `sanitizeSvg` take: the decision the
 * renderer makes for a URL prop, applied to markup that arrives as a string
 * and never passes through a prop. A rich-text value with `<img
 * src="https://…">` and an icon with `<use href="https://…">` used to be
 * judged on scheme alone, so a bundle with no `net` reached the network
 * through them on first paint.
 *
 * `href` on an `<a>` is navigation the user chooses and can see, withheld
 * only while the consent bar is unanswered; everywhere else — `src`,
 * `srcset`, `poster`, an SVG `href` — is a fetch the render performs. No
 * config means the host is not enforcing, and there is no judge.
 */
export function markupUrlJudge(config: EgressConfig | null | undefined): MarkupUrlJudge | undefined {
  if (!config) return undefined;
  return (url, attribute, tag) => {
    if (attribute === 'href' && tag === 'a') return !(config.consentPending && isRemoteUrl(url));
    if (attribute === 'srcset') return describeSrcSetEgress(url, config).allowed;
    return describeMarkupEgress(url, config).allowed;
  };
}

/**
 * The same decision for a `srcset`, which is a list rather than a URL: every
 * candidate must be allowed, because the browser picks whichever it prefers.
 */
export function describeSrcSetEgress(
  value: string,
  config: EgressConfig | null | undefined
): EgressVerdict {
  for (const candidate of value.split(',')) {
    const url = candidate.trim().split(/\s+/)[0] ?? '';
    if (!url) continue;
    const verdict = describeMarkupEgress(url, config);
    if (!verdict.allowed) return verdict;
  }
  return ALLOW;
}
