/**
 * One copy of the ZIPP engine per app. The page compiles the engine it loads,
 * the app's one hashed asset, and posts the module to every worker it starts;
 * no worker fetches an engine of its own, and the deployment carries none
 * under assets/core-runtime/ for it to fetch. The local-model spec covers the
 * model worker; this covers the other two: the script worker, which runs an
 * app whose manifest asks for `execution: "worker"`, and the sandbox worker
 * behind `softn.sandbox.run`.
 */
import { expect, test, type Page } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import { watchConsole } from '../helpers/console';

const UI = `<logic src="../logic/main.logic" />

<App title="One Engine">
  <Stack direction="vertical" gap="md" padding="xl">
    <Heading level={1}>One Engine</Heading>
    <Text>Count: {count}</Text>
    <Text>Sandbox: {sandbox}</Text>
    <Button variant="primary" @click={() => bump()}>Bump</Button>
    <Button variant="secondary" @click={() => guest()}>Ask the sandbox</Button>
  </Stack>
</App>
`;

const LOGIC = `let count = 0
let sandbox = "idle"

function bump() {
  count = count + 1
}

function guest() {
  softn.sandbox.run("function update(input) { return input.n * 6 }", { n: 7 }, function(r) {
    sandbox = r && r.error ? "failed: " + r.error : "answered " + r.value
  })
}
`;

function bundle(): Buffer {
  const manifest = {
    id: 'softn-e2e-one-engine',
    name: 'One Engine',
    version: '1.0.0',
    description: 'Built by the e2e gate.',
    main: 'ui/main.ui',
    files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'], xdb: [] },
    config: { execution: 'worker' },
  };
  return Buffer.from(zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'permission.json': strToU8(JSON.stringify({ permissions: {} })),
    'ui/main.ui': strToU8(UI),
    'logic/main.logic': strToU8(LOGIC),
  }, { level: 6, mtime: new Date('2026-10-20T00:00:00.000Z') }));
}

async function openBundle(page: Page): Promise<void> {
  await page.goto('/web/');
  await expect(page.getByRole('heading', { name: 'Your app workspace', exact: true })).toBeVisible({ timeout: 60_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open a .softn file', exact: true }).click();
  await (await chooser).setFiles({ name: 'OneEngine.softn', mimeType: 'application/octet-stream', buffer: bundle() });
  await expect(page.getByRole('heading', { name: 'One Engine', exact: true })).toBeVisible({ timeout: 60_000 });
}

test('the script and sandbox workers run on the page’s engine, and no worker fetches one', async ({ page, context }, testInfo) => {
  const log = watchConsole(page, testInfo);
  const engines: string[] = [];
  context.on('request', (request) => {
    if (/zipp_wasm_bg[^/]*\.wasm(\?|$)/.test(request.url())) engines.push(new URL(request.url()).pathname);
  });
  try {
    await openBundle(page);
    // A worker that cannot start would leave the click unanswered.
    await page.getByRole('button', { name: 'Bump', exact: true }).click();
    await page.getByRole('button', { name: 'Bump', exact: true }).click();
    await expect(page.getByText('Count: 2', { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Ask the sandbox', exact: true }).click();
    await expect(page.getByText('Sandbox: answered 42', { exact: true })).toBeVisible({ timeout: 30_000 });
    expect(engines.filter((pathname) => pathname.includes('/core-runtime/'))).toEqual([]);
    expect(new Set(engines).size).toBeLessThanOrEqual(1);
    expect(log.uncaught).toEqual([]);
  } finally {
    await log.attach('one-engine');
  }
});
