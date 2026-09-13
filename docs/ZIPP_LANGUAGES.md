# JavaScript and Python in the ZIPP runtime

Softn vendors a local **ZIPP 0.0.18** build with `--features python`. JavaScript
remains available in the same binary. `packages/@softn/core/wasm-zipp/SOURCE.json`
records the exact source revision, build tools, languages and checksum; this is
a local source build, not a downloaded release archive.

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

When embedding Softn in FormLogic, copy this verified binary with FormLogic's
`scripts/sync-zipp-from-softn.mjs`, then rebuild its hosted runtime, editors and
native runtime. FormLogic continues to fetch matching WASM bytes once per page
and provide copies to its isolated execution contexts.
