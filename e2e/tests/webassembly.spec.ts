/**
 * WebAssembly in an app, in a real browser: the repository's example
 * (examples/webassembly/WebAssembly.softn) opened as a file.
 *
 * Its game is a `<WasmApp>`: a program in a `blob:` worker the runtime makes
 * from its own source, drawing frames of pixels, hearing the pointer and
 * posting to the app's logic, which shows what it posts and calls it back by
 * the handle `@ready` gave. The same logic calls a library's functions with
 * softn.wasm.call and runs a WASI command with softn.wasm.run. Nothing is
 * mocked: the modules are the example's own, compiled from Rust.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { watchConsole } from '../helpers/console';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = readFileSync(path.resolve(here, '../../examples/webassembly/WebAssembly.softn'));

/** Open `buffer` through the workspace's "Open a .softn file" button. */
async function openBundle(page: Page, name: string, buffer: Buffer): Promise<void> {
  await page.goto('/web/');
  await expect(page.getByRole('heading', { name: 'Your app workspace', exact: true })).toBeVisible({ timeout: 60_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open a .softn file', exact: true }).click();
  await (await chooser).setFiles({ name, mimeType: 'application/octet-stream', buffer });
}

test('a WebAssembly game plays in the app, its logic calls a library and runs a command', async ({ page }, testInfo) => {
  const log = watchConsole(page, testInfo);
  try {
    await openBundle(page, 'WebAssembly.softn', EXAMPLE);
    const screen = page.locator('[data-softn-wasm-app]');
    await expect(screen).toBeVisible({ timeout: 60_000 });
    // The program has drawn: the canvas it was handed has the size of its frames.
    await expect
      .poll(() => page.evaluate(() => {
        const canvas = document.querySelector('[data-softn-wasm-app] canvas') as HTMLCanvasElement | null;
        return canvas ? `${canvas.width}x${canvas.height}` : '';
      }), { timeout: 30_000 })
      .toBe('240x180');

    // A press on the game launches the ball; the game posts it and the logic says so.
    // Near the bottom edge: below the frame itself when it is shown at a whole
    // multiple, where a press is still the program's.
    const box = await screen.boundingBox();
    expect(box).not.toBeNull();
    await screen.click({ position: { x: box!.width / 2, y: box!.height * 0.97 } });
    await expect(page.getByText('Keep the ball up with the arrow keys or the pointer.', { exact: true })).toBeVisible();
    // The logic calls the running game by its handle.
    await page.getByRole('button', { name: 'New game', exact: true }).click();
    await expect(page.getByText('Press Space, or click the game, to launch the ball.', { exact: true })).toBeVisible();

    // A library: a JSON answer, then a long computation.
    await page.getByRole('button', { name: 'Summarise', exact: true }).click();
    await expect(page.getByText('12.938', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Count the primes below five million', exact: true }).click();
    await expect(page.getByText(/^348513 primes below five million, counted in \d+ ms$/)).toBeVisible({ timeout: 30_000 });

    // A WASI command: stdin in, stdout and a file out.
    await page.getByRole('button', { name: 'Count the words', exact: true }).click();
    await expect(page.getByText("43 words, 33 different. It wrote every word's count to report.csv, 33 lines.", { exact: true })).toBeVisible({ timeout: 30_000 });

    expect(log.uncaught).toEqual([]);
  } finally {
    await log.attach('webassembly');
  }
});
