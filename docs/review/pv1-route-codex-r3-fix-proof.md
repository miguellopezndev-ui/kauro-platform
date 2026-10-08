# PV1 route: Codex r3 fix proof (PV1R-02, PV1R-07; template rule 16)

Findings: `docs/review/pv1-route-codex-r3.json` (901679b, as issued on f348af1). Cells: `apps/api/test/ach-route-cells.test.ts`, r3 section (7715324, 7f5c361).
Fix: b56e461 (store/port/service), 84befca (authority, route commands, issuance, I3, transport), c1e2e12 (rule 16), 7f5c361 (one hold per request).

## Root cause and design
Reordering awaits (r2) left the judgment outside the lock its writers take: the resume sampled its instant before its touch UPDATE waited
on the row (PV1R-02), and the effects judged the session in a transaction that a revocation did not conflict with (PV1R-07). Rule 16:
lock the session row FOR UPDATE (the lock revoke and touch conflict with), THEN read the clock in a separate statement, THEN judge
`revoked_at`/idle/absolute, THEN build or commit the effect while the lock is still held; the transport releases it after the effect.

Lock / clock order per path:
- Resume (every cookie authentication): `packages/persistence/src/web-sessions.ts:173` SELECT ... FOR UPDATE, `:177` `now()`, then the
  conditional touch UPDATE (an ended session is never renewed); COMMIT ends the lock (`resume` :204, `hold` :209 keeps it open).
- Route commands verify/enable/disable/replace-details: pre-commit check `packages/application/src/commerce/bank/route-config.ts:233`
  -> `judgedUnderHold` (`packages/application/src/api/authority.ts:44` hold, `:46` proof read + effect clock + judgments, `:47` session at
  `clock.nowMs()`), then COMMIT; released at `apps/api/src/payments/bank-route-routes.ts:111` after `run` returned.
- getBankRoute: view built, then `route-config.ts:498` judged under hold; released at `bank-route-routes.ts:155`.
- I1/I2 issuance: `packages/application/src/commerce/bank/instructions.ts:166` judgedUnderHold around effect clock + details/window
  checks, then COMMIT; released at `apps/api/src/server.ts:759` after `execute`.
- I3 read: `instructions.ts:342` hold, `:345` effect clock, judgments, `:351` session liveAt at the process clock, view built with no
  await; released at `bank-route-routes.ts:179`.

Deadlock check. Within a unit the session row is the LAST lock (access -> journal -> project -> subject -> route -> quote -> session); its
writers (revoke, touch) hold no other row. Pools nest app -> assurance in beforeCommit, and assurance -> app on the denial path: a denial is recorded through the app pool (runtime.ts, route-config.ts) while the session lock is held; that wait is bounded by the 5 s connection and statement timeouts and no effect escapes (the unit is rolled back before the denial is recorded). An assurance holder can therefore wait on the app pool, for at most those 5 s. A second
judgment of the same request reuses the held row (7f5c361) instead of self-waiting until the 5 s statement timeout; release resets it.
Every hold transaction runs with `SET LOCAL statement_timeout` 5000 ms and the pool's idle-in-transaction timeout.

## Red on f348af1 (cells 7715324, src at f348af1): 8 of 9 red
| Cell | Failing assertion |
|---|---|
| PV1R-02 DENY ACH-M-R2-EXPIRY (getBankRoute resume waits on the row across idle) | `idle: the resume released past the idle deadline refuses the request` actual '200 SUCCESS -' expected '401 AUTHENTICATION_REQUIRED -' |
| PV1R-02 DENY ACH-M-I3-EXPIRY (final I3 resume waits on the row) | `idle: the read released past the idle deadline is refused` 200 vs 401 |
| PV1R-07 DENY ACH-M-I3-REVOCATION (revocation during the effect-clock hold) | standing actual 'COMMITTED' expected 'WAITING' |
| PV1R-07 DENY ACH-M-R2-REVOCATION x4 (verify, enable, disable, replace-details) | `<cmd>: a session revoked before COMMIT refuses the effect` '200 SUCCESS -' vs 401 |
| PV1R-07 DENY ACH-M-I2-REVOCATION (issuance) | `a session revoked before COMMIT refuses the issuance` '201 SUCCESS -' vs 401 |
| PV1R-07 I3 revocation committed before the final lock | green (control: already refused on f348af1) |

Each cell has its live control (200 with the exact secrets / 201 issued) in the same test.

## Revert proofs (fix reverted in the working tree, rebuilt, restored with `git checkout -- <path>`)
- (b) store only (`#lockedResume` back to the f348af1 sample-then-UPDATE, no FOR UPDATE): 3 of 13 r3 cells red, PV1R-02 getBankRoute
  and I3 '200 SUCCESS -' vs '401 AUTHENTICATION_REQUIRED -', PV1R-07 effect hold 'COMMITTED' vs 'WAITING'.
