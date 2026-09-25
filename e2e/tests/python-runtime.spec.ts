/**
 * Python logic in the runtime, from a bundle opened as a file.
 *
 * The first test is the whole path an author's Python takes: the bundle's
 * logic/main.py is composed, run on the ZIPP engine's Python, its module
 * globals are mirrored as state the markup reads, and a click calls a Python
 * function whose assignment re-renders the page. The second is the manifest
 * rule for heavy packages: an app that imports torch without declaring it is
 * refused by name, with the manifest line that fixes it, before any engine
 * package is fetched — so it is fast, and needs no network.
 *
 * Both bundles are built here (helpers/bundle.ts), not fetched, so nothing
 * about the deployment's demos is assumed.
 */
import { expect, test, type Page } from '@playwright/test';
import { pythonBundle } from '../helpers/bundle';
import { watchConsole } from '../helpers/console';

const COUNTER_UI = `<logic src="../logic/main.py" />

<App theme="light" title="Python Counter">
  <Stack direction="vertical" gap="md" padding="xl">
    <Heading level={1}>Python Counter</Heading>
    <Text>Count: {count}</Text>
    <Text>Last change: {label}</Text>
    <Button variant="primary" @click={() => bump()}>Add one</Button>
  </Stack>
</App>
`;

const COUNTER_PY = `count = 0
label = "none yet"


def bump():
    global count, label
    count = count + 1
    label = "added " + str(count)
`;

/** Open `buffer` through the workspace's "Open a .softn file" button. */
async function openBundle(page: Page, name: string, buffer: Buffer): Promise<void> {
  await page.goto('/web/');
  await expect(page.getByRole('heading', { name: 'Your app workspace', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open a .softn file', exact: true }).click();
  await (await chooser).setFiles({ name, mimeType: 'application/octet-stream', buffer });
}

test('a Python app runs: its globals render as state and a click runs its function', async ({
  page,
}, testInfo) => {
  const log = watchConsole(page, testInfo);
  try {
    await openBundle(
      page,
      'PythonCounter.softn',
      pythonBundle({
        id: 'softn-e2e-python-counter',
        name: 'Python Counter',
        ui: COUNTER_UI,
        python: COUNTER_PY,
      })
    );
    await expect(page.getByRole('heading', { name: 'Python Counter', exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText('Count: 0', { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Last change: none yet', { exact: true })).toBeVisible();

    const add = page.getByRole('button', { name: 'Add one', exact: true });
    await add.click();
    await expect(page.getByText('Count: 1', { exact: true })).toBeVisible();
    await expect(page.getByText('Last change: added 1', { exact: true })).toBeVisible();
    await add.click();
    await expect(page.getByText('Count: 2', { exact: true })).toBeVisible();
    expect(log.uncaught).toEqual([]);
  } finally {
    await log.attach('python-counter');
  }
});

test('an app that imports torch without declaring it is refused with the manifest fix', async ({
  page,
}, testInfo) => {
  const log = watchConsole(page, testInfo);
  try {
    await openBundle(
      page,
      'UndeclaredTorch.softn',
      pythonBundle({
        id: 'softn-e2e-undeclared-torch',
        name: 'Undeclared Torch',
        ui: `<logic src="../logic/main.py" />\n\n<App title="Undeclared Torch">\n  <Text>Should never render: {ready}</Text>\n</App>\n`,
        python: 'import torch\n\nready = True\n',
      })
    );
    const alert = page.getByRole('alert').filter({ hasText: 'imports torch' });
    await expect(alert).toBeVisible({ timeout: 60_000 });
    await expect(alert).toContainText(
      'logic/main.py imports torch, which an app asks for in manifest.json'
    );
    await expect(alert).toContainText('"config": { "python": { "packages": ["torch"] } }');
    await expect(page.getByText(/Should never render/)).toHaveCount(0);
    expect(log.uncaught).toEqual([]);
  } finally {
    await log.attach('undeclared-torch');
  }
});
