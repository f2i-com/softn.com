/**
 * React and Vue in a web container, in a browser.
 *
 * The apps are the container's own test apps (packages/@softn/container/test/frameworks):
 * the same page written in React and in Vue, built here by Vite with each framework's plugin
 * and no setting of ours, and opened as the dist/ folder Vite wrote, zipped. The unit suite
 * runs them in jsdom, where the app's script shares the page's thread, events are made by
 * hand and nothing is laid out. Here the script is in a Worker, a thread away from the page
 * the person is typing into, and what is done to the page is done by a mouse and keys:
 *
 *   - a field the framework controls keeps every key typed into it, at a typist's speed and
 *     faster than the Worker answers;
 *   - a checkbox ticks on a real click (the page ticks it before the app hears of it);
 *   - Enter in a form's field sends the form to the app, and the page goes nowhere;
 *   - the pointer moving over an element and off it, the focus arriving and leaving;
 *   - a drawing the framework made is drawn (it has a size), an image Vite wrote into the
 *     script as a `data:` address loads, the stylesheet the page links to applies;
 *   - a part of the app fetched on demand arrives with its own stylesheet applied, a class
 *     set on `<html>` restyles the app, and a box the script scrolls is scrolled, while the
 *     window the app is drawn in stays where it was.
 */
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFrameworkApps, readFolder } from '../../packages/@softn/container/test/frameworks/build.mjs';
import { containerBundle } from '../helpers/bundle';
import { watchConsole } from '../helpers/console';
import { centreOf, clickIn, keepShadowRoots, openBundle, seeIn, textIn } from '../helpers/container';

const SVG_NS = 'http://www.w3.org/2000/svg';

let built = '';

test.beforeAll(() => {
  built = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-e2e-frameworks-'));
  buildFrameworkApps(built);
});

test.afterAll(() => {
  if (built) fs.rmSync(built, { recursive: true, force: true });
});

const shows = (page: Page, selector: string, expected: string, timeout = 15_000) => expect.poll(() => textIn(page, selector), { timeout, message: `${selector} shows "${expected}"` }).toBe(expected);

const rows = (page: Page): Promise<string> =>
  page.evaluate(() =>
    ((window as unknown as { __softnRoots?: ShadowRoot[] }).__softnRoots ?? [])
      .flatMap((root) => [...root.querySelectorAll('#list .row .text')])
      .map((el) => el.textContent)
      .join(',')
  );

/** Choose a select's option as the page's own control does: its value, then the events a choice makes. */
const choose = (page: Page, selector: string, value: string): Promise<void> =>
  page.evaluate(
    ([sel, to]) => {
      for (const root of (window as unknown as { __softnRoots?: ShadowRoot[] }).__softnRoots ?? []) {
        const select = root.querySelector(sel) as HTMLSelectElement | null;
        if (!select) continue;
        select.value = to;
        select.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        select.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      }
    },
    [selector, value] as const
  );

