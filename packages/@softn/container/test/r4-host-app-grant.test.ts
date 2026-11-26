/**
 * The page's own stylesheets and the person's yes to the network: a picture or a font of a site
 * the app declared, in the page's own CSS, is shown once the person allows the network.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mountSoftNContainer, type SoftNContainerHandle } from '../src/index';

let handle: SoftNContainerHandle | null = null;

afterEach(() => {
  handle?.dispose();
  handle = null;
  document.body.innerHTML = '';
});

describe("the page's own stylesheets", () => {
  it("are read again with the network once the person allows it, so the declared site's pictures show", async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      persistStorage: false,
      permissionMode: 'deny',
      source: {
        'permission.json': JSON.stringify({ permissions: { net: { enabled: true, allowed_hosts: ['cdn.example.com'] } } }),
        'index.html': `<!doctype html><html><head><style>
          #hero { background-image: url(https://cdn.example.com/hero.png); height: 40px; }
          #other { background-image: url(https://elsewhere.example.org/x.png); }
        </style></head><body><div id="hero"></div><div id="other"></div></body></html>`,
      },
    });
    const pageCss = () => Array.from(handle!.shadowRoot.querySelectorAll('style'), (s) => s.textContent ?? '').join('\n');
    // Before the yes, nothing of the site is asked for.
    expect(pageCss()).not.toContain('cdn.example.com');
    handle.setGrantedCapabilities(['net']);
    expect(pageCss()).toContain('https://cdn.example.com/hero.png');
    // A site the app did not declare stays out.
    expect(pageCss()).not.toContain('elsewhere.example.org');
  });
});
