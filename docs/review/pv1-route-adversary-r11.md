# PV1 route: internal adversary r11 (PV1R-07 r4 root fix), candidate 81d2509

Scope: `git diff 0619f7a..81d2509` only (A6). Verdict: **FAIL** (1 MAJOR evidence, 2 MINOR). The code is sound. Receipt: adversary FAIL
kauro-platform@81d2509. Findings JSON: `.kauro/reviews/pv1-route-81d2509-adversary.json` (Codex schema).

## Findings
| Id | Sev | Family | Where | What | Acceptance |
|---|---|---|---|---|---|
| ADV-1 | MAJOR | evidence | `docs/review/pv1-route-touched-B06.md:144-156`; `pv1-route-test-repairs.md:113`; `apps/api/test/b11-sessions.test.ts:452` | 81d2509 re-rules the accepted B11 security test W2: count(*) as kauro_app no longer fails with permission denied, and the D-AUTH-1a assertions replace it. The A6 touched list, the fix proof and the test-repairs record do not mention it, and the record says RELAXED: 0. The same r4 table (:155) files `commerce/request/runtime.ts` as a lane file, but the same doc (:28) lists it as an accepted B09 file. Its :309 replay judgment is shared by request-refund.ts:38, approve-refund.ts:111 and route-config.ts:280. | Add a row for b11-sessions W2 (old assertion, new assertions, D-AUTH-1a, run green). List runtime.ts:309 as an accepted-B09 touch with its callers and cells (H6, H7, ADV-2 r6). Record W2 in test-repairs as RE-RULED. |
| ADV-2 | MINOR | evidence | `pv1-route-pv1r07-design.md:110,146` | K2 still says 500/503 and §5 expects 503 (57P01 maps to CAPACITY_UNAVAILABLE, sqlstate.ts:174). The cells pin 500 (ach-route-cells.test.ts:3383) because a lost backend surfaces as a client-side connection error with no SQLSTATE. The client contract is not stated. | K2 states the pinned 500 and its reason (B06 classification, out of lane), and that a same-key retry settles the outcome (H7, ADV-2 r6). |
| ADV-3 | MINOR | evidence | `pv1-route-pv1r07-design.md:93,96,125` | The getBankRoute and shared-replay rows cite only the before-COMMIT kill point. They do not record lock-to-judgment as N/A, with the reason: judgedUnderHold with no `between` has no statement or await between the fence and liveAt (authority.ts:46-49). §5 lists a P2 cell that does not exist. | Add the N/A reasons. Define P2 or remove it. |

## Checklist answers
1. **Kill the holder at every point.** The holder is now the effect's own backend: H1-H6 assert `fencedByOwnTransaction` (pg_blocking_pids names exactly that backend, and no kauro_assurance backend is in a transaction).
   - I3: H1 (lock to judgment), H2 (judgment to COMMIT). Commands x4: H3 at both points. Issuance: H4 at both points.
   - getBankRoute: H5. CMD028 replay: H6. These two paths have no await between lock and judgment (ADV-3).
   - No authority-bearing path judges a row read on another connection or a cached record. The assurance pool is still used, but only before the fence: authentication (resume), and I3 `stillAuthenticated` (instructions.ts:325, before :342). No kauro_assurance call follows the fence in any path.
2. **COMMIT/release failure.**
   - The release is the checked COMMIT (unit-of-work.ts:491-494). It throws before any byte is sent. A failed ROLLBACK destroys the connection (:505-509).
   - The assurance store COMMIT is also checked (web-sessions.ts:130-145).
   - pool.ts:208 only logs, but it records `lost`: the holder's next statement fails, and release destroys the connection (:215-217). It masks nothing.
   - No unhandled pg `error` event is possible in product code. The listener stays attached for the whole checkout (pool.ts:206-219). pg-pool 3.14.0 re-attaches the idle listener on every release (node_modules pg-pool index.js:385), and the pool `error` handler is present (pool.ts:150). The side connection listens too (unit-of-work.ts:547-548).
   - The 17.9 s death is not attributable to product code. It is consistent with tsc rewriting dist mid-run (module load). Afterwards: 7 full runs at 131/131, plus 4 focused runs of mine, all green.
3. **0047 privileges.**
   - Column SELECT of the 5 judged columns and UPDATE(session_id) only. No table grant, no INSERT/DELETE, no function, no SECURITY DEFINER.
   - Both policies require hash AND user. WITH CHECK (false), and the immutable trigger (0025:57) also blocks writes. FORCE RLS stays on (0025:77).
   - kauro_app cannot enumerate sessions or read provider/subject_hash/session_id: verified by the W2 run and by F3.
   - runtime-boundary.json additions are exactly 0047. The B07 definer allowlist is untouched (migrations.test.ts only adds a list entry).
4. **Lock order.** The session FOR SHARE is the last lock: I3 at :342 after the route at :327; commands and issuance in beforeCommit. Only plain reads and COMMIT follow it.
   - The writers (resume, revoke, step-up) hold only the session row FOR UPDATE plus FK KEY SHARE (identities, new proof). No app path takes FOR UPDATE on identities or proofs (proofs are append-only). No cycle.
   - Starvation of revoke by overlapping FOR SHARE is not possible: every new request first passes resume FOR UPDATE, which queues behind the revoke.
   - Both orders: F1 and F4. Timeouts: F5 (57014 -> CAPACITY_UNAVAILABLE), T2, T3.
