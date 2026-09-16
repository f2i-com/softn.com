# JavaScript and Python in the ZIPP runtime

Softn ships ZIPP's official `web-python` release build, the variant compiled
with `--features python`. JavaScript remains available in the same
binary. It is not committed: `npm run fetch:zipp` (and the build and test
hooks) installs the release the `zipp-vm` tag in
`apps/softn-host-rust/Cargo.toml` names into `packages/@softn/core/wasm-zipp/`
and verifies it against the release's `SHA256SUMS`. The install's `SOURCE.json`
records the release, its source commit, build tools, languages, stack size and
checksums.

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

Only the `web-python` build. A Softn runtime that is asked to run a Python app
on ZIPP's JavaScript-only `zipp-web` build, or on the host-JavaScript engine,
refuses by name before it compiles a line — neither can execute Python at all,
and reading `.py` as JavaScript would show the author a syntax error about
their own correct code. An engine declares that it can run Python by having a
`createPython` factory method; that is the whole declaration.

## The JavaScript-only web variant

ZIPP publishes two wasm builds per release: `web-python` (above) and `web`, the
same VM compiled without Python, about a third smaller, with a 1 MiB stack in
place of 16 MiB. Softn's engine is always `web-python`. The `web` build is
installed BESIDE it, into `packages/@softn/core/wasm-zipp-web/`, as a verified
variant — not as an engine Softn's own apps, editors or PWAs ever load, but so
the FormLogic runtime archive can carry it as a top-level `zipp-web/` tree for a
FormLogic that lets an app's owner choose the smaller `zipp-web` engine.

What makes it a variant rather than a second engine is provenance, and
`fetch-zipp-release.mjs` refuses the whole install unless every part holds: the
`zipp-wasm-<version>-web.zip` is listed in the SAME top-level `SHA256SUMS` as
the engine's bundle and every file matches the bundle's own `SHA256SUMS`;
`BUILD-INFO.txt` says `variant=javascript`, `languages=["javascript"]`,
`stack-bytes=1048576` and the SAME commit as the engine; the module asks the
host for exactly the engine's imports and exports nothing the engine does not
(so the engine's glue binds it — Softn ships one glue, `ae41ff7d…`, and records
the web bundle's own `7622deb6…` in `glueSha256` for provenance only); and,
really loaded under that glue, `zippProfile().languages` is exactly
`["javascript"]` while `initSource(code, "python")` and `pythonHas` throw.
That last probe — loading the variant under the primary glue — runs at
INSTALL, in `verifyVariant`. `--check` (offline) does not load anything: it
re-verifies the installed sibling's digests against both `SHA256SUMS`, the
`SOURCE.json`, `BUILD-INFO.txt` and `PROFILE.json` fields, and that the
module's imports and exports are a subset of the primary's. An install that
checks is one whose bytes are the ones the probe ran against, not one the
probe has been run against again.

Only `zipp_wasm_bg.wasm`, `BUILD-INFO.txt`, `PROFILE.json` and the bundle's
`SHA256SUMS` are installed, with a `SOURCE.json` of the variant's own;
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
carries the install unchanged under `zipp/`, with both `SHA256SUMS` files, the
web variant's install under `zipp-web/`, and every other copy of the engine in
the archive is checked to be the engine's bytes — the one copy under `zipp-web/`
the variant's.
A Softn release ships ZIPP's latest release only; its gate refuses any other
Cargo tag unless `allow-older-zipp` is given, and the whole release run
installs that one release.
FormLogic continues to fetch matching WASM bytes once per page and provide
copies to its isolated execution contexts.
