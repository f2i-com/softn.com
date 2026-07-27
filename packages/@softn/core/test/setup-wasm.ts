/**
 * Hand the scripting engine to tests as bytes, before any test touches the VM.
 *
 * The wasm glue resolves its binary with `new URL('...wasm', import.meta.url)`
 * and fetches it. Under jsdom that URL resolves against the document origin
 * (http://localhost:3000), so the fetch tries to reach an HTTP server that is
 * not running and every VM test dies with ECONNREFUSED. Initialising the
 * module from disk here makes the glue's own `if (wasm !== undefined) return`
 * guard short-circuit that fetch when the adapter later calls init itself.
 *
 * The path is resolved by walking up from the working directory rather than
 * from `import.meta.url`, which is an http URL under jsdom and not a file one.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import initWasm from '../wasm-zipp/zipp_wasm.js';

const REL = 'wasm-zipp/zipp_wasm_bg.wasm';

function findEngine(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, REL);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not find ${REL} from ${process.cwd()}. Run \`npm run build:zipp-wasm -w @softn/core\`.`
  );
}

await initWasm({ module_or_path: readFileSync(findEngine()) });
