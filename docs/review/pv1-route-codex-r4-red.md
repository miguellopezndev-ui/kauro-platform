# PV1 route: Codex r4 PV1R-07, red evidence of the r4 cells on 7bc2745 (design `pv1-route-pv1r07-design.md` §5)

Tests only; no file under `packages/*/src` or `migrations` changed. Windows, temporary PostgreSQL 17, two consecutive runs, same result.
Commands: `apps/api`: `node --test --test-concurrency=1 --test-name-pattern="PV1R-07 r4|PV1R-02 r4" dist/test/ach-route-cells.test.js`
(21 tests: 14 red, 7 green); `packages/persistence`: `node --test --test-concurrency=1 dist/test/session-fence.test.js` (8 red).

| Cell | Red on 7bc2745 (failing assertion) |
|---|---|
| H1 I3, holder lost during the effect-clock wait | `the read whose lock holder was lost is not served (200 SUCCESS -)` |
| H2 I3, holder lost before COMMIT | `the read whose lock holder was lost is not served (200 SUCCESS -)` |
| H3 verify / enable / disable / replace-details, before the final judgment (4) | `<name>: nothing commits under a lost lock (200 SUCCESS -)` |
| H3 verify / enable / disable / replace-details, before COMMIT (4) | `<name>: nothing commits under a lost lock (200 SUCCESS -)` |
| H4 issuance, before the final judgment / before COMMIT (2) | `issuance: nothing issued under a lost lock (201 SUCCESS -)` |
| H5 getBankRoute, before COMMIT | `getBankRoute: no route view under a lost lock (200 SUCCESS -)` |
| H6 CMD028 replay, before COMMIT | `the replay under a lost lock does not return the stored body (201 SUCCESS -)` |
| H7 crash after COMMIT, replay after revocation | green (regression). Mutation proof: `runtime.ts:309` judgment removed -> red `the replay after the revocation is refused`; restored |
| S1 I3 / getBankRoute / issuance / verify (controls) | green (WAITING, served or committed, revocation 204, next 401) |
| E1, R1 (repairs) | green |
| F1, F2, F3, F4, F6, T2, T3 | `error: permission denied for table web_sessions` (42501) at the fence statement |
| F5 | `the fence fails at the unit's statement bound (query_canceled)`: actual `'42501'`, expected `'57014'` |

Every H cell found exactly one blocker of the probe (pg_blocking_pids) and it was terminated before the revocation committed 204, so
the red is the defect (the effect commits or is served on a judgment of a row no longer held), not the harness. The lock assertion
(`the only session-lock holder is the effect's own unit backend`, `no authentication-boundary backend is in a transaction`) comes after
the status assertion and is red on 7bc2745 too (the holder is the kauro_assurance hold).
Post-fix answer accepted by H1-H6: 500, 503 or 401 (design K2: 500/503; 401 if the unit is re-run); pin after the first green run.

Scratch check of the persistence cells (not committed): with design §3.1 applied as a throwaway `0047_session_fence.sql`, F1-F6, T2,
T3 pass 8/8. The store answers a 5 s statement timeout as `CAPACITY_UNAVAILABLE`, retryable, cause 57014: T2/T3 assert exactly that.
Design §5 lists a `P2` beside F1-F6/T2/T3 with no definition; no cell written for it.
