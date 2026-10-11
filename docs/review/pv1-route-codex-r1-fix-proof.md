# PV1 L-ROUTE Codex r1 fix: revert proof per finding

Base: 1e53a40 (red tests, no src change). Fix commits: 6c604ac (PV1R-03), 54260a1 (PV1R-01), 031c0e2 (PV1R-02), 3844109 (PV1R-05).
Method (Windows, tsc build): with every other fix in the working tree, the finding's files were stashed with a named stash
(`git stash push -m pv1r-0n-revert-proof -- <files>`), the owning package rebuilt, the finding's tests run
(`node --test --test-name-pattern "PV1R-0n" dist/test/<file>`), then the stash applied back by its sha and dropped. Tests unedited.

| Finding | Reverted files (stash sha) | Result with fix reverted | First failing assertion | With fix |
|---|---|---|---|---|
| PV1R-01 | `apps/api/src/server.ts`, `apps/api/src/payments/bank-route-routes.ts`, `apps/api/src/composition.ts` (3f9edeb) | 0 pass / 6 fail | `CMD201 configure: no Origin` actual `201 SUCCESS -`, expected `403 NOT_AUTHORIZED ORIGIN_REJECTED` (same for CMD202-205 with 200); `getBankRoute: cookie beside bearer` actual `401 AUTHENTICATION_REQUIRED -`, expected `400 INVALID_REQUEST AMBIGUOUS_CREDENTIALS` | 6/6 |
| PV1R-02 | `packages/application/src/commerce/bank/instructions.ts` (1ff94ab) | 0 pass / 1 fail | `revoked: the held read is refused like the next request` actual `200 SUCCESS -`, expected `401 AUTHENTICATION_REQUIRED -` | 1/1 |
| PV1R-03 | `packages/application/src/commerce/bank/route-config.ts` (262dd26) | 0 pass / 8 fail | `a proof stale once the evidence read returns refuses the enable` actual `200`, expected `403 ASSURANCE_REQUIRED STEP_UP_STALE`; `details expired at the effect refuse the enable` actual `200`, expected `409 PRECONDITION_FAILED DETAILS_EXPIRED`; `<verify/enable/disable/replace-details>: a proof expired at COMMIT refuses the effect` actual `200`, expected `403 ... STEP_UP_STALE`; `<verify/enable>: details expired at COMMIT refuse the effect` actual `200`, expected `409 ... DETAILS_EXPIRED` | 8/8 |
| PV1R-04 | none (test-only defect; schema already right) | n/a | n/a (`bank-kit-migrations.test.ts` PV1R-04 pass on the product as is) | green |
| PV1R-05 | `tools/matrix.mjs`, `docs/design/B06-state-command-event-matrix.md` (570940d) | 1 pass / 7 fail | `every Refund event has an entry in EDGE_OWNERS.Refund` actual `['manual_execution_declared','manual_execution_window_lapsed','manual_return_recorded','owner_attested_no_effect']`, expected `[]` | 8/8 |

## How each fix meets its scope

- PV1R-01: `RouteKit.subjectOrRefusal` is server.ts's existing `subjectOrRefusal` (actual method, `presentedCredential` Origin /
  Sec-Fetch-Site / CSRF rule of sessions protocol, REFUSED -> `refuseCredentials` with its anonymous fact); the five owner POSTs
  (bank-route-routes.ts configure/verify/enable/disable/details) call it after admission and before the handler (no journal reservation),
  getBankRoute and getTransferInstructions call it too, and I3's re-authentication uses `RouteKit.authentication` (request-aware). The
  legacy `authenticate(headers)` adapter in sessions.ts is no longer used by any bank route. Step-ups are not tied to a session.
- PV1R-02: `readTransferInstructions` keeps its re-authentication before the route share lock and judges the session again after the
  last blocking wait and the order / deadline guards, immediately before the secret-bearing view (ended session -> `UNAUTHENTICATED`
  -> the route's AUTHENTICATION_REQUIRED, no digits, no reference).
- PV1R-03: `PreCommitChecks` (domain) / `PgUnitOfWork.beforeCommit` run after the work returned and immediately before COMMIT
  (after the harness point `uow.before-commit`), in the same transaction. verify / enable / disable / replace-details register
  `judgedAtCommit`: `co.effectNow(uow)` read again, details validity (verify, enable) then the step-up judged at it; a throw rolls back
  route, version, participant, event, outbox, ALLOW fact and journal reservation. Enable additionally judges details and step-up at an
  instant read after the evidence read. `beforeCommitOf` fails closed (INTEGRITY_FAILURE) on a unit that cannot run checks.
  Configure carries no step-up (no authorizationRef in its body), so it registers none. runtime.ts and 0046 unchanged: the check runs
  inside the factory's unit after runtime.ts's security-event and journal writes, so it covers them.
- PV1R-05: four `{ owner: "L-REFUND", why, event }` entries (no `command`), events refund.submitting/uncertain/completed/failed.v1;
  generateMatrix already renders owner entries (`<owner>: <why>`); the crash was the missing entry. Matrix regenerated; the
  `machines.length === 29` expectation did not change. CMD201-205 not added to the registry: the matrix gate does not require it.
