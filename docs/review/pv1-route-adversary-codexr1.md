# PV1 route: adversary VERIFY of Codex r1 fixes (db5f0e3..90b6833)

Verdict: PASS_WITH_MINOR (0 BLOCKING, 0 MAJOR in the diff). The three MINOR notes are on code outside the diff, in accepted packages, so they count as reviewer omissions and do not block.

How this was checked: I read the diff and the scope paths. `node tools/matrix.mjs check` is green on 90b6833. The Linux log pv1-route-90b6833-linux.log shows matrix 8/8, persistence 30/30, API 42/42 and cells 79/79. Revert proofs are taken from pv1-route-codex-r1-fix-proof.md; I did not run them again (read-only worktree). For PV1R-03 I confirmed in the code that the `uow.before-commit` hold sits inside the decorated work (points.ts crashableFactory). That is before `runBeforeCommit`, so the PV1R-03 cells cannot pass with the hook reverted.

## Family coverage (scope path -> fix -> covering test)

| Finding | Scope path | Fixed by | Covering test (red with fix reverted) |
|---|---|---|---|
| PV1R-01 | bank-route-routes.ts:101 (shared POST auth) | `kit.subjectOrRefusal` (server.ts:572, the existing boundary, actual method), before `guarded`/journal | PV1R-01 x5 (CMD201-205): ORIGIN_REJECTED x4, CSRF_TOKEN_INVALID x2, AMBIGUOUS_CREDENTIALS; journal(key) null; same key commits once |
| PV1R-01 | :110-114 CMD201..205 | same | same, one test per command |
| PV1R-01 | :140 getBankRoute | `kit.subjectOrRefusal` | PV1R-01 reads (AMBIGUOUS on getBankRoute) |
| PV1R-01 | :148 / :153 I3 initial auth + re-auth | `kit.subjectOrRefusal` + `kit.authentication({method, headers})` | PV1R-01 reads (AMBIGUOUS on I3, no digits) |
| PV1R-01 | sessions.ts:103 legacy adapter | not edited; no bank route calls it now (the grep finds no `authenticator.authenticate` in payments/bank) | n/a (no caller left in the lane) |
| PV1R-01 | protocol.ts:151, server.ts:565 | reused, not re-implemented | as above |
| PV1R-02 | instructions.ts:299/301/306 | second `stillAuthenticated` after lockShare, order and deadline guards, before the view (:316) | PV1R-02 cell: held at the route FOR SHARE (mustWait oracle); revoked / expired -> 401 with no digits; live -> 200 |
| PV1R-02 | bank-route-routes.ts:152 | callback is request-aware | same |
| PV1R-02 | bank-routes.ts:181, test :1824/:1862 | the new cell holds at the real SELECT FOR SHARE | same |
| PV1R-03 | route-config.ts:202/316/364/397/428 | `judgedAtCommit` via `beforeCommitOf` on verify, enable, disable and replace-details; configure has no step-up | PV1R-03 at-COMMIT x4 STEP_UP_STALE, x2 DETAILS_EXPIRED (verify, enable); no footprint; journal null; controls commit |
| PV1R-03 | route-config.ts:355 enable pre-read sample | effect re-read after the evidence read | PV1R-03 enable evidence-read cells (STEP_UP_STALE, DETAILS_EXPIRED) |
| PV1R-03 | runtime.ts:310 | not edited: the security event and `journal.commit` run inside `work`; `runBeforeCommit` runs after `work` returns, same transaction (unit-of-work.ts:483) | at-COMMIT cells (journal null) |
| PV1R-03 | 0046:216 deferred constraints | not edited: the checks run before COMMIT, and the deferred triggers then fire on a transaction that was already re-judged | same |
| PV1R-03 | hook design | fails closed: `beforeCommitOf` throws INTEGRITY_FAILURE when a unit cannot run checks. The only implementer is PgUnitOfWork, so every Pg*UnitOfWorkFactory reaches it through `super.run` (781/872/930). A replay does not run the body, so no re-judgement on replay (correct). The checks only re-read locks the transaction already holds, so there is no new lock and no new deadlock path. A throw rolls back the whole unit. | n/a |
| PV1R-04 | test :119/:125/:128, 0045:108..324 | exact set per column (24 mapped columns, exactly one CHECK each); unparsed or unmapped CHECKs are gaps | PV1R-04 exact test + mutation self-test on a scratch schema (add BOGUS / remove each token, incl. masked removals) |
| PV1R-05 | machines.ts:110-118, matrix.mjs:273/926/1019, matrix doc:352, package.json:24 | 4 EDGE_OWNERS.Refund entries `{owner:"L-REFUND", why: planned, not implemented}`, no command | matrix.test.mjs 8/8 (7 red reverted); `matrix check` green |
| PV1R-05 | error-catalogue rows (3844109) | generated: ROUTE_NOT_ENABLED .. EVIDENCE_UNAVAILABLE come from commerce/outcomes.ts; `matrix check` reports "the document is the generated one" | matrix check |

## Recurring checks (families.md), lane routes and commands
- revocation PV1R-01: all 7 bank routes use the request-aware boundary; no route-local `authenticate(headers)` is left in the lane. PASS.
- revocation/time PV1R-02/03: I3 re-judges after its last wait. Owner step-up commands re-judge at COMMIT. Issuance (instructions.ts:129-149) judges details at an effect read after its locks. Details cannot expire before COMMIT unless COMMIT is delayed past the route's minimum transfer window, because the window check includes detailsValidUntil. PASS.

## MINOR notes (outside the diff, accepted packages; non-blocking reviewer omissions)
- ADV-1 time (family sweep of PV1R-03): step-up is judged at an earlier instant with no re-judgement at COMMIT in close-agency.ts:69, activate-seller.ts:49, approve-payout.ts:65 and core/authorizer.ts:69 (the last one uses the app clock `deps.clock.now()`, not the DB clock). These are accepted packages; route them through `tools/acceptance-touch` or a later lane.
- ADV-2 time: unit-of-work.ts:658 `effectInstant` truncates the DB clock to milliseconds, while assurance_proofs.expires_at is a microsecond timestamptz. A proof can therefore be judged FRESH up to 1 ms after it actually expired. Pre-existing.
- ADV-3 revocation: commissions/routes.ts:157 `persons.authenticate(headers)` is the GET-substituting adapter. On service routes a cross-site cookie request can attach a SERVICE_NOT_PERMITTED denial fact to the victim's stream. There is no effect. Accepted package.