for (const framework of ['react', 'vue'] as const) {
  test(`a ${framework === 'react' ? 'React' : 'Vue'} app built by Vite runs from its dist folder: clicks, keys, a form, the pointer and the focus all reach it`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const log = watchConsole(page, testInfo);
    await keepShadowRoots(page);
    const engines: string[] = [];
    page.on('requestfinished', (request) => {
      const name = new URL(request.url()).pathname;
      if (/\.wasm$/.test(name)) engines.push(name.slice(name.lastIndexOf('/') + 1));
    });
    try {
      await openBundle(page, `${framework}-dist.softn`, containerBundle(readFolder(path.join(built, framework))));
      await shows(page, '#count', 'Count: 0', 60_000);
      // On the smallest engine: a framework needs nothing the lite engine lacks.
      expect([...new Set(engines)]).toEqual(['zipp-javascript-lite.wasm']);

      // The first page, laid out: the stylesheet the page links to, a drawing, two images.
      expect((await seeIn(page, '.static'))?.count).toBe(25);
      await shows(page, '#data', 'hello from data.json');
      await shows(page, '#measured', 'yes');
      await expect.poll(async () => (await seeIn(page, '#count'))?.fontWeight).toBe('700');
      const circle = await seeIn(page, '#icon circle');
      expect(circle?.namespace).toBe(SVG_NS);
      expect(circle?.width).toBeGreaterThan(0);
      await expect.poll(async () => (await seeIn(page, '#mark'))?.loaded, { message: 'the image Vite wrote into the script loads' }).toBe(true);
      await expect.poll(async () => (await seeIn(page, '#logo'))?.loaded, { message: 'the image from public/ loads' }).toBe(true);

      // Real clicks.
      await clickIn(page, '#inc');
      await shows(page, '#count', 'Count: 1');
      await clickIn(page, '#inc');
      await shows(page, '#count', 'Count: 2');

      // Keys into a field the framework controls, at a typist's speed and then all at once.
      await clickIn(page, '#note');
      await page.keyboard.type('hello', { delay: 40 });
      await shows(page, '#echo', 'HELLO');
      await page.keyboard.type(' quick brown fox');
      await shows(page, '#echo', 'HELLO QUICK BROWN FOX');
      expect((await seeIn(page, '#note'))?.value).toBe('hello quick brown fox');
      // In the middle of what is there, where a field written back to would lose its place.
      for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
      await page.keyboard.type('red ');
      await shows(page, '#echo', 'HELLO QUICK BROWN RED FOX');
      expect((await seeIn(page, '#note'))?.value).toBe('hello quick brown red fox');

      // A checkbox: ticked, unticked, ticked.
      await clickIn(page, '#agree');
      await shows(page, '#agreed', 'yes');
      expect((await seeIn(page, '#agree'))?.checked).toBe(true);
      await expect.poll(async () => (await seeIn(page, '.app'))?.className).toBe('app agreed');
      await clickIn(page, '#agree');
      await shows(page, '#agreed', 'no');
      expect((await seeIn(page, '#agree'))?.checked).toBe(false);
      await clickIn(page, '#agree');
      await shows(page, '#agreed', 'yes');

      // A select shows the app's own choice from the start, and follows the person's.
      expect((await seeIn(page, '#size'))?.value).toBe('m');
      await choose(page, '#size', 'l');
      await shows(page, '#chosen', 'l');
      await clickIn(page, '#kind-b');
      await shows(page, '#kind', 'b');
      expect((await seeIn(page, '#kind-a'))?.checked).toBe(false);
      await clickIn(page, '#notes');
      await page.keyboard.type('line one');
      await page.keyboard.press('Enter');
      await page.keyboard.type('line two');
      await shows(page, '#length', '17');

      // Enter in a form's field sends the form to the app; the page goes nowhere.
      const address = page.url();
      await clickIn(page, '#new');
      await page.keyboard.type('third');
      await page.keyboard.press('Enter');
      await expect.poll(() => rows(page)).toBe('first,second,third');
      await expect.poll(async () => (await seeIn(page, '#new'))?.value).toBe('');
      await page.keyboard.type('fourth');
      await clickIn(page, '#push');
      await expect.poll(() => rows(page)).toBe('first,second,third,fourth');
      expect(page.url()).toBe(address);
      await clickIn(page, '#reverse');
      await expect.poll(() => rows(page)).toBe('fourth,third,second,first');
      await clickIn(page, '#list .row .remove');
      await expect.poll(() => rows(page)).toBe('third,second,first');

      // A portal or a teleport, and a part of the app fetched when asked for.
      await clickIn(page, '#open');
      await expect.poll(async () => (await seeIn(page, '#modal'))?.attrs.role).toBe('dialog');
      await clickIn(page, '#close');
      await expect.poll(() => seeIn(page, '#modal')).toBeNull();
      // The part fetched on demand has a stylesheet of its own, which Vite links from
      // document.head and waits for: it is in before the part is drawn, and it applies.
      await clickIn(page, '#lazy-load');
      await shows(page, '#lazy', 'Lazy loaded');
      expect((await seeIn(page, '#lazy'))?.letterSpacing).toBe('3px');

      // A class the script sets on <html> is where the app's stylesheet looks for it.
      expect((await seeIn(page, '#count'))?.color).not.toBe('rgb(200, 200, 0)');
      await clickIn(page, '#dark');
      await expect.poll(async () => (await seeIn(page, '#count'))?.color).toBe('rgb(200, 200, 0)');
      await clickIn(page, '#dark');
      await expect.poll(async () => (await seeIn(page, '#count'))?.color).not.toBe('rgb(200, 200, 0)');

      // A box of the app's scrolled by its script: to the end, then back to a line by name.
      // Neither moves the page the app is drawn in.
      const windowAt = await page.evaluate(() => window.scrollY);
      expect((await seeIn(page, '#scroller'))?.scrollTop).toBe(0);
      await clickIn(page, '#to-end');
      await expect.poll(async () => (await seeIn(page, '#scroller'))?.scrollTop ?? 0).toBeGreaterThan(200);
      await clickIn(page, '#to-line');
      await expect
        .poll(async () => {
          const box = await seeIn(page, '#scroller');
          const line = await seeIn(page, '#line-3');
          return box && line ? line.top >= box.top - 1 && line.top + line.height <= box.top + box.height + 1 : false;
        }, { message: 'line 3 is in view inside its box' })
        .toBe(true);
      expect(await page.evaluate(() => window.scrollY)).toBe(windowAt);

      // The pointer over an element and off it; the focus on a field and off it.
      const hover = await centreOf(page, '#hover');
      await page.mouse.move(hover.x, hover.y, { steps: 4 });
      await shows(page, '#hovered', 'yes');
      const away = await centreOf(page, '#count');
      await page.mouse.move(away.x, away.y, { steps: 4 });
      await shows(page, '#hovered', 'no');
      // What the app puts where the pointer was (a menu, a tooltip: position fixed, at the
      // click's own coordinates) is drawn under the pointer. The app's box is not at the
      // window's corner here (the runtime's bar is above it), and the click was told from
      // the window's corner: the marker was drawn as far off as the box is.
      const pad = await centreOf(page, '#pad');
      await page.mouse.click(pad.x, pad.y);
      await expect.poll(async () => (await seeIn(page, '#marker')) !== null).toBe(true);
      const marker = (await seeIn(page, '#marker'))!;
      expect(Math.abs(marker.left - pad.x), `marker at ${marker.left}, pointer at ${pad.x}`).toBeLessThanOrEqual(1);
      expect(Math.abs(marker.top - pad.y), `marker at ${marker.top}, pointer at ${pad.y}`).toBeLessThanOrEqual(1);
      const frame = await seeIn(page, '[data-softn-docroot]');
      expect(frame!.top, 'the app is below the runtime’s bar, so the two corners differ').toBeGreaterThan(0);
      // And it stays there while the page under it scrolls, as what is fixed in place does.
      // (The app's box was also what scrolled, and everything fixed went with the page.)
      const scroller = (await seeIn(page, '[data-softn-docroot]'))!;
      expect(scroller.scrollHeight, 'the page is taller than its box, so there is somewhere to scroll to').toBeGreaterThan(scroller.clientHeight + 150);
      const padBefore = (await seeIn(page, '#pad'))!.top;
      // The wheel over the page, beside the marker (a wheel over what is fixed is not the page's).
      await page.mouse.move(pad.x + 60, pad.y);
      await page.mouse.wheel(0, scroller.scrollTop > 100 ? -80 : 80);
      await expect.poll(async () => Math.abs((await seeIn(page, '#pad'))!.top - padBefore), { message: 'the page scrolled under the pointer' }).toBeGreaterThan(20);
      expect(Math.abs((await seeIn(page, '#marker'))!.top - marker.top), 'the marker did not move with the page').toBeLessThanOrEqual(1);

      await clickIn(page, '#focus-me');
      await shows(page, '#focused', 'yes');
      expect((await seeIn(page, '#focus-me'))?.focused).toBe(true);
      await page.keyboard.press('Tab');
      await shows(page, '#focused', 'no');
      // The field focused by the script, through the ref the framework keeps it in.
      await clickIn(page, '#focus-by-ref');
      await shows(page, '#focused', 'yes');
      expect((await seeIn(page, '#focus-me'))?.focused).toBe(true);

      // The app's own address, moved by the app.
      await clickIn(page, '#go');
      await shows(page, '#path', '/about');
      expect(page.url()).toBe(address);
      // A router's links: the click is the script's, and the page follows neither. "/" is the
      // app's own page: followed, the app would start again and lose its count.
      await clickIn(page, '#team-link');
      await shows(page, '#path', '/team');
      await clickIn(page, '#home-link');
      await shows(page, '#path', '/');
      expect(await textIn(page, '#count')).toBe('Count: 2');
      expect(page.url()).toBe(address);

      if (framework === 'vue') {
        // A transition waits for the page's own transitionend before the element goes.
        await clickIn(page, '#toggle');
        await expect.poll(() => seeIn(page, '#fade')).toBeNull();
        await clickIn(page, '#toggle');
        await shows(page, '#fade', 'fading');
        expect((await seeIn(page, '#shown-when-agreed'))?.display).not.toBe('none');
      }

      // A component that throws is caught by the app, and the rest of it goes on.
      await clickIn(page, '#boom');
      await shows(page, '#caught', 'Caught: boom');
      await clickIn(page, '#inc');
      await shows(page, '#count', 'Count: 3');
      expect(log.uncaught).toEqual([]);
    } finally {
      await log.attach(`${framework}-dist`);
    }
  });
}
