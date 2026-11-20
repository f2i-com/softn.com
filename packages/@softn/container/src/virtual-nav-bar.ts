/**
 * Isolated Virtual Folder & Script Navigation Bar for `<softn-app virtual-nav>`.
 *
 * Rendered inside the container's trusted `frameRoot` (in its own closed shadow root),
 * completely out of reach of guest app CSS and JavaScript. Lets users navigate virtual
 * URLs, browse virtual folders inside a loaded `.zip` / `.softn` archive, and jump
 * directly to `.php` / `.html` scripts or rewritten routes.
 */

import type { VirtualDirEntry } from './types';

export interface VirtualNavBarController {
  readonly element: HTMLElement;
  setPath(urlPath: string): void;
  setHistoryState(canBack: boolean, canForward: boolean): void;
}

export function renderVirtualNavBar(options: {
  appName: string;
  initialPath: string;
  listDirectory: (dir: string) => VirtualDirEntry[];
  onNavigate: (urlPath: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
}): VirtualNavBarController {
  const root = document.createElement('div');
  const style = document.createElement('style');
  style.textContent = `
    :host, .vnav { font-family: system-ui, -apple-system, sans-serif; font-size: 13px; color: #e5e7eb; background: #111827; border-bottom: 1px solid #1f2937; }
    .vnav-row { display: flex; align-items: center; gap: 6px; padding: 6px 10px; }
    .vnav-btn { background: #1f2937; color: #e5e7eb; border: 1px solid #374151; border-radius: 5px; padding: 3px 8px; cursor: pointer; font-size: 12px; line-height: 1.4; }
    .vnav-btn:hover:not(:disabled) { background: #374151; }
    .vnav-btn:disabled { opacity: 0.4; cursor: default; }
    .vnav-btn.active { background: #2563eb; border-color: #3b82f6; color: #fff; }
    .vnav-url-form { flex: 1; display: flex; align-items: center; gap: 4px; }
    .vnav-origin { color: #9ca3af; font-family: ui-monospace, monospace; font-size: 12px; user-select: none; }
    .vnav-input { flex: 1; background: #0b1120; color: #f9fafb; border: 1px solid #374151; border-radius: 5px; padding: 4px 8px; font-family: ui-monospace, monospace; font-size: 12px; outline: none; }
    .vnav-input:focus { border-color: #3b82f6; }
    .vnav-drawer { border-top: 1px solid #1f2937; background: #0b1120; padding: 8px 10px; max-height: 220px; overflow-y: auto; }
    .vnav-drawer[hidden] { display: none; }
    .vnav-crumbs { display: flex; align-items: center; gap: 4px; margin-bottom: 6px; font-size: 12px; color: #9ca3af; flex-wrap: wrap; }
    .vnav-crumb { background: none; border: none; color: #60a5fa; cursor: pointer; padding: 0 2px; font-size: 12px; }
    .vnav-crumb:hover { text-decoration: underline; }
    .vnav-grid { display: flex; flex-wrap: wrap; gap: 6px; }
    .vnav-item { display: inline-flex; align-items: center; gap: 5px; padding: 4px 8px; border-radius: 5px; background: #1f2937; border: 1px solid #374151; color: #f3f4f6; cursor: pointer; font-family: ui-monospace, monospace; font-size: 12px; }
    .vnav-item:hover { background: #374151; border-color: #60a5fa; }
    .vnav-item.file-dim { opacity: 0.65; }
  `;
  root.className = 'vnav';
  root.appendChild(style);

  const row = document.createElement('div');
  row.className = 'vnav-row';

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'vnav-btn';
  backBtn.textContent = '\u2190';
  backBtn.title = 'Back';
  backBtn.disabled = true;
  backBtn.addEventListener('click', () => options.onBack());

  const fwdBtn = document.createElement('button');
  fwdBtn.type = 'button';
  fwdBtn.className = 'vnav-btn';
  fwdBtn.textContent = '\u2192';
  fwdBtn.title = 'Forward';
  fwdBtn.disabled = true;
  fwdBtn.addEventListener('click', () => options.onForward());

  const reloadBtn = document.createElement('button');
  reloadBtn.type = 'button';
  reloadBtn.className = 'vnav-btn';
  reloadBtn.textContent = '\u21BB';
  reloadBtn.title = 'Reload';
  reloadBtn.addEventListener('click', () => options.onReload());

  const form = document.createElement('form');
  form.className = 'vnav-url-form';
  const originSpan = document.createElement('span');
  originSpan.className = 'vnav-origin';
  originSpan.textContent = 'softn://';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'vnav-input';
  input.setAttribute('aria-label', `${options.appName} virtual path`);
  input.value = options.initialPath;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const next = input.value.trim() || '/';
    options.onNavigate(next.startsWith('/') ? next : `/${next}`);
  });
  form.append(originSpan, input);

  const folderBtn = document.createElement('button');
  folderBtn.type = 'button';
  folderBtn.className = 'vnav-btn';
  folderBtn.textContent = 'Folders';
  folderBtn.title = 'Browse virtual folders & scripts in this app';

  row.append(backBtn, fwdBtn, reloadBtn, form, folderBtn);
  root.appendChild(row);

  const drawer = document.createElement('div');
  drawer.className = 'vnav-drawer';
  drawer.hidden = true;
  const crumbsEl = document.createElement('div');
  crumbsEl.className = 'vnav-crumbs';
  const gridEl = document.createElement('div');
  gridEl.className = 'vnav-grid';
  drawer.append(crumbsEl, gridEl);
  root.appendChild(drawer);

  let browseDir = '/';

  const renderDir = (dir: string) => {
    browseDir = dir || '/';
    crumbsEl.replaceChildren();
    gridEl.replaceChildren();

    const parts = browseDir.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    const rootCrumb = document.createElement('button');
    rootCrumb.type = 'button';
    rootCrumb.className = 'vnav-crumb';
    rootCrumb.textContent = '/';
    rootCrumb.addEventListener('click', () => renderDir('/'));
    crumbsEl.appendChild(rootCrumb);

    let acc = '';
    for (const seg of parts) {
      const sep = document.createElement('span');
      sep.textContent = '/';
      crumbsEl.appendChild(sep);
      acc = `${acc}/${seg}`;
      const target = acc;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vnav-crumb';
      btn.textContent = seg;
      btn.addEventListener('click', () => renderDir(target));
      crumbsEl.appendChild(btn);
    }

    const entries = options.listDirectory(browseDir);
    if (entries.length === 0) {
      const empty = document.createElement('span');
      empty.textContent = '(empty virtual directory)';
      empty.style.color = '#6b7280';
      gridEl.appendChild(empty);
      return;
    }

    for (const entry of entries) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = entry.kind === 'dir' || entry.navigable ? 'vnav-item' : 'vnav-item file-dim';
      item.textContent = entry.kind === 'dir' ? `[dir] ${entry.name}/` : entry.name;
      item.addEventListener('click', () => {
        if (entry.kind === 'dir') {
          renderDir(`/${entry.path}`);
        } else {
          drawer.hidden = true;
          folderBtn.classList.remove('active');
          options.onNavigate(entry.urlPath);
        }
      });
      gridEl.appendChild(item);
    }
  };

  folderBtn.addEventListener('click', () => {
    const opening = drawer.hidden;
    drawer.hidden = !opening;
    folderBtn.classList.toggle('active', opening);
    if (opening) renderDir(browseDir);
  });

  return {
    element: root,
    setPath(urlPath: string) {
      input.value = urlPath;
    },
    setHistoryState(canBack: boolean, canForward: boolean) {
      backBtn.disabled = !canBack;
      fwdBtn.disabled = !canForward;
    },
  };
}
