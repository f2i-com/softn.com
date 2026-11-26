/**
 * Round 4: what the app's script showed before the person allowed it the network.
 *
 * The app runs while the consent bar asks (the bar does not block it), so its first screen is
 * drawn before the person says yes. A picture, a background or a stylesheet's address on a
 * site the app declared was refused then, as it must be, and stayed refused after the yes:
 * nothing set it again, and a framework that draws only what changed never did. A frame the
 * app asked for before the yes is shown at it (updatePermissions); these now are too.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ContainerArchive } from '../src/archive';
import { HostDomPatcher } from '../src/dom-patcher';
import type { ContainerPermissions, ShellOp } from '../src/types';

const PERMISSIONS: ContainerPermissions = { permissions: { net: { enabled: true, allowed_hosts: ['cdn.example.com'] } } } as ContainerPermissions;

async function patcher() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const page = host.attachShadow({ mode: 'open' });
  const docRootEl = document.createElement('div');
  const headEl = document.createElement('div');
  const viewportEl = document.createElement('div');
  docRootEl.append(headEl, viewportEl);
  page.appendChild(docRootEl);
  const archive = await ContainerArchive.open({ 'index.html': '<!doctype html><p>x</p>' });
  const heard: Array<[number, string]> = [];
  const made = new HostDomPatcher({
    viewportEl,
    docRootEl,
    headEl,
    archive,
    entryPath: 'index.html',
    permissions: PERMISSIONS,
    netGranted: false,
    callbacks: { onEvent: (id, type) => heard.push([id, type]), onSync: () => undefined },
  });
  made.nodes.set(0, docRootEl);
  made.nodes.set(1, viewportEl);
  return { made, viewportEl, archive, heard };
}

describe('what the app showed before it was allowed the network (round 4)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('is set again, by the same rule, once the person allows the network', async () => {
    const { made, viewportEl, archive, heard } = await patcher();
    made.applyOps([
      ['e', 10, 'img', { id: 'logo', src: 'https://cdn.example.com/logo.png', alt: 'Logo' }],
      ['e', 11, 'div', { id: 'hero', style: 'background-image: url(https://cdn.example.com/hero.jpg); color: red' }],
      ['e', 12, 'img', { id: 'other', src: 'https://elsewhere.example/x.png' }],
      ['e', 13, 'style', {}],
      ['x', 14, '.card { background: url(https://cdn.example.com/card.png) }'],
      ['c', 13, [14]],
      ['e', 15, 'img', { id: 'later' }],
      ['c', 1, [10, 11, 12, 13, 15]],
    ] as ShellOp[]);
    const logo = viewportEl.querySelector('#logo') as HTMLImageElement;
    const hero = viewportEl.querySelector('#hero') as HTMLElement;
    const other = viewportEl.querySelector('#other') as HTMLImageElement;
    const sheet = viewportEl.querySelector('style')!;
    // Before the yes: refused.
    expect(logo.hasAttribute('src')).toBe(false);
    expect(hero.getAttribute('style') ?? '').not.toContain('cdn.example.com');
    expect(sheet.textContent).not.toContain('cdn.example.com');
    // An address the app then took back is not set at the yes.
    made.applyOps([['a', 15, 'src', 'https://cdn.example.com/gone.png'], ['a', 15, 'src', null]] as ShellOp[]);
    heard.length = 0;

    made.updatePermissions(PERMISSIONS, true);
    expect(logo.getAttribute('src')).toBe('https://cdn.example.com/logo.png');
    expect(hero.getAttribute('style')).toContain('https://cdn.example.com/hero.jpg');
    expect(hero.getAttribute('style')).toContain('red');
    expect(sheet.textContent).toContain('https://cdn.example.com/card.png');
    // A site the app did not declare, still not.
    expect(other.hasAttribute('src')).toBe(false);
    expect((viewportEl.querySelector('#later') as HTMLImageElement).hasAttribute('src')).toBe(false);
    // Nothing is told to the app's script for it.
    made.applyOps([['x', 20, 'tick']] as ShellOp[]);
    expect(heard).toEqual([]);
    made.dispose();
    archive.dispose();
  });
});
