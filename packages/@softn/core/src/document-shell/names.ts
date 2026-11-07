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
 * Code with what its strings and comments say taken out: `'Moved to history.'`
 * is `''`, and a template's `${…}` stays, as the code it is. For a handler
 * written in quotes, where a word decides where the handler runs, not only
 * whether a page is given a document: `status = 'See history.'` is SoftN's to
 * run, as it was before parser 15, and `alert('Saved')` is still the browser's.
 */
export function codeWithoutText(code: string): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i);
      i = end < 0 ? code.length : end;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end < 0 ? code.length : end + 2;
      out += ' ';
      continue;
    }
    // A regular expression (`/'/.test(s)`) is passed over as it is written, so a quote in it starts no string
    // that would hide the code after it. A `/` after a value (`total / 2`) divides. (Only the end of what is
    // read so far is looked at: the whole of it, at every `/`, took seconds over a long handler.)
    if (c === '/' && /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|in|of))\s*$/.test(out.slice(-24))) {
      let j = i + 1;
      let inClass = false;
      while (j < code.length && code[j] !== '\n' && (inClass || code[j] !== '/')) {
        if (code[j] === '\\') j++;
        else if (code[j] === '[') inClass = true;
        else if (code[j] === ']') inClass = false;
        j++;
      }
      out += code.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < code.length && code[j] !== c && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1;
      // A quote never closed (`it's`, written in code) starts no string: what follows it stays code.
      if (j >= code.length || code[j] !== c) {
        out += c;
        i++;
        continue;
      }
      // Code given as text, `setTimeout('history.back()', 500)` or `eval('…')`, is code, and stays.
      out += /\b(?:setTimeout|setInterval|eval|Function)\s*\(\s*$/.test(out.slice(-24)) ? code.slice(i, j + 1) : c + c;
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      out += '`';
      while (j < code.length && code[j] !== '`') {
        if (code[j] === '\\') {
          j += 2;
        } else if (code[j] === '$' && code[j + 1] === '{') {
          let depth = 1;
          let k = j + 2;
          while (k < code.length && depth > 0) {
            if (code[k] === '{') depth++;
            else if (code[k] === '}') depth--;
            k++;
          }
          out += ' ' + codeWithoutText(code.slice(j + 2, depth === 0 ? k - 1 : k)) + ' ';
          j = k;
        } else {
          j++;
        }
      }
      out += '`';
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
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
