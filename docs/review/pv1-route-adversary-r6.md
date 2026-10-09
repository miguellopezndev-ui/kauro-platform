# PV1 route: internal adversary r6 (VERIFY of 68ab5cc, delta f348af1..68ab5cc; Codex r3 PV1R-02, PV1R-07, rule 16)

Verdict: FAIL (3 MAJOR, 2 MINOR). Findings JSON (review-schema): `.kauro/reviews/pv1-route-68ab5cc-adversary.json` (coordinator tree).

## Per-path check (rule 16: lock, then clock, then judge, then effect, then release)
| Path | Lock first | Clock after lock | Effect done before release | Release in finally | Verdict |
|---|---|---|---|---|---|
| Resume (every cookie auth) web-sessions.ts:173-190 | FOR UPDATE :173 | now() :177 | touch UPDATE in same tx | #boundary commit/rollback | OK |
| Route commands verify/enable/disable/replace-details route-config.ts:233 | judgedUnderHold authority.ts:44 | assuredAt + clock.nowMs after hold | app COMMIT before release (bank-route-routes.ts:111) | yes | OK |
| getBankRoute route-config.ts:498 | hold | nowMs after hold | view built in unit | yes (:155) | OK (ADV-4 denial record while held) |
| I1/I2 issuance instructions.ts:166 | hold in beforeCommit | effectNow then nowMs | COMMIT before release (server.ts:759) | yes | OK |
| CMD028 replay runtime.ts:302 | none | none | journaled body returned | n/a | ADV-2 MAJOR |
| I3 instructions.ts:342-351 | hold | effectNow :345, nowMs :351 | view built, no await | yes (:179) | OK |
| Logout / open(replacing) service.ts:242, :215 | UPDATE waits on lock | instant sampled BEFORE acquire and lock wait | n/a | #boundary | ADV-1 MAJOR |
| recordStepUp web-sessions.ts:260 | UPDATE | recordedAt sampled before wait, no deadline predicate | n/a | #boundary | in ADV-1 scope |
Pools: app -> assurance nesting in beforeCommit; assurance -> app nesting exists on the denial path (runtime.ts:335, route-config.ts:504), bounded by the 5 s connection/statement timeouts (ADV-4). Revoke that times out answers a problem (sessions.ts:259), never a silent 204. idle_in_transaction 30 s (pool.ts:133) > hold window. Hold leaks: none (hold is lazy; every caller releases in finally; a failed COMMIT on release rolls back and destroys the client).

## Revert proof (done by the adversary on Windows)
`#lockedResume` reverted to the f348af1 sample-then-UPDATE (no FOR UPDATE; the hold API kept so the api compiles), persistence + api rebuilt:
- PV1R-02 DENY ACH-M-R2-EXPIRY (row lock): `idle: the resume released past the idle deadline refuses the request` actual '200 SUCCESS -' expected '401 AUTHENTICATION_REQUIRED -'.
- PV1R-02 DENY ACH-M-I3-EXPIRY (row lock): `idle: the read released past the idle deadline is refused` actual '200 SUCCESS -' expected '401 AUTHENTICATION_REQUIRED -'.
Restored (`git checkout -- packages/persistence/src/web-sessions.ts`), rebuilt: r3 cells 10/10 green (2 PV1R-02, 6 PV1R-07, RULE16-SELF-WAIT, I3 committed-before control); tree clean.

## Windows persistence failures: lane defect, not environment (red at f348af1 too; r3 delta touches no migration)
- runtime-boundary.test.ts: the reviewed matrix `test/fixtures/runtime-boundary.json` lacks every grant/policy of 0045 (KIT) and 0046 (route). Hand-add from the test output: tables (kauro_app: bank_routes, bank_route_versions, bank_route_participants, bank_transfer_instructions, bank_vocabulary, bank_machine_edges; kauro_control: bank_vocabulary, bank_machine_edges; kauro_payment: bank_*, execution_offers, execution_offer_outcomes, execution_correlations, refund_destinations, statement_imports, statement_coverage, statement_lines, outbound_execution_attempts), column grants (0046:300-309) and policies (0045:346-384, 0046:223-293 incl. the two TO CURRENT_USER policies, precedent aggregate_kinds_register).
- source-migrations.test.ts:482-484 (B07, ACCEPTED): "still no SECURITY DEFINER" must become the exact allowlist of migrations.test.ts:172 (`register_bank_payment_route`, search_path pinned, decision #2). Acceptance-touch on B07 test file.
- Linux ci-local ran only 4 persistence files; add both to the lane set.

## Family coverage (Codex r3 scope -> covering test, red without the fix)
| Scope path | Covering test |
|---|---|
| PV1R-02 web-sessions.ts 91/141/146/148 (now :173-190) | ach-route-cells.test.ts:2726, :2748 (red with revert above) |
| PV1R-02 ports/sessions.ts 84, service.ts 203, sessions.ts 95, authenticator.ts 45 | :2726, :2748 |
| PV1R-02 bank-route-routes.ts 142/156, instructions.ts 315-342 | :2748 (final I3), :2050 retained |
| PV1R-07 instructions.ts 332/336/342/343 (now :342/:345/:351) | :2798 (started after lock waits), :2827 (committed before lock) |
| PV1R-07 bank-route-routes.ts 156, sessions.ts 95, service.ts 202, web-sessions.ts 109/158 | :2798, :2874 (x4 commands), :2893 (issuance) |
| one hold per request request-authority.ts | :2917 RULE16-SELF-WAIT (red on 84befca: 2 vs 1) |
| ADV-1 revoke instant (service.ts:242/:215, web-sessions.ts:239) | NONE: finding |
| ADV-2 CMD028 replay (runtime.ts:302) | NONE: finding |

## Caveats for the Codex prompt (resolved, still listed)
Linearization at the judgment under the lock; the response bytes go out after release (ADV-5). Session deadlines on the process clock (B11 design), effect deadlines on the DB clock.
