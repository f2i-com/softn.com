# Runtime candidate qualification

Status recorded on **2026-10-13**: **full qualification remains on hold**. The candidate-specific TypeScript error is corrected and the complete typecheck now passes; the remaining failed or unexecuted suites and live gates are unchanged. Scoped source, offline and packaged-helper checks passed. The disposable local fixture **failed during startup before application tests**. This record establishes neither successful live integration nor release/deployment readiness.

## Exact candidate pair

| Input | Identity |
| --- | --- |
| SoftN production runtime / packaged candidate source | `75d2ab09a23cbeabd38c09d4830c285ab199b4a2` |
| SoftN corrected test source | `2ad998bb309239a3cd5630ce238ca3d50acded69` |
| SoftN source baseline | `cf10cf1facb312eead65d4cde59a20729c0cdc15` |
| Paired FormLogic source | `809f80a19eea244ea22e95e5e5bcf93b3387c868` |
| FormLogic source baseline | `548f23ec6f5c41a8fef8e8487511cba4801c6c9f` |
| SoftN runtime ZIP SHA-256 | `318302c7db8a8c1d7c37d233c6271a7eb1093b96c1cefdff036dd95a9505673c` |

The ZIP is `softn-formlogic-runtime-v0.0.20-candidate-20261012-isolation-r1.zip` (100,974,233 bytes). Its source identity remains the runtime commit above. The later `2ad998bb` change only adds an explicit generic type argument in one test; production runtime bytes, lockfiles and packaged artifacts are unchanged. Neither that correction nor documentation-only commits rebuild or replace the ZIP. Published SoftN `v0.0.20` does not contain the runtime repairs. The candidate uses verified public ZIPP 0.0.23 inputs; archive identity alone does not establish a reproducible build.

