# JavaScript and Python in the ZIPP runtime

Softn ships ZIPP's official `javascript-python-base` engine (the build ZIPP
called `web-python-base` before 0.0.26), the variant compiled with
`--features python-base`: JavaScript and Python in one binary, without torch.
Torch is ZIPP's torch package, which the runtime adds only for an app that
declares it (below). Neither is committed: `npm run fetch:zipp` (and the build
and test hooks) installs the release the `zipp-vm` tag in
`apps/softn-host-rust/Cargo.toml` names into `packages/@softn/core/wasm-zipp/`,
with the torch package beside it in `wasm-zipp-torch/`, and verifies both
against the release's `SHA256SUMS`. The install's `SOURCE.json` records the
release, its source commit, languages, stack size and checksums, and the
package under `packages.torch`.

Since 0.0.26 ZIPP publishes each WebAssembly module as one plain `.wasm` file
carrying a `zipp.meta` record (its format, variant, version, commit, languages
and the digest of its bindings) and, for an engine, its wasm-bindgen bindings
in a `zipp.glue` section. The install keeps the published file byte for byte
as `zipp_wasm_bg.wasm` and writes that section out as `zipp_wasm.js`, so the
runtime imports the engine's glue as it always has; the bindings travel in the
module as well, about 60 KB raw (13 KB with Brotli) an app downloads twice.
The engine's TypeScript declarations and its `LICENSE-APACHE` come from the
release's embed kit; nothing else of the kit (its `zipp.mjs` loader and
sandbox, the host SDK, the GPU adapter) is used. Releases before 0.0.26,
published as zip bundles, are refused.

## Existing apps

`.logic` screens continue to use JavaScript. Runtime, Builder, Studio, and
FormLogic rely on JavaScript globals, expressions and callbacks for reactive
rendering. These keep their existing behavior after the engine update.

## Writing an app's logic in Python

An app's client logic can be Python instead of JavaScript. **A logic file whose
name ends `.py` is Python**, and nothing else says so: not an attribute, not the
manifest, not anything inside the file. The same rule is applied by the
composer, by the hosted runtime before it chooses an engine, and by FormLogic on
the server, so an app cannot be one language to whoever picked the engine and
another to the engine. Reference it the way any logic file is referenced:

```html
<logic src="./logic/main.py" />
```

Inline `<logic lang="python">` is refused. Python's indentation is the program,
and markup indentation is not reliable — a formatter, an editor or the component
inliner can reindent a block and change what it means — so Python lives in a
file the bundle carries verbatim.

An app uses one language for all of its logic. A bundle whose logic is partly
each is refused: the two run in separate engines and cannot share names.

### The contract

- **Every top-level name is state.** A module-level `count = 0` is a state
  variable the host mirrors and the template can read, exactly as a JavaScript
  `let count = 0` is. A name starting with `_` is the module's own business and
  is not exposed.
- **Handlers use `global`.** Assigning to a module-level name inside a function
  needs Python's `global` statement, or Python creates a local instead. This is
  ordinary Python, and it is the one thing most likely to surprise someone
  porting from JavaScript.
- **Functions are the app's API.** Every top-level `def` is callable from the
  template and from `:onclick` the same way a JavaScript function is. `_init()`
  is the one underscore name the host looks for: define it and it runs once
  after the app loads, as it does for a JavaScript app.
- **Each file is a Python module, named after the file.** `logic/helpers.py` is
  `helpers`, and another module reaches it with `import helpers` or
  `from helpers import double`. JavaScript fragments share one scope; Python
  modules do not, and giving them one would mean editing the author's file.
  Two logic files with the same name are refused. `softn` is reserved, and so is
  any name starting `__softn`.
