/**
 * A web container (@softn/container) in the built runtime, as a spec reaches it.
 *
 * The container draws into a closed shadow root, which nothing on the page can reach and no
 * locator can see into. A spec keeps each root as it is attached, reads the page through
 * it, and acts on it as a person does: a real click at an element's place, real keys.
 */
import { expect, type Page } from '@playwright/test';

type WithRoots = { __softnRoots?: ShadowRoot[] };

/** Keep each shadow root as it is attached, before any of the page's own scripts run. */
export async function keepShadowRoots(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const attach = Element.prototype.attachShadow;
    const roots: ShadowRoot[] = [];
    (window as unknown as { __softnRoots: ShadowRoot[] }).__softnRoots = roots;
    Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit): ShadowRoot {
      const root = attach.call(this, init);
      roots.push(root);
      return root;
    };
  });
}

/** What the containers on the page show, as text. */
export const shown = (page: Page): Promise<string> =>
  page.evaluate(() =>
    ((window as unknown as { __softnRoots?: ShadowRoot[] }).__softnRoots ?? [])
      .map((root) => root.querySelector('[data-softn-viewport]')?.textContent ?? '')
      .join('\n')
  );

/** The middle of an element inside a container, for a real click on it. */
export async function centreOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.evaluate((sel) => {
    for (const root of (window as unknown as { __softnRoots?: ShadowRoot[] }).__softnRoots ?? []) {
      const el = root.querySelector(sel);
      if (el?.isConnected) {
        // Where a person would have to scroll to it first, so does this.
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        let x = r.left + r.width / 2;
        let y = r.top + r.height / 2;
        // Builder portals the app into a scaled device iframe. Mouse input
        // uses top-level viewport coordinates, including that frame's scale.
        let frame = el.ownerDocument.defaultView?.frameElement as HTMLIFrameElement | null;
        while (frame) {
          const bounds = frame.getBoundingClientRect();
          x = bounds.left + (frame.clientLeft + x) * bounds.width / frame.offsetWidth;
          y = bounds.top + (frame.clientTop + y) * bounds.height / frame.offsetHeight;
          frame = frame.ownerDocument.defaultView?.frameElement as HTMLIFrameElement | null;
        }
        return { x, y };
      }
    }
    return null;
  }, selector);
  expect(box, `${selector} is drawn in the container`).not.toBeNull();
  return box!;
}

/** A real click in the middle of an element inside a container. */
export async function clickIn(page: Page, selector: string): Promise<void> {
  const at = await centreOf(page, selector);
  await page.mouse.click(at.x, at.y);
}

/** An element inside a container, as the page shows it. */
export interface Seen {
  text: string;
  /** A field's value, a select's chosen value; '' for anything else. */
  value: string;
  checked: boolean;
  focused: boolean;
  namespace: string | null;
  className: string;
  /** Its attributes, by name. */
  attrs: Record<string, string>;
  /** How many elements in the containers match the selector. */
  count: number;
  /** Its box on the page. */
  width: number;
  height: number;
  /** An image that has loaded and has a picture in it. */
  loaded: boolean;
  /** As the page's stylesheets leave it. */
  fontWeight: string;
  display: string;
  letterSpacing: string;
  color: string;
  opacity: string;
  /** How far it has been scrolled, how tall what it holds is, and how much of that shows. */
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** Where its top and its left edge are, from the window's corner. */
  top: number;
  left: number;
}

/**
 * The first element in a container that matches `selector`, as the page shows it; null when
 * nothing matches. For what text alone does not say: a field's value, a box's tick, an
 * element's namespace, whether it has the focus.
 */
export function seeIn(page: Page, selector: string): Promise<Seen | null> {
  return page.evaluate((sel) => {
    let first: Element | null = null;
    let count = 0;
    let focused = false;
    for (const root of (window as unknown as WithRoots).__softnRoots ?? []) {
      if (!root.host.isConnected) continue;
      const all = root.querySelectorAll(sel);
      count += all.length;
      if (!first && all.length > 0) {
        first = all[0];
        focused = root.activeElement === first;
      }
    }
    if (!first) return null;
    const field = first as HTMLInputElement;
    const image = first as HTMLImageElement;
    const box = first.getBoundingClientRect();
    const style = getComputedStyle(first);
    return {
      loaded: image.complete === true && image.naturalWidth > 0,
      fontWeight: style.fontWeight,
      display: style.display,
      letterSpacing: style.letterSpacing,
      color: style.color,
      opacity: style.opacity,
      scrollTop: first.scrollTop,
      scrollHeight: first.scrollHeight,
      clientHeight: first.clientHeight,
      top: box.top,
      left: box.left,
      text: first.textContent ?? '',
      value: typeof field.value === 'string' ? field.value : '',
      checked: field.checked === true,
      focused,
      namespace: first.namespaceURI,
      className: first.getAttribute('class') ?? '',
      attrs: Object.fromEntries([...first.attributes].map((attr) => [attr.name, attr.value])),
      count,
      width: box.width,
      height: box.height,
    };
  }, selector);
}

/** The text of the first element in a container that matches `selector`; null when nothing matches. */
export const textIn = async (page: Page, selector: string): Promise<string | null> => (await seeIn(page, selector))?.text ?? null;

/** Open `buffer` through the workspace's "Open file" button. */
export async function openBundle(page: Page, name: string, buffer: Buffer): Promise<void> {
  await page.goto('/web/');
  await expect(page.getByRole('heading', { name: 'Your app workspace', exact: true })).toBeVisible({ timeout: 60_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open file', exact: true }).click();
  await (await chooser).setFiles({ name, mimeType: 'application/octet-stream', buffer });
}
