# PV1 L-ROUTE: adversary r1 tests, red evidence on a50db87

Findings: `docs/review/pv1-route-adversary-r1.md`. File: `apps/api/test/ach-route-cells.test.ts`. Product code unchanged (a50db87).
Run: `pnpm --filter @kauro/api exec node --test --test-reporter=spec dist/test/ach-route-cells.test.js` on Windows after `tsc -p apps/api`.
Whole file on a50db87 + these tests: 62 tests, 50 pass, 12 fail. Each of the 12 fails for its finding's reason, never in setup. Coordinator rulings RR-1..RR-6 are applied (see test-repairs). bank-kit 5/5 and bank-route-migrations 3/3 pass.

"Guard" means green on a50db87: the behaviour is right but had no discriminating test. The revert that turns it red is named. Revert
probes ran on the build output only (`dist`, gitignored, restored after each run). The 0046 probe was a temporary edit, restored, `git status` clean.

## Red on a50db87

| Finding | Test title (prefix) | Failing assertion on a50db87 |
|---|---|---|
| ADV-PV1R-1 | `ADV-PV1R-1 RACE ACH-M-I1-RACE (lock order, CMD043 close-agency vs bank issuance, both orders)` | `no deadlock (40P01 -> 503 CAPACITY_UNAVAILABLE) and no crash: close first: closure 200 SUCCESS -, issuance 503 CAPACITY_UNAVAILABLE -`. The api log shows `cause=DatabaseError code=40P01`. |
| ADV-PV1R-2 | `ADV-PV1R-2 DENY ACH-M-I2-EXPIRY (source availability deadline)` | `window - 1 ms before the source deadline: refused`: actual `201 SUCCESS -`, expected `409 PRECONDITION_FAILED TRANSFER_WINDOW_TOO_SHORT`. |
| ADV-PV1R-2 | `ADV-PV1R-2 DENY ACH-M-I2-EXPIRY (details validity)` | `details expired at the effect instant: nothing issued`: actual `201 SUCCESS -`, expected `409 PRECONDITION_FAILED DETAILS_EXPIRED`. |
| ADV-PV1R-2 | `ADV-PV1R-2 DENY ACH-M-I3-EXPIRY (details validity)` | `expired details are hidden`: actual `200 SUCCESS -`, expected `409 PRECONDITION_FAILED INSTRUCTIONS_NOT_AVAILABLE` (RR-2). |
| ADV-PV1R-2 | `DENY ACH-M-I2D-EXPIRY (transfer window)` (expectation change, see test-repairs r1) | `window - 1 ms: refused`: actual `201 SUCCESS -`, expected `409 PRECONDITION_FAILED TRANSFER_WINDOW_TOO_SHORT`. The deadline is now min(price expiry, source deadline). |
| ADV-PV1R-3 | `ADV-PV1R-3 DENY ACH-M-I3-REVOCATION (bank order state)` | `order CAPTURED: the held read is refused with no account digit (got 200 SUCCESS -)`. Expected exactly `409 PRECONDITION_FAILED INSTRUCTIONS_NOT_AVAILABLE` (RR-2). RECEIVED_REVIEW and EXPIRED are not reached. |
| ADV-PV1R-5 | `ADV-PV1R-5 DENY ACH-M-I3-REVOCATION (allowlist narrowed by re-enable)` (RR-3) | `a dropped agency gets the foreign-agency answer`: actual `200 SUCCESS -`, expected `404 NOT_FOUND -`. |
| ADV-PV1R-6 | `ADV-PV1R-6 DENY ACH-M-I3-REVOCATION (session)` (RR-4) | `the held read is refused like a read after the revocation`: actual `200 SUCCESS -`, expected `401 AUTHENTICATION_REQUIRED -`. |
| ADV-PV1R-10 | `ADV-PV1R-10 DENY ACH-M-I3-RETRY (authorize before the evidence read)` | `no store read for a caller whose membership was not established`: actual 4, expected 3. |
| ADV-PV1R-10 | `ADV-PV1R-10 DENY ACH-M-I1-RETRY (authorize before locking)` | `the non-member's issuance waited on the victim's quote row (then answered 404 NOT_FOUND NOT_A_MEMBER)`. |
| ADV-PV1R-10 | `ADV-PV1R-10 DENY RLS (tenant columns of a bank route)` | `participant: version owner ids and evidence refs are denied or NULL (got [{"a":"<owner uuid>","b":"<owner uuid>","c":"kyc-review-...","d":"<artifact ref>"}])`. |
| ADV-PV1R-11 | `ADV-PV1R-11 DENY ACH-M-R1-RETRY (integration class and provider bound at every evidence read)` | `a contract fake never replaces provider evidence`: actual `200 SUCCESS -`, expected `409 PRECONDITION_FAILED DETAILS_ACCOUNT_MISMATCH`. |

## Guards: green on a50db87, red on the named revert