- **`softn.*` takes a callback.** Capabilities are asynchronous on both
  languages, so `softn.backend.call("save", {...}, on_saved)` hands its answer
  to `on_saved(response)` rather than returning it. Every capability the
  JavaScript preamble offers is there, under both its Python name
  (`softn.camera.capture_photo`) and the JavaScript one
  (`softn.camera.capturePhoto`); `softn.call(kind, args, callback)` is the
  primitive underneath. `softn.on("keydown", handler)` registers an event
  listener.
- **Values cross as JSON data.** `dict`, `list`, `str`, `int`, `float`, `bool`
  and `None`. A class instance is not offered as state, because nothing outside
  the VM could mirror it. An integer outside ±(2⁵³−1) is mirrored as its decimal
  string, and a non-finite float as `None`, which is what `JSON.stringify` does.
  A `softn.*` argument goes through the same rules but LOUDLY: an unsupported
  value raises rather than becoming `None`, so a capability call never quietly
  sends something else. That strict half is the same normalizer FormLogic's
  `formlogic-python/1` contract uses, and
  `test/python-formlogic-dialect.test.ts` runs FormLogic's own cases against it
  so the two cannot drift.
- **State nests about thirty deep.** The engine's boundary carries 32 levels;
  below that a mirrored value is exact, and past it the rest reads as `None`
  rather than failing the whole state read. Keep app state shallow; a deeply
  recursive structure is the VM's to hold, not the host's to mirror.
- **Errors name the author's own file and line.** The runtime's generated files
  are dropped from a traceback, and nothing is added to the author's own
  modules, so every line keeps the number they wrote it at.
- **State is read and written through one symbol table.** The entry module
  resolves each name to the module that owns it — the last one in import order
  to define it, which is the definition the star-imports leave visible — and
  writes with `setattr` on that module. A name the table does not offer is
  refused by name, and the adapter throws rather than counting it: a write
  that did not land and was not reported would be state the host believes and
  the app does not have. `setattr` from another module being visible to the
  module's own functions is a ZIPP 0.0.19 property (FormLogic's corpus case
  `zipp-defect-cross-module-setattr`), asserted by name in
  `test/python-state-write.test.ts`.

### What Python does not have

- `db.*`, `localStorage` and `navigator.clipboard` are globals ZIPP's JavaScript
  preamble declares; a Python state has no preamble and no such names. Use
  `softn.storage.*` for the app's server storage.
- `$:` computed declarations, and any template expression that needs an
  expression evaluated in the app's scope: Python has no `evalInContext`. Call a
  function instead.
- Worker execution. A Python app runs on the main thread; the Worker runtime
  names the JavaScript adapter itself.
- Native backend logic. `softn-host-php` and `softn-host-rust` run server
  `.logic` as JavaScript, unchanged.
- ZIPP's own Python subset gaps — no `async`/`await`, among others. See ZIPP's
  `PYTHON_FRONTEND_EXPERIMENT.md`.

### Which engines can run it

