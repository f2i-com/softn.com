# Runtime candidate qualification

Status recorded on **2026-10-13**: the scoped source, offline and packaged-helper checks below passed. The later disposable local fixture **failed during startup before application tests**. This is a source/candidate evidence record, not successful live integration, release or deployment qualification.

## Exact candidate pair

| Input | Identity |
| --- | --- |
| SoftN runtime source | `75d2ab09a23cbeabd38c09d4830c285ab199b4a2` |
| SoftN source baseline | `cf10cf1facb312eead65d4cde59a20729c0cdc15` |
| Paired FormLogic source | `809f80a19eea244ea22e95e5e5bcf93b3387c868` |
| FormLogic source baseline | `548f23ec6f5c41a8fef8e8487511cba4801c6c9f` |
| SoftN runtime ZIP SHA-256 | `318302c7db8a8c1d7c37d233c6271a7eb1093b96c1cefdff036dd95a9505673c` |

The ZIP is `softn-formlogic-runtime-v0.0.20-candidate-20261012-isolation-r1.zip` (100,974,233 bytes). Its source identity remains the runtime commit above; a subsequent documentation-only commit does not rebuild or replace it. Published SoftN `v0.0.20` does not contain these repairs. The candidate uses verified public ZIPP 0.0.23 inputs; archive identity alone does not establish a reproducible build.

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

## Actual local fixture outcome

The v5 Windows Job containment probe **passed** single-owner closure, inherited orphan closure and two same-handle reuse rounds, including verified console-child exits. This qualifies the bounded **test harness containment**, not the product runtime end to end.

After narrow preparation fixes, all 4,708 public input copies verified. Credentials were generated and an owned disposable MySQL instance ran. Startup did not report completion. Application authentication, browser, import/upgrade and restart test phases **did not run**; no application pass is inferred from missing receipts.

Initial supervisor cleanup verified schema/user absence, then failed while stopping a service. The independent watchdog completed destruction after **14.033 seconds of credential lifetime**. Terminal checks confirmed private state removal, no exact-fixture processes, no fixture-port listeners, and no remaining supervisor/watchdog/cleanup entrypoints. Restricted-grant verification was not retained; logout was not run because the server was absent. Cleanup completed while qualification remained failed. No replacement credential lifetime was started.

The original startup cause is **unknown**. The surviving process-identity capture error could be a cleanup exception masking an earlier startup error. Deterministic diagnostics reproduced a short-lived-process identity race, but do not identify the actual failed child or establish a product defect. Exact first-secret/deadline timestamps were not retained after destruction and must not be reconstructed from elapsed duration. The next harness correction is to preserve sanitized primary and cleanup failures separately, with fixed operation labels and retained-handle exit status, without relaxing identity or containment checks.

## Remaining qualification

- Exercise the exact FormLogic/SoftN pair on a separately authorized disposable host: actual Coffee import/upgrade, HTTP authentication/cookies/JWT/CSRF, rendered phone/OTP/chat, member and same-user transitions, real cross-tab events, stale callbacks, offline startup, legacy-map exclusion, reset faults, application-mode login persistence and full process/browser restart.
- Complete or explicitly disposition applicable full backend unit-plus-database tests, Composer audit and the full frontend suite at the final FormLogic revision. The unchanged-backend PHPStan gate already passed. Broad callback races, full-store/replay behavior and final paired-artifact provenance remain outside the scoped evidence above.
- Physical IME, PWA behavior, real SMS/phone ownership, production TLS/hosting/integrations and full release/all-in-one packaging remain unqualified. Mock or simulated integrations do not establish provider success or identity assurance. Earlier live results do not transfer to these candidates.

Source/candidate publication requires an explicit decision accepting these live-qualification limits. This record authorizes no push, tag, release, deployment or running-installation replacement. Preserve the paired compatibility and rollback limits when making that decision.
