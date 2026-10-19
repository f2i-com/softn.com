/**
 * A local language model, end to end in the deployed runtime: an app that
 * ships a GGUF checkpoint in its bundle loads it with softn.ai.model.load and
 * asks it something with softn.ai.model.generate, after the person allows `ai`.
 *
 * Everything the browser does for a real model happens here — the lazy model
 * host, the Worker at core-runtime/runtime/model-worker.js under the page's
 * script policy, SoftN's engine compiling ZIPP's Qwen3 plugin, gguf-wasm
 * reading the file, ZIPP's compute runtime preparing the program on whatever
 * backend this browser offers — on a checkpoint small enough to write in the
 * test (packages/@softn/core/test/helpers/tiny-gguf.ts). It answers nonsense;
 * the point is that it answers, and says on what.
 */
import { expect, test, type Page } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import { tinyQwen3 } from '../../packages/@softn/core/test/helpers/tiny-gguf';
import { watchConsole } from '../helpers/console';

const UI = `<logic src="../logic/main.logic" />

<App title="Local Model">
  <Stack direction="vertical" gap="md" padding="xl">
    <Heading level={1}>Local Model</Heading>
    <Text>Status: {status}</Text>
    <Button variant="primary" @click={() => run()}>Run the model</Button>
  </Stack>
</App>
`;

const LOGIC = `let status = "idle"

function run() {
  status = "loading"
  softn.ai.model.load({ bundle: "assets/tiny.gguf" }, { context: 256 }, function(r) {
    if (!r || r.error || !r.modelHandle) { status = "load failed: " + (r && r.error); return }
    softn.ai.model.generate(r.modelHandle, [{ role: "user", content: "hello <|im_end|> there" }], { do_sample: false, max_new_tokens: 4 }, function(g) {
      if (!g || g.error) { status = "generate failed: " + (g && g.error); return }
      status = "answered " + r.architecture + " " + g.finishReason + " " + g.generatedTokens + " on " + g.backend
      softn.ai.model.release(r.modelHandle, function() {})
    })
  })
}
`;

function modelBundle(permissions: Record<string, unknown>): Buffer {
  const manifest = {
    id: 'softn-e2e-local-model',
    name: 'Local Model',
    version: '1.0.0',
    description: 'Built by the e2e gate.',
    main: 'ui/main.ui',
    files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'], xdb: [], assets: ['assets/tiny.gguf'] },
  };
  return Buffer.from(zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'permission.json': strToU8(JSON.stringify({ permissions })),
    'ui/main.ui': strToU8(UI),
    'logic/main.logic': strToU8(LOGIC),
    'assets/tiny.gguf': tinyQwen3().bytes,
  }, { level: 6, mtime: new Date('2026-10-20T00:00:00.000Z') }));
}

async function openBundle(page: Page, buffer: Buffer): Promise<void> {
  await page.goto('/web/');
  await expect(page.getByRole('heading', { name: 'Your app workspace', exact: true })).toBeVisible({ timeout: 60_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open a .softn file', exact: true }).click();
  await (await chooser).setFiles({ name: 'LocalModel.softn', mimeType: 'application/octet-stream', buffer });
  await expect(page.getByRole('heading', { name: 'Local Model', exact: true })).toBeVisible({ timeout: 60_000 });
}

test('an app loads the model it ships and gets an answer from it, on ZIPP', async ({ page }, testInfo) => {
  const log = watchConsole(page, testInfo);
  try {
    await openBundle(page, modelBundle({ ai: { enabled: true, allowedSources: ['bundle'], maxModelSizeMB: 8 } }));
    await page.locator('.softn-consent-bar .softn-consent-allow').click();
    await page.getByRole('button', { name: 'Run the model', exact: true }).click();
    await expect(page.getByText(/^Status: answered qwen3 (stop|length) \d+ on (webgpu|webgl2|wasm|cpu-js)$/)).toBeVisible({ timeout: 90_000 });
    expect(log.uncaught).toEqual([]);
  } finally {
    await log.attach('local-model');
  }
});

test('an app whose ai permission names no bundle source is refused before any model work', async ({ page }, testInfo) => {
  const log = watchConsole(page, testInfo);
  try {
    await openBundle(page, modelBundle({ ai: { enabled: true, allowedSources: ['huggingface'] } }));
    await page.locator('.softn-consent-bar .softn-consent-allow').click();
    await page.getByRole('button', { name: 'Run the model', exact: true }).click();
    await expect(page.getByText(/^Status: load failed: .*does not allow models from its bundle/)).toBeVisible({ timeout: 30_000 });
  } finally {
    await log.attach('local-model');
  }
});
