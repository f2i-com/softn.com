/**
 * The small part of the document a page's code is given, which every
 * runtime carries: the names the shell declares, whether code asks for it,
 * and what the host must leave alone. The shell itself (shell-source.ts) and
 * its host side (host.ts) are loaded only for a page whose code uses them,
 * since most pages never do and every app would otherwise carry both.
 */

/** The id of the page's `html` in the document; the body's is 1. */
export const SHELL_HTML_ID = -2;

/**
 * The functions the host calls, declared at the top of the logic. The shell
 * is started with its seed inline (shellPrelude), so it has no init of its own.
 */
export const SHELL_TAKE = '__softnDocTake';
export const SHELL_EVENT = '__softnDocEvent';
export const SHELL_SYNC = '__softnDocSync';
export const SHELL_READY = '__softnDocReady';

/** Names the shell declares at the top of the logic: none of them is the page's state. */
export const SHELL_GLOBAL_NAMES: ReadonlySet<string> = new Set([
  '__softnShell',
  'document',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLSelectElement',
  'HTMLOptionElement',
  'HTMLFormElement',
  'HTMLButtonElement',
  'HTMLAnchorElement',
  'HTMLImageElement',
  'Text',
  'Comment',
  'DocumentFragment',
  'Event',
  'CustomEvent',
  'KeyboardEvent',
  'MouseEvent',
  'InputEvent',
  'FocusEvent',
  'SubmitEvent',
  'FormData',
  'getComputedStyle',
  'fetch',
  'Headers',
  'Response',
  'location',
  'URLSearchParams',
  'queueMicrotask',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'structuredClone',
  'sessionStorage',
  'alert',
  'confirm',
  'prompt',
  'EventTarget',
  'DOMException',
  'AbortController',
  'AbortSignal',
  'URL',
  'btoa',
  'atob',
  'TextEncoder',
  'TextDecoder',
  'crypto',
  'MutationObserver',
  'ResizeObserver',
  'IntersectionObserver',
  'matchMedia',
  'history',
  'HTMLOutputElement',
  'HTMLTemplateElement',
  'HTMLDialogElement',
  'PointerEvent',
  'DragEvent',
  'DataTransfer',
  'SVGElement',
]);

/**
 * Whether a declared name is the shell's own: the functions the host calls
 * and the shell itself. The names it gives the page are properties of the
 * global object, never declarations, so a page that declares one of them
 * declares its own.
 */
export function isShellName(name: string): boolean {
  return name.startsWith('__softnDoc') || name === '__softnShell';
}

/**
 * Whether a value read out of the engine holds a node of the document, or a
 * list or record of them: the engine's copy of `const list =
 * document.getElementById('list')`. Written back, it would replace the node
 * with a plain record, and the code's next `list.appendChild` would fail.
 */
export function holdsShellNode(value: unknown, depth = 0): boolean {
  if (value === null || typeof value !== 'object' || depth > 3) return false;
  if (typeof (value as { __softnNode?: unknown }).__softnNode === 'number') return true;
  const items = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (let i = 0; i < items.length && i < 64; i++) if (holdsShellNode(items[i], depth + 1)) return true;
  return false;
}

/**
 * Whether code is written for a browser: it names `document`, or another of
 * the window's names the shell gives (`fetch(…)`, `location.…`,
 * `URLSearchParams`…) as a name of its own rather than a property
 * (`user.location` is not one). Read roughly, comments and strings
 * included; a page that only mentions one gets a document it does not use,
 * which costs a little and changes nothing.
 *
 * `TextEncoder` and `TextDecoder` are not among them: the engine has its own
 * (ZIPP 0.0.28), which the shell leaves in place, so code naming nothing else
 * would be given a document for nothing.
 */
export function usesDocument(code: string): boolean {
  return (
    /\bdocument\s*[.[]/.test(code) ||
    /(?<![.\w$])(?:fetch\s*\(|location\s*[.=[]|URLSearchParams\b|requestAnimationFrame\b|queueMicrotask\b|structuredClone\b|sessionStorage\b|(?:alert|confirm|prompt|btoa|atob|matchMedia)\s*\(|(?:crypto|history|URL|AbortSignal)\s*\.|inner(?:Width|Height)\b)/.test(code) ||
    /\bnew\s+(?:URL|AbortController|EventTarget|MutationObserver|ResizeObserver|IntersectionObserver|DOMException)\b/.test(code) ||
    /\bwindow\s*\.\s*(?:matchMedia|history|inner(?:Width|Height)|crypto|location|fetch|alert|btoa|atob)\b/.test(code)
  );
}

/**
 * Whether a page's markup has a handler written for a browser that SoftN
 * does not read (`onclick="this.classList.toggle('on')"`, kept as the
 * attribute by the parser): such a page is given its document, where the
 * handler runs as a browser runs it, whether or not it has code of its own.
 */
export function hasPageHandlers(nodes: readonly unknown[]): boolean {
  for (const node of nodes as Array<Record<string, unknown>>) {
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'Element') {
      const props = node.props as Array<{ name: string; value: { type: string } }>;
      if (props.some((prop) => /^on[a-z]/i.test(prop.name) && prop.value.type === 'static')) return true;
    }
    for (const key of ['children', 'consequent', 'alternate', 'body', 'emptyFallback']) {
      const inner = node[key];
      if (Array.isArray(inner) && hasPageHandlers(inner)) return true;
      if (inner && typeof inner === 'object' && !Array.isArray(inner) && hasPageHandlers([inner])) return true;
    }
  }
  return false;
}

/**
 * The names of SHELL_GLOBAL_NAMES the page's code declares itself: a `class
 * Comment` of its own, or `let Event`. Those are left to it, since declaring
 * them again would keep the whole script from compiling. Read roughly, as a
 * name after a declaring word.
 */
export function namesDeclaredBy(code: string): Set<string> {
  const declared = new Set<string>();
  for (const name of SHELL_GLOBAL_NAMES) {
    const escaped = name.replace(/\$/g, '\\$');
    if (new RegExp('\\b(?:let|const|var|class|function)\\s+' + escaped + '\\b').test(code)) declared.add(name);
  }
  return declared;
}
