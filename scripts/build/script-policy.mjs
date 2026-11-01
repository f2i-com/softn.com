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

/**
 * What a page says when its own code does not arrive. A half-finished upload,
 * or an old copy of the page naming files a deployment has replaced, left a
 * blank page, or the loading wheel for ever: the code that says what went wrong
 * is the code that is missing. So this much is written into the page. The
 * capturing listener is how a script element's `error` is heard from outside
 * it (the event does not bubble), and it stands down once the page has drawn.
 * Only the entry's failure lands here: a chunk loaded later is the app's to report.
 */
export const ENTRY_WATCH =
  "addEventListener('error',function(event){" +
  "var script=event.target,root=document.getElementById('root');" +
  "if(!root||!script||script.tagName!=='SCRIPT'||script.type!=='module')return;" +
  "if(root.childElementCount>0&&!document.getElementById('boot'))return;" +
  "var box=document.createElement('div'),text=document.createElement('p'),again=document.createElement('button');" +
  "box.setAttribute('role','alert');" +
  "box.style.cssText='min-height:100dvh;box-sizing:border-box;padding:24px;display:grid;place-content:center;justify-items:center;gap:12px;text-align:center;font:16px/1.5 system-ui';" +
  "text.style.margin='0';" +
  "text.textContent='This page could not load: part of it is missing. That can happen while the site is being updated.';" +
  "again.type='button';again.textContent='Reload';" +
  "again.addEventListener('click',function(){location.reload()});" +
  "box.appendChild(text);box.appendChild(again);" +
  "root.textContent='';root.appendChild(box)" +
  "},true);";

export function scriptPolicyPlugin() {
  return {
    name: 'softn-script-policy',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (/http-equiv=["']Content-Security-Policy["']/i.test(html)) return html;
        // Here, so that the policy below is written with it: an inline script
        // runs by its hash. Ahead of the page's other scripts, to hear of them.
        const watched = html.replace(/<head(\s[^>]*)?>/i, (head) => `${head}\n    <script>${ENTRY_WATCH}</script>`);
        const meta = `<meta http-equiv="Content-Security-Policy" content="${scriptPolicy(inlineScripts(watched))}" />`;
        // First in the head, before any script it governs.
        return watched.replace(/<head(\s[^>]*)?>/i, (head) => `${head}\n    ${meta}`);
      },
    },
  };
}
