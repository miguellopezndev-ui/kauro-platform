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
writers (revoke, touch) hold no other row. Pools nest only app -> assurance (an assurance holder never waits on the app pool). A second
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
