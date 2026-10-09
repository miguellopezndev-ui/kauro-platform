# PV1 L-ROUTE: r1 product fix, revert proof

Fix commits: 4746fb0 (product), 5a7c7b8 (regenerated openapi.json and web client). Tests unchanged (de934d2).
Findings: `docs/review/pv1-route-adversary-r1.md`. Red list: `docs/review/pv1-route-r1-red.md`.

Method: on 5a7c7b8, each product hunk below was reverted by a temporary edit of the one source file, the api and its packages rebuilt
(`pnpm --filter "@kauro/api..." run build`), the named cells run on Windows
(`node --test --test-name-pattern=<cell> dist/test/ach-route-cells.test.js` in apps/api), then the file restored with
`git checkout -- <file>` and the tree checked clean. No stash, no other sha checked out.

## Result on 5a7c7b8 (Windows, focused)

- `apps/api/test/ach-route-cells.test.ts`: 62 tests, 61 pass, 1 fail. The failure is a TEST DEFECT (below), not a product refusal.
- `packages/persistence/test/bank-route-migrations.test.ts` + `bank-kit-migrations.test.ts`: 13/13.
- `apps/api/test/` bank-kit, response-contract, outcome-catalogue, cmd028-create-payment-order, b09-request-side, b10-failure-cells-quote: 42/42.
- `packages/domain/test/` commercial-rules, commerce-machines-events: 10/10.
- typecheck (api and its packages), `pnpm run arch`, `pnpm run lint:fixture-clock`, `pnpm run openapi`, `pnpm run web-client`: green.
- `pnpm run matrix`: crashes only on the known KIT c890b41 Refund edge (`Refund manual_execution_declared` has no owner); fixed in KIT2.

## TEST DEFECT (coordinator): `ADV-PV1R-2 DENY ACH-M-I2-EXPIRY (details validity)`

Part (1) passes: `409 PRECONDITION_FAILED DETAILS_EXPIRED`, NOTHING_ISSUED. Part (2) then throws in the harness before any product call:
`RangeError: the controlled clock never moves backwards (set: <now+3d> is before <now+5d>)`. Part (1) leaves the cell's controlled clock at
`validUntil = now + 5 d`; part (2) sets it to `v2 - window - 2 ms = now + 3 d`. Minimal repair: `const v2 = Date.now() + 9 * DAY_MS;`
(test line 1518), or run part (2) first. Probed with that one-line change on a temporary copy (restored with `git checkout`): the cell
passes (`transferExpiresAt = validUntil`, `sendBy = validUntil - window`). Not changed here: tests are not this lane's to edit.

## Revert proof: each red cell fails with its hunk reverted