Only a JavaScript-and-Python build — the `web-python-base` build Softn ships
(or ZIPP's complete `web-python`, which a host may supply). A Softn runtime that is asked to run a Python app
on ZIPP's JavaScript-only `zipp-web` build, or on the host-JavaScript engine,
refuses by name before it compiles a line — neither can execute Python at all,
and reading `.py` as JavaScript would show the author a syntax error about
their own correct code. An engine declares that it can run Python by having a
`createPython` factory method; that is the whole declaration.

### Machine learning with torch

A Python app can use ZIPP's torch — tensors, autograd, `torch.nn` modules,
losses and optimizers, run on the CPU inside the engine — by declaring it in
`manifest.json`:

```json
{
  "name": "Trainer",
  "main": "ui/main.ui",
  "config": { "python": { "packages": ["torch"] } }
}
```

Then `import torch` in any of the app's `.py` files works as it would in a
script:

```python
import torch
import torch.nn as nn

xs = torch.tensor([[0.0], [1.0], [2.0], [3.0]])
ys = xs * 2.0 + 1.0
model = nn.Linear(1, 1)
optimizer = torch.optim.SGD(model.parameters(), lr=0.05)
loss = 0.0

def train(steps):
    global loss
    for _ in range(steps):
        optimizer.zero_grad()
        current = ((model(xs) - ys) ** 2).mean()
        current.backward()
        optimizer.step()
        loss = float(current)
```

- **Declared, or refused.** The composer refuses an `import torch` the
  manifest does not declare, naming the line to add, so an app says it needs
  the package before it runs; the inspector refuses a declaration naming a
  package the runtime does not offer (`torch` is the only one). The same
  checks run in the Builder's and Studio's previews and in Studio's
  validator, because they all compose through `composeBundleSource`.
- **Loaded on demand.** The engine Softn ships is ZIPP's `javascript-python-base`
  (6.41 MB raw), which has no torch built in. When a Python app that
  declares torch starts on an engine that does not provide it
  (`pythonPackages()`: not `torchBuiltIn`, not `installed`),
  `PythonLogicAdapter.initializePythonProject` first adds ZIPP's torch
  package: `ensureZippTorch()` in `core/src/runtime/zipp-wasm-loader.ts`
  dynamic-imports the torch loader (`zipp_torch.js`, which the installer
  generates; its own small chunk) and
  calls `addTorch({ addPythonPackage }, bytes)` with `zipp_torch.wasm`
  (2.16 MB raw), fetched from `./core-runtime/zipp_torch.wasm` beside core's
  chunk — `dist/core-runtime/` in core's build, `assets/core-runtime/` in
  every app that ships core (`scripts/core-worker-assets.mjs`), which is
  outside every PWA's startup precache. `zippTorchWasmUrl()` names that URL
  without starting anything. A host that already holds the bytes (or a test)
  hands them over with `configureZippTorchSource(bytes | WebAssembly.Module)`
  before the first load. The engine checks the package's format, engine ABI
  and every file's SHA-256 before registering it. The load is one per page
  and single-flight: concurrent apps share it, a success is kept, and a
  failed load (offline for a moment) is tried again by the next app. An app
  that declares nothing never fetches it.
- **Refused only if that fails.** If the package cannot be loaded, the app is
  refused by name before it compiles — "This app uses the Python package
  torch, and the engine this page loaded does not provide it: <reason>" —
  rather than letting its first `import torch` fail as the author's own
  error.
- **What state is.** Tensors, models and optimizers are objects, so they stay
  in Python; keep what the markup shows in plain numbers, strings and lists
  (`loss = float(current)`), which are mirrored like any other state.
- **Cost.** The first declaring app on a page downloads `zipp_torch.wasm`
  (2.16 MB raw; every other app saves it), and its first `import torch`
  compiles torch's Python modules: about a second on a desktop, once per
  page. A training step of a small model is a
  few tens of milliseconds and runs on the page's thread, so train in short
  calls (a button, a timer) rather than one long loop.
- **Not wired yet:** `torch.compile`'s GPU path returns a pending result that
  a host backend executes; Softn's Python runtime does not connect that
  backend, so use eager tensors. ZIPP's `docs/TORCH_COMPATIBILITY.md` (in its
  release's embed kit) lists what the torch subset covers.
- `torch.py` is a reserved module name: an app file of that name would shadow
  the package.

## The torch package

The release's `zipp-<version>-torch-package.wasm` is installed beside the
engine, into `packages/@softn/core/wasm-zipp-torch/`, byte for byte as
`zipp_torch.wasm` (the package archive and its tensor kernels, a module that
imports nothing), with a `SOURCE.json` of its own. ZIPP published a loader for
it, `zipp_torch.js`, up to 0.0.25; since 0.0.26 the same steps are inside the
embed kit's `zipp.mjs`, which Softn does not use, so `fetch-zipp-release.mjs`
generates the loader (`TORCH_LOADER`) and its TypeScript declarations
(`TORCH_DECLARATIONS`), records their digests and holds both files to that
exact text. It refuses the whole install unless every part holds: the module
is listed in the SAME top-level `SHA256SUMS` as the engine; its `zipp.meta`
record says `torch-package`, the release, `["python"]` and the engine's commit,
and names no bindings; the module imports nothing and exports what the loader
reads; and, at INSTALL (`verifyPackage`), the engine is loaded under its glue,
the generated loader adds the package with `addTorchSync`, `pythonPackages()`
must then list torch as installed, and a small `import torch` project must run
and answer (the engine's ABI check would refuse a package built against
another engine). The engine itself must report `torchBuiltIn: false` and
nothing installed. `--check` re-verifies the digests, the recorded fields, the
module's record and its shape offline and loads nothing.
`wasm-zipp/SOURCE.json` gains an additive `packages.torch` record (`bundle`,
`bundleSha256`, `sha256`, `loaderSha256`, `variant`, `pairsWith`, `commit`,
`engineAbi`), where `pairsWith` names the engine module the package was added
to at install.

`tsup` copies `zipp_torch.wasm` into core's `dist/` and its
`dist/core-runtime/` mirror, and bundles the loader as a chunk of its own
(`zipp_torch-<hash>.js`); an app's `coreWorkerAssetPlugin` copies it to
`assets/core-runtime/zipp_torch.wasm`. The PWAs precache the engine (6.41 MB,
under their 8 MiB caps) and not the package: `assets/core-runtime/` is in
every PWA's `globIgnores`. The FormLogic runtime archive carries the install
as `zipp-torch/`, and every copy of the package in it, found by its exports,
must be the recorded one.

| | raw | gzip -9 | Brotli-11 |
| --- | ---: | ---: | ---: |
| `javascript-python` engine (torch built in; not taken) | 8,445,061 | 2,608,618 | 1,965,674 |
| `javascript-python-base` engine (every app) | 6,406,177 | 2,134,232 | 1,588,993 |
| `zipp_torch.wasm` (apps that declare torch) | 2,162,843 | 496,294 | 403,240 |

These are ZIPP v0.0.26's files as published, each module with its `zipp.meta`
record and each engine with its bindings; 0.0.25's engine was 6,187,748 bytes
raw and 1,535,660 with Brotli, and its torch package 2,156,660 and 401,562.
Of the engine's growth, 59,635 bytes raw (13,190 with Brotli) are the record
and bindings it now carries; the rest is the engine's own code. An app that
does not declare torch downloads 2.04 MB less (377 KB less with Brotli) than
it would with the complete engine; one that does downloads about 124 KB more
in all (27 KB with Brotli).

## The JavaScript-only web variant

ZIPP publishes five WebAssembly modules per release (as zip bundles before
0.0.26, under names starting `web`): `javascript-python` (JavaScript and Python
with torch built in, 8.45 MB raw), `javascript-python-base` (the same without
torch, identical glue, 6.41 MB), `torch-package` (torch as a package for the
base engine, 2.16 MB), `javascript`, the same VM compiled without Python,
about 27% smaller than `javascript-python-base`, with a 1 MiB stack in place
of 16 MiB, and `javascript-lite` (ZIPP Lite: the JavaScript core without
`Intl` and `Temporal`).
Softn's engine is `javascript-python-base` and its torch package is
`torch-package` (above); it does not take `javascript-python` or
`javascript-lite`. The `javascript` module is installed BESIDE it, into `packages/@softn/core/wasm-zipp-web/`, as a verified
variant — not as an engine Softn's own apps, editors or PWAs ever load, but so
the FormLogic runtime archive can carry it as a top-level `zipp-web/` tree for a
FormLogic that lets an app's owner choose the smaller `zipp-web` engine.

What makes it a variant rather than a second engine is provenance, and
`fetch-zipp-release.mjs` refuses the whole install unless every part holds:
`zipp-<version>-javascript.wasm` is listed in the SAME top-level `SHA256SUMS`
as the engine; its `zipp.meta` record says `javascript`, `["javascript"]` and
the SAME commit as the engine, and names the bindings it carries; its stack is
1 MiB; the module asks the host for nothing the engine's glue does not provide
and exports nothing the engine does not (so the engine's glue binds it — Softn
ships one glue, `392a691b…`, and records the module's own `95df5b8f…` in
`glueSha256` for provenance only; the web module imports one hook fewer, the
torch kernel, which instantiation leaves unread); and,
really loaded under that glue, `zippProfile().languages` is exactly
`["javascript"]` while `initSource(code, "python")` and `pythonHas` throw.
That last probe — loading the variant under the primary glue — runs at
INSTALL, in `verifyVariant`. `--check` (offline) does not load anything: it
re-verifies the installed module's digest against `SHA256SUMS`, the
`SOURCE.json` fields, the module's record and stack, and that its imports and
exports are a subset of the primary's. An install that checks is one whose
bytes are the ones the probe ran against, not one the probe has been run
against again.

Only the module, `zipp_wasm_bg.wasm`, is installed, with a `SOURCE.json` of
the variant's own;
`wasm-zipp/SOURCE.json` gains an additive `variants.web` record
(`bundle`, `bundleSha256`, `sha256`, `glueSha256`, `variant`, `languages`,
`stackBytes`, `commit`) and every key it had before is unchanged. `tsup` copies
only the engine, so `@softn/core`'s `dist/` and the PWAs never carry the variant.

In the hosted runtime, `index.html` accepts `init.engine: 'zipp-web'` and
`formlogic:ready` announces it with the variant's digest; the parent posts the
variant's bytes under the engine's glue, and the shell holds the loaded engine
to exactly `["javascript"]` — the Python build posted under the `zipp-web`
name is refused as firmly as the reverse. A Python bundle on `zipp-web` is
refused before either.

## Python host integration

The combined engine provides `initSource(code, "python")`,
`initPythonProject(files, entry, argv)`, `pythonHas(name)` and
`pythonCall(name, args)`. Hosts can use a separate Engine for a Python calculation
and pass plain results back to their app. It uses the same loaded WASM module
as JavaScript, with separate program state. Dispose and free each Engine when
finished; a Worker is the appropriate lifecycle boundary for hosted programs.

Softn's own Python app logic uses exactly this surface — `initPythonProject`
and `pythonCall`, with the instruction budget renewed before every entry — from
`packages/@softn/core/src/runtime/python/`. Nothing there reaches past the
public API.

Python code installs no pip packages. Its access to the network, storage and
GPU is the app's `softn.*` capabilities and its `permission.json`, judged by
the same host checks a JavaScript app's calls go through. ZIPP's GPU support
requires its separate host adapter; the Python feature alone does not enable
it.

Run the real artifact checks with:

```sh
npm run test -w @softn/core -- test/zipp-languages.test.ts test/zipp-lifecycle.test.ts
```

FormLogic takes this engine from the Softn release: `softn-formlogic-runtime-<tag>.zip`
carries the install unchanged under `zipp/`, with ZIPP's `SHA256SUMS`, the
web variant's install under `zipp-web/`, the torch package's under `zipp-torch/`,
and every other copy of the engine in the archive is checked to be the engine's
bytes — the one copy under `zipp-web/` the variant's — and every copy of the
torch package (`zipp-torch/` and each built app's `assets/core-runtime/`) the
recorded package's. A FormLogic app that declares torch gets it the same way
a Softn app does: the hosted runtime composes through core and fetches the
package from its own `assets/core-runtime/`.
A Softn release ships ZIPP's latest release only; its gate refuses any other
Cargo tag unless `allow-older-zipp` is given, and the whole release run
installs that one release.
FormLogic continues to fetch matching WASM bytes once per page and provide
copies to its isolated execution contexts.