| Finding | Test title (prefix) | Revert -> failing assertion (probed) |
|---|---|---|
| ADV-PV1R-4 | `ADV-PV1R-4 RACE ACH-M-R1-RACE (stale evidence naming the replacement's version)` | Remove `\|\| route.currentVersion !== seen.currentVersion` (route-config.ts:296) -> `evidence of version 1 never verifies version 2`: actual `200 SUCCESS -`. Probed. |
| ADV-PV1R-4 | `ADV-PV1R-4 DENY ACH-M-R1-PARTIAL (incomplete details at verify)` | Make verify's read `{ classify: false }` -> `unclassifiable evidence never qualifies`: actual `500 INTERNAL_ERROR -`. Probed. Hook: the store read of the version-2 artifact, immediately before the frozen classifier parses it. There is no seam after the account-number read. |
| ADV-PV1R-5 | `ADV-PV1R-5 DENY ACH-M-I2-REVOCATION (allowlist narrowed by re-enable)` | Red only with BOTH bindings removed: isParticipant `set_version` (bank-routes.ts:251) AND the tenant read policy `p.set_version = p_participants_version` (0046:271). Probed: red. With isParticipant alone reverted it stays green, because the route row is invisible to the dropped agency (0046:271). So the adversary's "isParticipant alone keeps every cell green" does not hold for this cell. |
| ADV-PV1R-5 | `DENY ACH-M-I1-REVOCATION` / `DENY ACH-M-I2-REVOCATION` (participant withdrawal now through re-enable) | Same two-binding revert. |
| ADV-PV1R-7 | `ADV-PV1R-7 DENY ACH-M-R1-EXPIRY (product effect clock, no step clock)` | effectInstant reads `transaction_timestamp()` (unit-of-work.ts:644) -> `the effect instant after the wait decides`: actual `200 SUCCESS -`. Probed. |
| ADV-PV1R-8 | `ADV-PV1R-8 OK ACH-03 (forced reference collision)` | `MAX_REFERENCE_DRAWS = 1` (instructions.ts:67) -> red, because the issuance no longer completes 201. Probed. |
| ADV-PV1R-8 | `ACH-02 DENY: ...` (expired order on an ENABLED route) | Remove the I3 deadline check (instructions.ts:243) -> `an expired order's details are hidden on an ENABLED route`: actual `200 SUCCESS -`. Probed. |
| ADV-PV1R-8 | `RACE ACH-M-I1-RACE`, `RACE ACH-M-I1-RETRY` (events = ISSUED_EVENTS = 2) | A duplicated or missing order event fails the exact count (not probed). |
| ADV-PV1R-8 | `ADV-PV1R-8 RACE ACH-M-R2-RACE (two configures of one account)` | Dropping the account-uniqueness guard gives 2 routes, or an unmapped 23505 gives 500 (not probed). |
| ADV-PV1R-1/-8 | `DENY ACH-M-I1-REVOCATION` (adds identity, target) and `DENY ACH-M-I2-REVOCATION` (adds identity, details replaced through the product) | Observed refusals: `403 NOT_AUTHORIZED IDENTITY_DISABLED`, `422 TARGET_STALE -`. Each withdrawal holds its own lock, and the issuance is observed waiting on it (mustWait). |

## Codes missing from the closed set (the builder adds them, with a design addendum)

- `INSTRUCTIONS_NOT_AVAILABLE` (RR-2): not in `COMMERCE_FAILURE_REASONS`.
- `DETAILS_EXPIRED` (RR-1): in the reason set, but not in the CMD028 outcome catalogue (`outcomes.ts`).

## Dissents accepted (RR-5), for Codex

- **ADV-PV1R-7: real-time cell instead of the harness change.** With a step clock, `kauro.effect_now()` returns the positioned instant plus (clock_timestamp() - transaction_timestamp()). That adds the transaction's real elapsed time, lock waits included. So calling the product SQL after `clock.onServer` would break every exact-boundary cell (I2D "= window"). The real-time cell measures the product SQL directly; it is red when effectInstant reads transaction_timestamp().
- **ADV-PV1R-1: no cells for CMD026 or provider CMD028.** Neither can form a cycle with bank issuance, in either order.
  - CMD026 takes the plan row and the approval's exclusive half, never the quote.
  - Provider CMD028 takes only shared halves, which never conflict with the bank issuance's shared halves.
  - A cycle needs a writer that holds an exclusive half across a quote lock. CMD043 is that writer, and it has its cell.
- **ADV-PV1R-8(4), GAP, unreachable:** I2-delta "route re-versioned with a different window". No command changes `minimumTransferWindowMs`: replaceDetails copies it from the previous version (route-config.ts:421). Only a raw write could produce the case.

## ADV-PV1R-5 note (RR-6)

The tenant read policy (0046:271) also checks the allowlist version (`p.set_version = p_participants_version`). The narrowing test goes red only when both checks are reverted: this one and isParticipant (bank-routes.ts:251). Probed.

## Not written (reported)

- ADV-PV1R-6 (I3 session): written after RR-4 (opt-in `sessions: true` in the KIT support files), red as above.
- ADV-PV1R-1 CMD026 vs issuance and provider CMD028 vs bank issuance. No cycle exists in either order. CMD026 takes the plan row and the approval's exclusive half, never the quote. The provider CMD028 takes only shared halves before its quote lock. The CMD026 withdrawal is covered as a withdrawal in I1-REVOCATION (r1 form).
- ADV-PV1R-8 (4): I2-delta "re-versioned route with a different window". No product command changes the window: replaceDetails copies `minimumTransferWindowMs` from the previous version (route-config.ts:421). Only a raw write can produce that case, so it stays GAP pending a design decision. Capability and source withdrawals are not written (global capability row; B07 retention fixture). They are GAP and go to the matrix.
