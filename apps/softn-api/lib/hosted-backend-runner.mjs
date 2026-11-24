/**
 * SoftN Directory hosted backend runner (ZIPP WASM `safe-sandbox` ONLY).
 *
 * Invoked per-request by `apps/softn-api/lib/hosted_backend.php` when an app in `data/`
 * is configured with `hosting: "server"` or `hosting: "hybrid"`.
 *
 * Security invariant:
 * - ALL app backend code (`php`, `javascript`, `typescript`, `python`, `rust`) runs
 *   strictly inside ZIPP WebAssembly `safe-sandbox` engines via `container-backend.mjs`.
 * - NEVER invokes native OS PHP, Python, or shell commands for app code.
 * - Databases persist in multi-user WAL SQLite under `data/apps/<slug>/backend-data/databases/`.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function resolveContainerBackendPath() {
  const candidates = [
    process.env.SOFTN_CONTAINER_BACKEND_MODULE || '',
    process.env.SOFTN_HOST_RUNTIME_DIR ? join(process.env.SOFTN_HOST_RUNTIME_DIR, 'container-backend.mjs') : '',
    join(here, 'container-backend.mjs'),
    resolve(here, '../../softn-host-php/runtime/container-backend.mjs'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    'ZIPP safe-sandbox container-backend.mjs not found. Configure hostedBackend.runtimeDir or SOFTN_HOST_RUNTIME_DIR.'
  );
}

const MAX_STDIN_BYTES = 24 * 1024 * 1024;

async function readStdinUtf8() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    total += buf.byteLength;
    if (total > MAX_STDIN_BYTES) {
      throw new Error('Hosted backend request payload exceeded maximum size');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const rawInput = await readStdinUtf8();
  const payload = JSON.parse(rawInput || '{}');
  const { bundleDir, dataDir, slug, request } = payload;
  if (!bundleDir || !dataDir || !request || typeof request !== 'object') {
    throw new Error('Invalid runner payload');
  }
  const manifestPath = join(bundleDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error('Hosted bundle is missing manifest.json');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const backendModPath = resolveContainerBackendPath();
  const { isContainerBackendManifest, handleContainerRequest } = await import(
    pathToFileURL(backendModPath).href
  );
  if (!isContainerBackendManifest(manifest)) {
    throw new Error('Hosted bundle does not declare a manifest.backend runtime and entry');
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const root = payload.root || dirname(backendModPath);
  const result = await handleContainerRequest({
    root,
    bundle: bundleDir,
    data: dataDir,
    manifest,
    config: {
      development: false,
      appId: manifest.id || slug || 'softn-hosted-app',
    },
    request,
  });

  if (result && result.isMeta) {
    const body = Buffer.from(JSON.stringify(result.body ?? {}), 'utf8').toString('base64');
    process.stdout.write(
      JSON.stringify({
        ok: true,
        status: result.status ?? 200,
        headers: [['Content-Type', 'application/json; charset=utf-8']],
        bodyBase64: body,
      })
    );
    return;
  }

  process.stdout.write(
    JSON.stringify({
      ok: true,
      status: Number.isInteger(result?.status) ? result.status : 200,
      headers: Array.isArray(result?.headers) ? result.headers : [['Content-Type', 'application/json; charset=utf-8']],
      bodyBase64: typeof result?.bodyBase64 === 'string' ? result.bodyBase64 : '',
    })
  );
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`hosted-backend-runner: ${msg}\n`);
  process.stdout.write(
    JSON.stringify({
      ok: false,
      status: 500,
      error: msg,
    })
  );
  process.exitCode = 1;
});