| # | Finding | Cell (title prefix) | Hunk reverted | Failing assertion with the revert |
|---|---|---|---|---|
| 1 | ADV-PV1R-1 | `ADV-PV1R-1 RACE ACH-M-I1-RACE (lock order, ...)` | instructions.ts access(): quote FOR UPDATE and route FOR SHARE taken before the access decision (the a50db87 order) | `no deadlock (40P01 -> 503 CAPACITY_UNAVAILABLE) and no crash: close first: closure 200 SUCCESS -, issuance 503 CAPACITY_UNAVAILABLE -` |
| 2 | ADV-PV1R-10 | `ADV-PV1R-10 DENY ACH-M-I1-RETRY (authorize before locking)` | same as 1 | `the non-member's issuance waited on the victim's quote row (then answered 404 NOT_FOUND NOT_A_MEMBER)`, actual `WAITING` |
| 3 | ADV-PV1R-2 | `ADV-PV1R-2 DENY ACH-M-I2-EXPIRY (source availability deadline)` | instructions.ts window: `sourceDeadlineMs(...)` replaced by the price expiry | `window - 1 ms before the source deadline: refused` |
| 4 | ADV-PV1R-2 | `DENY ACH-M-I2D-EXPIRY (transfer window)` | same as 3 | `window - 1 ms: refused`: actual `201 SUCCESS -`, expected `409 PRECONDITION_FAILED TRANSFER_WINDOW_TOO_SHORT` |
| 5 | ADV-PV1R-2 | `ADV-PV1R-2 DENY ACH-M-I2-EXPIRY (details validity)` | instructions.ts: the DETAILS_EXPIRED check and the details validity in the window removed | `details expired at the effect instant: nothing issued`: actual `201 SUCCESS -`, expected `409 PRECONDITION_FAILED DETAILS_EXPIRED` |
| 6 | ADV-PV1R-2 | `ADV-PV1R-2 DENY ACH-M-I3-EXPIRY (details validity)` | instructions.ts I3: the details validity check removed | `expired details are hidden`: actual `409 PRECONDITION_FAILED INSTRUCTIONS_EXPIRED`, expected `409 PRECONDITION_FAILED INSTRUCTIONS_NOT_AVAILABLE` |
| 7 | ADV-PV1R-3 | `ADV-PV1R-3 DENY ACH-M-I3-REVOCATION (bank order state)` | instructions.ts I3: the open bank-order-state check removed | `order CAPTURED: the held read is refused with no account digit (got 200 SUCCESS -)` |
| 8 | ADV-PV1R-5 | `ADV-PV1R-5 DENY ACH-M-I3-REVOCATION (allowlist narrowed by re-enable)` | instructions.ts I3: the CONTROLLED allowlist check removed | `a dropped agency gets the foreign-agency answer`: actual `200 SUCCESS -`, expected `404 NOT_FOUND -` |
| 9 | ADV-PV1R-6 | `ADV-PV1R-6 DENY ACH-M-I3-REVOCATION (session)` | instructions.ts I3: the `stillAuthenticated` re-check removed | `the held read is refused like a read after the revocation`: actual `200 SUCCESS -`, expected `401 AUTHENTICATION_REQUIRED -` |
| 10 | ADV-PV1R-10 | `ADV-PV1R-10 DENY ACH-M-I3-RETRY (authorize before the evidence read)` | instructions.ts I3: the membership pre-check replaced by a constant ACTIVE | `no store read for a caller whose membership was not established`: actual 4, expected 3 |
| 11 | ADV-PV1R-10 | `ADV-PV1R-10 DENY RLS (tenant columns of a bank route)` | 0046: table-level `GRANT SELECT, INSERT` on bank_routes/bank_route_versions restored | `participant: version owner ids and evidence refs are denied or NULL (got [{"a":"<owner uuid>","b":"<owner uuid>","c":"kyc-review-...","d":"..."}])` |
| 12 | ADV-PV1R-11 | `ADV-PV1R-11 DENY ACH-M-R1-RETRY (integration class and provider bound ...)` | route-config.ts readRouteDetails: the provider / integration-class binding disabled | `a contract fake never replaces provider evidence`: actual `200 SUCCESS -`, expected `409 PRECONDITION_FAILED DETAILS_ACCOUNT_MISMATCH` |

## Design notes for the Codex prompt

- I3 membership pre-check: `uow.memberships.findLive` under a savepoint rolled back at once (`PgBankRoutes.released`), so the
  membership's transition half is not held across the store read (I3-REVOCATION membership withdrawal still commits during the held
  read) and the unit resolves its membership once, at the guard instant. A caller with no ACTIVE membership gets the authorizer's own
  answer before any tenant row or evidence byte is read. Identity status is judged at the guard only.
- I3 open set: AWAITING_TRANSFER and PARTIALLY_RECEIVED (ACH-ROUTE state table: a partial credit keeps the order payable; EXPIRED,
  RECEIVED_REVIEW and CAPTURED stop instructions). RR-2 names the closed states only; PARTIALLY_RECEIVED has no cell yet (GAP -> L-INBOUND).
- Session re-check: the api re-authenticates the request's own credentials at the guard instant (cookie session or bearer token) and
  answers exactly what an unauthenticated request gets (`refuseUnauthenticated`).
- Source deadline: min(quote.sourceAvailableUntil, the bound SourceAvailabilityReader's effectiveDeadline).
- Details validity: `bank_route_versions.details_valid_until`, set by verify from the classified evidence it verified (set once with
  the verification), so issuance reads no evidence under its locks.
- Owner identifiers and the verification reference are selected by no request role (column grants); they remain in the owner-only
  route events (actor, evidence hash).
- §7.28 of ACH-ROUTE (docs lane) still lacks the Kinstructions order: GAP -> docs lane.