- (c) transport no longer passes `authority` (bank-route-routes.ts x3, server.ts): 10 of 13 red: verify/enable/disable/replace-details
  '200 SUCCESS -' vs 401, issuance '201 SUCCESS -' vs 401, I3 `revoked: the held read is refused like the next request`. The I3 effect
  -hold cell fails there on harness position (FaultPointNotReached db.effect-read-1.after), not on its product assertion: its product red is
  (b) and f348af1 above.
- 7f5c361 one hold per request (request-authority.ts back to 84befca): `RULE16-SELF-WAIT` red, `one hold for two judgments of the same
  request` actual 2 expected 1.

## Green (Windows, after the fix)
ach-route-cells 103/103 (before 7f5c361) + RULE16-SELF-WAIT 1/1; API regression (b11-sessions, b11-public-routes, b11-stage1-seams,
response-contract, b10-family-templates) 69/69; arch, fixture-clock lint, matrix check green; typecheck green for every package except
apps/web (`@axe-core/playwright` missing from the local install; no web file touched).

## Caveat (ADV-5)
The lock is released before the response is serialized and written: the linearization point of an effect is the authority judgment under the
lock, not the bytes on the wire. A revocation that commits after the release is ordered after the effect, and the bytes of the already
judged response may still reach the client afterwards.

## r6 fixes (internal adversary r6, docs/review/pv1-route-adversary-r6.md; base 1d6c0d8)
Tests first: bd75a95 (3 cells, red on 1d6c0d8); fixes 9ca9b31; evidence da8d2c4. Cells in ach-route-cells.test.ts beside the r3 cells.
The revocationStanding helper now also recognises a revoke waiting on the new `SELECT ... FOR UPDATE` (it matched only the old UPDATE).

| Finding | Red on 1d6c0d8 (actual vs expected) | Revert proof (src fix reverted, one cell) |
|---|---|---|
| ADV-1a logout instant | `revoked_at (1791427942244) is read after the wait on the row, not before it (the clock stood at 1791427947273 when the row was released)`: revoked_at 5 s before the release instant, expected >= | store.revoke sample moved back before the FOR UPDATE: same assertion, `revoked_at (1791428378704) ... (1791428383720)` |
| ADV-1b idle during wait | `an expired session is ended, not revoked` actual 1791427952966 expected null | same revert: actual 1791428391137 expected null |
| ADV-2 CMD028 replay | `the replay of a revoked session is refused` actual '201 SUCCESS -' expected '401 AUTHENTICATION_REQUIRED -' | judgedUnderHold removed from the replay branch of runCommerceCommand: same assertion, actual '201 SUCCESS -' |

Fix: `SessionStore.revoke(secret, now: () => UtcInstant, reason)` locks the row FOR UPDATE, reads `now()` after the lock, then runs the
existing predicate (deadlines at that instant: past a deadline = ENDED, no REVOKED row, no ALLOW fact) and stamps revoked_at with that
instant. Logout (service.ts) and the replaced-session revoke on sign-in pass the clock, not a sampled instant. The replay branch of
runCommerceCommand takes `judgedUnderHold(envelope.authority, runtime.clock)` before returning the journaled body (held until the transport
releases, after COMMIT). The replaced-session revoke shares the store function (no separate cell). recordStepUp (sampled recordedAt, no deadline
predicate) is NOT changed: GAP, outside the packet.

ADV-3 (evidence). runtime-boundary.json: 349 inserted lines, 0 removed. The missing entries were taken from the failing test output (tables
of kauro_app/kauro_control/kauro_payment, column grants of bank_routes, bank_route_versions, bank_transfer_instructions, and the policies of
0045/0046) and each was checked against the GRANT / CREATE POLICY lines of 0045 (65, 346-385) and 0046 (223-309); merged in place preserving
the file order (a one-off merge over the diagnostic output, not a test). source-migrations.test.ts B07 test (red on 1d6c0d8, `B07 tables force
row-level security...`) now allows exactly `register_bank_payment_route` with `search_path=pg_catalog, pg_temp`, like migrations.test.ts:172,
and stays strict for everything else.
acceptance-touch: tools/acceptance-touch.mjs is not in this tree nor under C:/Projects/Kauro/tools; the pw-ledger copy cannot run here (no
docs/acceptance/ledger/inputs.json on pv1/route). By hand from the case maps: the diff touches B07 (source-migrations.test.ts is cited by
B07-case-map.md; the change is the allowlist only) and B06 (runtime-boundary.json and runtime-boundary.test.ts are cited by B06-case-map.md;
additions only), and the persistence/application source trees they share. The coordinator must run the tool.

Green (Windows): ach-route-cells 107/107 (104 + 3 r6 cells); b11-sessions + b11-stage1-seams + b11-public-routes 37/37; CMD027-034 and b09
payment 57/57 (replay path of the commerce commands); persistence runtime-boundary + source-migrations + migrations + bank-route-migrations
46/46. tsc clean for application, persistence, api.