The admitted FormLogic storage descriptor, session fences and acknowledged SoftN storage capability must be used together. The repaired FormLogic consumer rejects old responses lacking the required descriptor. Neither side alone supplies the paired guarantees. See [the runtime contracts and rollback limits](../FORMLOGIC_RUNTIME_REPAIR.md) and [the paired FormLogic contract](https://github.com/f2i-com/formlogic.com/blob/809f80a19eea244ea22e95e5e5bcf93b3387c868/docs/NATIVE_RUNTIME_SESSION_ISOLATION.md).

## Passed checks and their boundaries

These are recorded producer and independent-review results on the identified bytes, not tests rerun for this documentation change. Suites overlap and cover different boundaries; **do not sum the counts into a unique-test total**.

| Scope | Recorded result | Boundary |
| --- | --- | --- |
| Independent host-shell and hosted XDB | 58 host-shell tests; 23 hosted-XDB tests passed | Acknowledgments, queue/disposal behavior, unknown outcomes and batch contracts in source tests. |
| Independent migration and SQL | 26 helper/SQL tests; 7 selected runner/ledger/deadline tests passed | Includes scoped nullable-TEXT compatibility and retained denial/deadline guards. |
| Independent copied-source native runtime | 9 tests passed | Copied source with pinned public ZIPP inputs; did not execute the candidate ZIP or an installed host. |
| Independent exact Coffee migration scenarios | 4 passed; the same harness with the unrepaired baseline had 4 expected failures | Immutable migration/ledger scenarios, not Coffee handlers or authentication. |
| Broader producer regressions | XDB family 217; composition family 61; exact Coffee synthetic composition chain 6 passed | Overlaps the narrower suites; synthetic composition is not physical IME or browser authentication. |
| Independent synthetic composition | 6 Coffee chain cases and 11 strict-boolean/event controls passed | Exact Coffee client/UI bytes with synthetic events; no real IME/browser/authentication. |
| Runtime packaging | Packaging passed; 603 archive members and 602 manifest digests verified | Candidate archive identity and contents, not installed-host integration. |
| Independent packaged candidate inspection | 40 byte/source checks and 43 compiled-content/function checks passed | Selected parsed/extracted functions, not execution of the whole browser bundle. |
| Actual ZIP migration helper | 6 in-memory SQLite tests passed | Helper extracted from this ZIP; does not execute ZIPP or the full host. |
| Paired FormLogic recovery | 177 targeted/boundary tests passed at `809f80a1`, including 18 recovery tests; independent review repeated 177 and added 5 cases | Current scoped recovery/session behavior; overlapping results are not additive. |
| Paired unchanged FormLogic backend | Targeted PHPUnit: 133 tests / 805 assertions; PHPStan: 206 production files / zero errors | Backend bytes unchanged through `809f80a1`; this is not full unit-plus-database coverage. |
| Paired FormLogic frontend | Lint, test TypeScript, security, pack-screen and production build passed; UI-only archive verified | Earlier full suite: 3,453 passed / 227 skipped on bytes committed as `a53b62f2`, not a full-suite rerun at `809f80a1`. UI-only archive is not a full installer. |

Independent review found no blocking defect in the scoped SoftN acknowledgment/XDB, migration or composition changes. Source identity was checked separately after the failed fixture: both product heads were clean and all 47 changed-file hashes across the pair still matched the pre-fixture inventory. This does not make the failed live attempt a pass.

## Expanded local repository gates

The original expanded checks used the product source through documentation-only commit `071c3a1afc08cbeb0d8b71aa8094220da2b9db2b`. The separately identified typecheck repair and affected-test reruns below used the corrected bytes committed as `2ad998bb`. The command inventory follows `.github/workflows/verify.yml`; the local platform was Windows with Node 24.19.0, npm 11.17.0 and PHP 8.4.15. It does **not** cover every Ubuntu/POSIX branch in that workflow. Commands had explicit time limits. No hosted CI, model loads, production integrations or new Coffee fixture were used.

| Gate | Actual result |
| --- | --- |
| Clean `npm ci` | **PASS**, 18.473 seconds, 730 packages added / 750 audited / zero vulnerabilities, in a separate exact-LF checkout of `75d2ab09`; all 2,009 tracked Git blobs and lockfiles unchanged. The suites below used the existing dependency tree, so this is separate install-prerequisite evidence. |
| Pinned engine and demos | Engine `--ensure` passed. The initial demo check failed because 23 pinned bundles were absent; fetching and verifying all 23 then passed. These are public application bundles, not loaded models. |
| `npm audit --audit-level=high` | Initial sandbox DNS failure; normal-network retry **PASS**, zero advisories across 876 dependencies including development tooling. |
| `npm run build:packages` | **PASS**, 28.607 seconds. |
| `npm run build:apps` | Initial sandbox `realpath` EPERM on `zipWorker.ts`; unchanged-source normal-permission retry **PASS**, 41.457 seconds. |
| `npm run typecheck` | Original **FAIL**, exit 2, 18.285 seconds: `packages/@softn/core/test/xdb-hosted-storage.test.ts:274` reported TS2345 because the test helper inferred only one member of a promise union. Corrected in `2ad998bb` by changing `watched(pending)` to `watched<unknown>(pending)`; the complete gate then **passed**, exit 0, 12.968 seconds. No runtime code, assertion or compiler configuration changed. |
| Affected hosted-storage tests after correction | **23/23 passed** on the default engine (1.135 seconds), and the same **23/23 passed** on host JavaScript (1.238 seconds), with no skips. These overlapping affected-file reruns are separate from the earlier full suites. All three repair commands finished with empty owned Jobs and no cleanup error. |
| `npm run lint` | **PASS**, 29.932 seconds, zero warnings. |
| Rust host | `cargo test --manifest-path apps/softn-host-rust/Cargo.toml --locked --offline`: **159 passed**, zero failed/ignored/filtered, 183.234 seconds. |
| Rust desktop loader | `cargo check --manifest-path apps/softn-loader/src-tauri/Cargo.toml --locked --offline`: initial C1083 on an existing 263-character include path; **PASS**, 167.000 seconds, after shortening only owned cache/target/temp paths. Source and lockfiles unchanged; Linux configuration was not run. |

Independent source review found no blocking issue in the narrow typecheck correction: `watched` observes settlement without reading the fulfilled value, so explicit `unknown` is sufficient and erased from JavaScript. The original failure remains historical evidence; only that specific blocker is resolved. The review verified the repair's three receipts and unchanged runtime/configuration/lock inputs without running services or generating credentials.

All 22 JavaScript test units are accounted for below. Counts are per unit and are not additive across alternate engines or retries. The original shard 2, 3 and 4 commands **failed** and remain failed evidence; passing complete-unit retries do not turn those executions into passes. Shard 1 was split into its declared units to withhold the API fixture.

| Unit | Passed / failed / skipped | Disposition |
| --- | --- | --- |
| `scripts/**/*.test.mjs` | 112 / 0 / 1 | Full unit passed; both actual Chromium cases and built Builder/Studio/web isolation checks ran. Skip requires `SOFTN_CHECK_RELEASE_DIR` with full release archives, which `verify.yml` does not provide. |
| `@softn/runtime-shell` | 16 / 0 / 0 | Passed. |
| `@softn/vite-plugin` | 6 / 0 / 0 | Passed. |
| `@softn/api` | Not run | Main API fixture generates an admin key and uses an unreserved random port; held outside the authorized scope. |
| `packages/@softn/core/scripts/*.test.mjs` | 50 / 0 / 0 | Passed. |
| `@softn/editor-shared` | 48 / 0 / 0 | Passed. |
| `@softn/builder` | 1,632 / 0 / 0 | Passed. |
| `@softn/single-private` | 54 / 0 / 38 | **Failed suite:** two files failed, one at import with EPERM and one in PHP server setup. Zero failed test bodies does not mean a pass. See scope correction below. |
| `@softn/site` | 166 / 0 / 0 | Passed. |
| `docs/tests/*.test.mjs` | 25 / 0 / 0 | Full normal-permission retry passed after initial 23 passes and two failures: junction EPERM and loopback EACCES. |
| `apps/formlogic-host/test/*.test.mjs` | 58 / 0 / 0 | Passed. |
| `@softn/brand` | 9 / 0 / 0 | Passed. |
| `@softn/single-shell` | 95 / 0 / 0 | Full normal-permission retry passed after initial 79 passes and four import EPERM file failures. |
| `@softn/host-php` | 75 / 33 / 23 | **Failed.** Narrow photo diagnostic described below does not pass this full unit. |
| `@softn/loader` | 86 / 0 / 0 | JavaScript suite passed; Rust scope is separate. |
| `@softn/studio` | 885 / 1 / 0 | **Failed.** Generated-knowledge mismatch independently attributed to unchanged baseline CRLF inputs; no full-suite retry. |
| `@softn/bundle-format` | 37 / 0 / 0 | Passed. |
| `@softn/components` | 1,746 / 0 / 0 | Passed. |
| `@softn/core` | 1,884 / 0 / 0 | Passed on the declared ZIPP engine. |
| `@softn/single` | 10 / 0 / 0 | Full retry passed after successful application build; initial five build-graph skips were due to the missing built manifest. |
| `@softn/web` | 237 / 0 / 0 | Full retry passed; initial 196 passes / seven skips and five import EPERM file failures retained. |
| `test:host-js` | 1,840 / 0 / 4 | Passed with declared alternate-engine exclusions: four Python-logic cases skipped, plus five ZIPP-only test files excluded by configuration. |

The PHP failures comprise **28 assertions affected by WAMP Xdebug stderr**, two CGI assertions receiving `private_permissions`, and three unresolved slot-wait assertions. The five photo cases passed a credential-free CLI-only diagnostic with `XDEBUG_MODE=off`; other cases were not rerun. Independent static comparison found the failing photo/request paths, relevant PHP runtime files, and private/API fixture trees unchanged from baseline. The route-declarations file has an added migration test elsewhere, but its failed body-text test is unchanged. Unchanged source alone does not establish a baseline runtime pass. The permission response has two possible source branches, and the sanitized evidence does not identify which answered; ACL, path and SAPI explanations remain hypotheses. The three waiting assertions also have no established cause. No PHP/private/API product fix is justified by that static attribution. The PHP skips are seven explicitly unsupported Windows HTTP-runner cases, one POSIX ownership case, and 15 cases requiring `SOFTN_PHP_TEST_BACKEND`; the workflow itself does not provision that optional backend fixture.

Independent source review classifies the Studio mismatch as a baseline Windows checkout line-ending issue, not a candidate regression. The generator, assertion, all inputs including the component source tree, and generated Git blobs are identical at baseline, runtime candidate and corrected source `2ad998bb`. An exact-LF checkout reproduced all three generated files byte for byte; shared-checkout CRLF input bytes also alter embedded source hashes. Neither this document nor the corrected storage test is a generator input. No generated knowledge was committed, and no full Studio pass is claimed.

One test side effect rewrote `docs/generated/landing.json` from CRLF to LF: `scripts/dev-docs.test.mjs` invokes the documentation plugin, whose generator defaults to writing integration files. Normalized content remained equal to the committed blob. Generated bytes and diff were preserved, then only that file was restored to its exact pre-test bytes. All 2,010 tracked physical hashes matched the pre-gate inventory before documentation commit `ad57b363`. The later test correction was inventoried separately. Ignored builds and caches are not release artifacts.

### Private-server test scope correction

The initial inspection missed `apps/softn-single-private/test/php-server.test.ts` inside the full shard. Its setup was **attempted and failed**, despite the prohibition on a new credential fixture. This was a scope miss, not an approved live qualification attempt. The hook starts test-owned PHP on loopback and may initialize viewer authentication state; whether a secret or cookie was actually generated is **unknown**. No secret values were read or exported.

The setup hook timed out after 10 seconds; all 38 bodies under it, including secret-claim and visitor scenarios, were skipped. The containing shard's owned Windows Job ran for 158.357 seconds and cleanup verified the original process exited and zero Job members remained. A later metadata-only check found all test-owned `softn-serve-*` roots absent. This bounds the processes, not a cookie's validity: the default cookie TTL is 43,200 seconds, and exact secret creation/removal instants were not retained. The absence check was within 391 seconds of shard start. No API/private/server retry or replacement Coffee lifetime followed.

Fresh paired FormLogic evidence is recorded in its [qualification status](https://github.com/f2i-com/formlogic.com/blob/78b0a0ac560513c0de069d794d5fccffba584243/docs/QUALIFICATION_STATUS.md): the full frontend passed 3,471 cases with 227 optional parity skips, and npm/Composer audits passed. Broad backend coverage still has one missing-launcher failure and lacks authorized MySQL integration. Those results do not qualify SoftN's remaining suites or the paired live gates.

## Actual local fixture outcome

The v5 Windows Job containment probe **passed** single-owner closure, inherited orphan closure and two same-handle reuse rounds, including verified console-child exits. This qualifies the bounded **test harness containment**, not the product runtime end to end.

After narrow preparation fixes, all 4,708 public input copies verified. Credentials were generated and an owned disposable MySQL instance ran. Startup did not report completion. Application authentication, browser, import/upgrade and restart test phases **did not run**; no application pass is inferred from missing receipts.

Initial supervisor cleanup verified schema/user absence, then failed while stopping a service. The independent watchdog completed destruction after **14.033 seconds of credential lifetime**. Terminal checks confirmed private state removal, no exact-fixture processes, no fixture-port listeners, and no remaining supervisor/watchdog/cleanup entrypoints. Restricted-grant verification was not retained; logout was not run because the server was absent. Cleanup completed while qualification remained failed. No replacement credential lifetime was started.

The original startup cause is **unknown**. The surviving process-identity capture error could be a cleanup exception masking an earlier startup error. Deterministic diagnostics reproduced a short-lived-process identity race, but do not identify the actual failed child or establish a product defect. Exact first-secret/deadline timestamps were not retained after destruction and must not be reconstructed from elapsed duration.

The scoped v7 diagnostics correction is complete: the supervisor preserves sanitized primary and cleanup failures separately, and process capture records observations from the original retained handle, with explicit unavailable states. Strict identity failures, deadlines and cleanup scope remain unchanged. Supervisor regression passed **66 assertions**; process-identity regression passed **386 assertions across 46 cases**; the existing lifecycle static suite passed **72 assertions**. The first two were independently repeated. These are separate, overlapping extracted-source/mock/static checks, not a combined coverage count or a live fixture result. No operational fixture entrypoint, native probe, service or new credential lifetime ran for this correction. It improves future evidence without resolving the original startup failure.

## Remaining qualification

- Exercise the exact FormLogic/SoftN pair on a separately authorized disposable host: actual Coffee import/upgrade, HTTP authentication/cookies/JWT/CSRF, rendered phone/OTP/chat, member and same-user transitions, real cross-tab events, stale callbacks, offline startup, legacy-map exclusion, reset faults, application-mode login persistence and full process/browser restart.
- The candidate-specific TS2345 is resolved at `2ad998bb`; complete typecheck and both affected-file engine runs passed. Complete or explicitly disposition the unchanged API/private/PHP and Linux/POSIX gaps after inspecting every test file type and obtaining authorization for any required credential fixture. Other full suites were not rerun for this type-only test correction. The current record does not waive the repository's local checks for `[skip ci]` commits.
- Complete the paired backend launcher/database gaps. FormLogic's fresh full frontend and dependency audits passed within their recorded skips; unchanged-backend PHPStan also passed. Broad callback races, full-store/replay behavior and final paired-artifact provenance remain outside the scoped evidence above.
- Physical IME, PWA behavior, real SMS/phone ownership, production TLS/hosting/integrations and full release/all-in-one packaging remain unqualified. Mock or simulated integrations do not establish provider success or identity assurance. Earlier live results do not transfer to these candidates.

Source/candidate publication requires an explicit decision accepting these live-qualification limits. This record authorizes no push, tag, release, deployment or running-installation replacement. Preserve the paired compatibility and rollback limits when making that decision.