5. **Test repairs.**
   - E1/R1, PV1R-06 x2 and ADV-2 r6 keep their security assertions; only the pause moves to the request's own connection. The red under mutation is shown below.
   - H1-H6 are pinned to exactly 500. That is acceptable for security (no effect, no view, next request 401). The record must say why it is not 503 (ADV-2).
6. **Touched list.** The diff vs `pv1-route-touched-B06.md` r4: missing `apps/api/test/b11-sessions.test.ts`, and runtime.ts is mislabelled (ADV-1). Every other file is listed.

## Red proof (mutations applied in memory at module load, no file changed; baseline 23/23 green on the same dist)
| Mutation | Cells | Result |
|---|---|---|
| COMMIT failure swallowed (unit-of-work `#once`) | H2, H3 verify, H4, H5, H6 (before COMMIT) | 5/5 red: `not served (200 SUCCESS -)`, `nothing issued under a lost lock (201 SUCCESS -)`, `no route view (200)`, `replay ... (201)`, `verify: nothing commits (200)` |
| liveAt forced true (`service.holdIn`) | R1, E1, ADV-2 r6, PV1R-02 I3-EXPIRY | 4/4 red: `held read ... not refused after the revocation`, `idle: the read released past the idle deadline is refused`, `the replay of a revoked session is refused (201)` |
| FOR SHARE dropped (`session-fence.ts:35`) | S1 x4, H1, H4 | 6/6 red: `a revocation started during the hold waits on the session row the effect holds`, `exactly one backend holds the session row (blockers [])` |
Also green: b11-sessions + b11-stage1-seams 15/15; session-fence + runtime-boundary 9/9.

## Family coverage (Codex PV1R-07 scope path -> state at 81d2509 -> covering cell, red without the fix)
| Scope path (Codex r4) | State | Covering cell |
|---|---|---|
| persistence/src/web-sessions.ts:220, :235, :241 (separate hold) | deleted | H1-H6 (red on 7bc2745; fix-proof revert) |
| web-sessions.ts:253 (revoke after holder loss) | the revoke waits on the effect's own backend | F1, F2, S1 x4 (red: FOR SHARE dropped) |
| persistence/src/pool.ts:208 (sink only) | holder loss fails the unit's next statement or COMMIT | H2-H6 (red: COMMIT swallowed) |
| application/src/ports/sessions.ts:82 (HeldWebSession) | replaced by SessionFence (unit-bound) | H1-H6, F1-F6 |
| application/src/sessions/service.ts:236 (cached liveAt) | holdIn judges the row the fence returned (:238-241) | R1, E1, ADV-2 r6 (red: liveAt true) |
| apps/api/src/authenticator.ts:36, :59; sessions.ts:122 | holdRequest(request, uow, userId), no release | H1-H6 |
| apps/api/src/request-authority.ts:25, :34, :46 (cache, swallow) | deleted; hold(uow) per unit | H1-H6, F6 |
| application/src/api/authority.ts:47 | judgedUnderHold(authority, uow, clock) | H3, H4, H5, H6 |
| commerce/bank/instructions.ts:166 (I1/I2) | fence in beforeCommit of the issuance unit | H4 x2 (red: COMMIT swallowed) |
| instructions.ts:342, :345, :351, :352 (I3) | fence in the read's unit; view built before the checked COMMIT | H1, H2, R1, E1 |
| route-config.ts:233, :347, :389, :428, :459 (CMD202-205) | fence in beforeCommit | H3 x8 (verify red: COMMIT swallowed), S1 verify |
| route-config.ts:498 (getBankRoute) | fence in the read's unit | H5, S1 getBankRoute |
| request/runtime.ts:309 (shared replay) | fence in the replay unit | H6, H7, ADV-2 r6 (red: liveAt true) |
| route-config.ts:280 (CMD201 replay), request-refund.ts:38, approve-refund.ts:111 | same runtime.ts:309; contexts bind envelope.userId (runtime.ts:158-159, tenantContextOf) | covered through the shared function by H6/H7/ADV-2 r6 (same code, same binding) |
| bank-route-routes.ts:111, :155, :179; server.ts:759 (release after) | deleted | H1-H6 |
| unit-of-work.ts:487 (COMMIT independent of the lost hold) | the hold is the unit itself | H2-H6 |
| unit-of-work.ts:601 (effect clock async) | E pause points after the fence | H1, H3/H4 before the final judgment |
| ach-route-cells.test.ts:2527, :2546, :2798, :2827, :2874, :2893, :3007; pool-diagnostics.test.ts:114 | holder-loss cells added | H1-H7, S1, E1, R1 |

Not in this diff, disclosed earlier and accepted by Codex r4 as outside the lane: the CMD201 fresh path and the fresh refund commands
judge the session only at authentication (STEPUP-AT-COMMIT disclosures). K4 (bearer, no row lock) is unchanged.
