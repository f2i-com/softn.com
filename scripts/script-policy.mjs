/**
 * A Content-Security-Policy for an app's built page, as a `<meta>` at the top
 * of its head: what runs as script is the deployment's own files, the
 * page's own inline scripts by hash, and WebAssembly.
 *
 * The apps' code is held to its sandbox by SoftN's checks: what a bundle's
 * markup may say, which attributes reach the page, which URLs. This is the
 * browser's own check behind them. If one of SoftN's ever lets an `onerror`,
 * a `javascript:` address or a `<script>` through, the browser still runs
 * none of it, because nothing but the deployment's own scripts runs at all.
 * It says nothing about what may be fetched or shown — that is each app's
 * own declaration, judged by the runtime — so it costs an app nothing.
 *
 * - `script-src`: this origin's files, the inline scripts the page was built
 *   with (each by its SHA-256, so an edited one stops running rather than
 *   running unchecked), and `'wasm-unsafe-eval'` for the engine. No
 *   `'unsafe-inline'` and no `'unsafe-eval'`.
 * - `object-src 'none'`: no plug-ins.
 * - `base-uri 'self'`: a `<base>` cannot move where the page's relative URLs go.
 * - `worker-src 'self' blob:`: the runtime's workers.
 *
 * Only at build: the dev server's injected scripts change on every edit.
 */
import { createHash } from 'node:crypto';

/**
 * The policy for a page whose inline scripts are `inline`. Each is hashed as
 * the browser hashes it, after reading the page: with every CR LF and lone
 * CR made LF, which a checkout with Windows line endings would otherwise
 * leave in, and the browser would then refuse the script it was built with.
 */
export function scriptPolicy(inline) {
  const hashes = inline.map(
    (source) => `'sha256-${createHash('sha256').update(source.replace(/\r\n?/g, '\n'), 'utf8').digest('base64')}'`
  );
  return [
    `script-src 'self' 'wasm-unsafe-eval'${hashes.length > 0 ? ` ${hashes.join(' ')}` : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "worker-src 'self' blob:",
  ].join('; ');
}

/** The classic inline scripts in `html`: no `src`, and a type that runs (not JSON or a template). */
export function inlineScripts(html) {
  const found = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attributes = match[1];
    if (/\bsrc\s*=/i.test(attributes)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attributes)?.[1]?.toLowerCase();
    if (type && type !== 'module' && type !== 'text/javascript' && type !== 'application/javascript') continue;
    found.push(match[2]);
  }
  return found;
}

export function scriptPolicyPlugin() {
  return {
    name: 'softn-script-policy',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (/http-equiv=["']Content-Security-Policy["']/i.test(html)) return html;
        const meta = `<meta http-equiv="Content-Security-Policy" content="${scriptPolicy(inlineScripts(html))}" />`;
        // First in the head, before any script it governs.
        return html.replace(/<head(\s[^>]*)?>/i, (head) => `${head}\n    ${meta}`);
      },
    },
  };
}
