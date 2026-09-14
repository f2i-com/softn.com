# ZIPP memory lifecycle

The original measurement below was checked on 12 September 2026 against ZIPP v0.0.17, revision
`127477bd667eaf264a403ebd41c617b857574de2` (see `packages/@softn/core/wasm-zipp/SOURCE.json`).

The 110 MB / 200-engine figure in ZIPP's HANDOFF.md is the historical **B306**
measurement. **B313** subsequently made the compiled Program owned and reclaimable
in all profiles, including safe-sandbox. The fix is commit
[`88d7e7dd`](https://github.com/f2i-com/zipp.org/commit/88d7e7dd), already included
in v0.0.17. The lifecycle regression checks also pass with the locally built
JavaScript/Python v0.0.18 artifact at revision
`2f5c4c8d5295b15b57beb894dd16dca3f4ff01ce` (14 September 2026).

Two different kinds of retention must be distinguished:

| Resource | Current lifecycle |
| --- | --- |
| Initial compiled Program and VM state | Freed when the engine is disposed/freed. The B306 leak is fixed. |
| Stable-address definitions from dynamic compilation, including host eval | Still retained within that WASM instance after engine disposal. Destroying the Worker/realm releases the whole instance. |

Softn's worker runtime terminates its Worker during cleanup. The main-thread
adapter shares an instance within its JavaScript realm, so repeated dynamic eval
can accumulate definitions across app lifetimes there. A fresh engine resets
per-engine limits; it does not reset instance-wide retention. This remains an
upstream ownership follow-up, not a claim that all memory is reclaimed today.

The adapter now calls `Engine.dispose()` before `free()`. Direct `free()` already
dropped the owned Program, but skipped ZIPP's retained-resource accounting. The
explicit step makes the counters accurate; it does not itself reclaim the remaining
dynamic definitions. The wrapper is freed even if explicit teardown throws.

Run the focused downstream integration measurement against the real shipped WASM:

```sh
npm run test -w @softn/core -- test/zipp-lifecycle.test.ts --silent=false
```

The check runs 200 create/init/call/dispose cycles without eval and another 200
with one host eval per engine, validating results and disposal counters. On this
v0.0.17 checkout it reported zero retained dynamic-function bytes in the first case and
164,000 bytes in the second. These are different workloads from B306's two dynamic
compilations per engine and are not a like-for-like performance comparison.

WASM memory capacity and process RSS are logged separately. Capacity need not
shrink after allocations are freed; RSS also includes Node, V8, compilation and
allocator overhead. Neither figure alone proves a live-allocation leak. The tests
deliberately do not assert that process memory returns to its starting value.
