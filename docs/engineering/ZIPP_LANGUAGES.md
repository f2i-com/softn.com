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

Python in ZIPP is an experimental language subset, not CPython. Its state does
not expose the global-slot or `evalInContext` APIs used by Softn screens. Merely
changing a logic file's syntax or adding `language="python"` does not turn it
into a supported reactive screen. A future language option needs an explicit
state/event bridge and matching editor, import/export and backend support.

## Python host integration

The combined engine provides `initSource(code, "python")`,
`initPythonProject(files, entry, argv)`, `pythonHas(name)` and
`pythonCall(name, args)`. Hosts can use a separate Engine for a Python calculation
and pass plain results back to their app. It uses the same loaded WASM module
as JavaScript, with separate program state. Dispose and free each Engine when
finished; a Worker is the appropriate lifecycle boundary for hosted programs.

This update does not expose Python as a selectable Softn `.logic` language,
install pip packages, or grant network, database or GPU access to Python code.
ZIPP's GPU support requires its separate host adapter; the Python feature alone
does not enable it.

Run the real artifact checks with:

```sh
npm run test -w @softn/core -- test/zipp-languages.test.ts test/zipp-lifecycle.test.ts
```

FormLogic takes this engine from the Softn release: `softn-formlogic-runtime-<tag>.zip`
carries the install unchanged under `zipp/`, with both `SHA256SUMS` files, and
every other copy of the engine in the archive is checked to be the same bytes.
A Softn release ships ZIPP's latest release only; its gate refuses any other
Cargo tag unless `allow-older-zipp` is given, and the whole release run
installs that one release.
FormLogic continues to fetch matching WASM bytes once per page and provide
copies to its isolated execution contexts.
